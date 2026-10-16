import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const YAML_READER = String.raw`
import json, sys, yaml
value = yaml.safe_load(sys.stdin.read())
json.dump(value, sys.stdout, ensure_ascii=False)
`;

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
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    raw = JSON.parse(output);
  } catch (error) {
    throw new Error(`commands.yaml cannot be parsed: ${error.message}`);
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
