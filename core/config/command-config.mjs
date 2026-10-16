import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const YAML_READER = String.raw`
import json, sys, yaml
value = yaml.safe_load(sys.stdin.read())
json.dump(value, sys.stdout, ensure_ascii=False)
`;

function splitInline(value) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) { current += char; escaped = false; continue; }
    if (quote === '"' && char === "\\") { current += char; escaped = true; continue; }
    if ((char === '"' || char === "'") && (!quote || quote === char)) { quote = quote ? null : char; current += char; continue; }
    if (char === "," && !quote) { parts.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function scalar(value) {
  const text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) return splitInline(text.slice(1, -1)).map(scalar);
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/gu, "'");
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  return text;
}

function parseYamlSubset(source) {
  const lines = source.split(/\r?\n/u).map((raw, line) => {
    const withoutComment = raw.replace(/\s+#.*$/u, "");
    return { line: line + 1, indent: withoutComment.match(/^\s*/u)[0].length, text: withoutComment.trim() };
  }).filter((entry) => entry.text && !entry.text.startsWith("#"));
  function block(start, indent) {
    const sequence = lines[start]?.indent === indent && lines[start].text.startsWith("-");
    const result = sequence ? [] : {};
    let index = start;
    while (index < lines.length && lines[index].indent === indent) {
      const entry = lines[index];
      if (sequence) {
        if (!entry.text.startsWith("-")) break;
        const content = entry.text.slice(1).trim();
        if (!content) {
          const child = block(index + 1, lines[index + 1]?.indent ?? indent + 2);
          result.push(child.value); index = child.index; continue;
        }
        const match = /^(\S[^:]*):(?:\s*(.*))?$/u.exec(content);
        if (!match) { result.push(scalar(content)); index++; continue; }
        const object = {};
        object[match[1].trim()] = match[2] ? scalar(match[2]) : block(index + 1, lines[index + 1]?.indent ?? indent + 2).value;
        index++;
        while (index < lines.length && lines[index].indent > indent) {
          const child = lines[index];
          const keyMatch = /^(\S[^:]*):(?:\s*(.*))?$/u.exec(child.text);
          if (!keyMatch) throw new Error(`commands.yaml: unsupported syntax near line ${child.line}`);
          if (child.indent !== indent + 2) throw new Error(`commands.yaml: invalid indentation near line ${child.line}`);
          if (keyMatch[2]) { object[keyMatch[1].trim()] = scalar(keyMatch[2]); index++; }
          else { const nested = block(index + 1, lines[index + 1]?.indent ?? child.indent + 2); object[keyMatch[1].trim()] = nested.value; index = nested.index; }
        }
        result.push(object);
      } else {
        const match = /^(\S[^:]*):(?:\s*(.*))?$/u.exec(entry.text);
        if (!match) throw new Error(`commands.yaml: unsupported syntax near line ${entry.line}`);
        const key = match[1].trim();
        if (match[2]) { result[key] = scalar(match[2]); index++; }
        else { const nested = block(index + 1, lines[index + 1]?.indent ?? indent + 2); result[key] = nested.value; index = nested.index; }
      }
    }
    return { value: result, index };
  }
  return block(0, lines[0]?.indent ?? 0).value;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function list(value, field, id) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`commands.yaml: ${id}.${field} must be a non-empty string array`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function validate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("commands.yaml: root must be a mapping");
  if (raw.version !== 1) throw new Error("commands.yaml: version must be 1");
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) throw new Error("commands.yaml: commands must be a non-empty list");
  const commands = [];
  const byId = new Map();
  const aliasOwners = new Map();
  for (const [index, item] of raw.commands.entries()) {
    const id = String(item?.id ?? "").trim();
    const plugin = String(item?.plugin ?? "").trim();
    if (!id || !plugin) throw new Error(`commands.yaml: commands[${index}] requires id and plugin`);
    if (byId.has(id)) throw new Error(`commands.yaml: duplicate command id ${id}`);
    const names = list(item.names ?? [], "names", id);
    const detailedNames = item.detailed_names === undefined ? [] : list(item.detailed_names, "detailed_names", id);
    const aliases = [...new Set([...names, ...detailedNames])];
    for (const alias of aliases) {
      const owner = aliasOwners.get(alias);
      if (owner && owner !== id) throw new Error(`commands.yaml: command ${alias} is used by ${owner} and ${id}`);
      aliasOwners.set(alias, id);
    }
    const prefixes = item.prefixes === undefined ? [] : list(item.prefixes, "prefixes", id);
    const normalized = {
      id, plugin, names, detailedNames, prefixes,
      usage: typeof item.usage === "string" ? item.usage : "",
      description: typeof item.description === "string" ? item.description : "",
      group: typeof item.group === "string" ? item.group : "",
      help: item.help !== false,
      arguments: item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments) ? item.arguments : {},
    };
    byId.set(id, normalized);
    commands.push(normalized);
  }
  return { version: 1, commandStart: Array.isArray(raw.command_start) ? [...raw.command_start] : ["/"], commands, byId, aliasOwners };
}

export function loadCommandConfig(planRoot, { pythonPath = process.env.MASHIROBOT_PYTHON || "python" } = {}) {
  const filePath = path.join(path.resolve(planRoot), "commands.yaml");
  if (!fs.existsSync(filePath)) throw new Error(`command configuration is missing: ${filePath}`);
  const source = fs.readFileSync(filePath, "utf8");
  let raw;
  try {
    const output = execFileSync(pythonPath, ["-c", YAML_READER], {
      input: source,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    raw = JSON.parse(output);
  } catch (error) {
    try {
      raw = parseYamlSubset(source);
    } catch (fallbackError) {
      throw new Error(`commands.yaml cannot be parsed: ${error.message}; fallback parser: ${fallbackError.message}`);
    }
  }
  const config = validate(raw);
  const result = {
    version: config.version,
    commandStart: config.commandStart,
    commands: config.commands,
    get(id) { return config.byId.get(String(id)) ?? null; },
    names(id) { return config.byId.get(String(id))?.names ?? []; },
    detailedNames(id) { return config.byId.get(String(id))?.detailedNames ?? []; },
    prefixes(id) { return config.byId.get(String(id))?.prefixes ?? []; },
    normalize(text) {
      let value = String(text ?? "").trim();
      for (const command of config.commands) {
        const aliases = [...command.names, ...command.detailedNames];
        const canonical = command.names[0];
        if (command.detailedNames.includes(value)) return value;
        if (canonical && aliases.includes(value)) return canonical;
        for (const prefix of command.prefixes) {
          if (value === prefix || value.startsWith(`${prefix} `) || value.startsWith(`${prefix}\n`)) {
            const canonicalPrefix = command.names[0] ?? prefix;
            return canonicalPrefix + value.slice(prefix.length);
          }
        }
      }
      return value;
    },
  };
  return freeze(result);
}

export function commandConfigPath(planRoot) { return path.join(path.resolve(planRoot), "commands.yaml"); }
