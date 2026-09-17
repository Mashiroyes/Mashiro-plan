import path from "node:path";
import fs from "node:fs";

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${field} must be a non-empty string`);
  return text;
}

export function loadGameConfig(raw) {
  if (!raw || !Array.isArray(raw.games)) {
    throw new TypeError("game config must contain a games array");
  }

  return raw.games.map((item) => {
    const key = requiredText(item?.key, "key");
    const displayName = requiredText(item?.displayName, "displayName");
    const processName = requiredText(item?.processName, "processName");
    const executablePath = requiredText(item?.executablePath, "executablePath");
    if (!path.win32.isAbsolute(executablePath)) {
      throw new TypeError(`executablePath must be an absolute Windows path: ${executablePath}`);
    }
    if (path.win32.basename(executablePath).toLowerCase() !== processName.toLowerCase()) {
      throw new TypeError("processName must match the executablePath file name");
    }
    const aliases = Array.isArray(item.aliases)
      ? item.aliases.map((value) => requiredText(value, "alias"))
      : [];
    return Object.freeze({
      key,
      displayName,
      aliases: Object.freeze([...new Set(aliases)]),
      processName,
      executablePath: path.win32.normalize(executablePath),
      steamId: item.steamId == null ? null : String(item.steamId),
    });
  });
}

export function findConfiguredGame(name, configs) {
  const needle = String(name ?? "").trim().toLocaleLowerCase("zh-CN");
  return configs.find((game) =>
    [game.displayName, ...game.aliases]
      .some((candidate) => candidate.toLocaleLowerCase("zh-CN") === needle),
  ) ?? null;
}

export function inferGameName(executablePath) {
  const folder = path.win32.basename(path.win32.dirname(executablePath));
  return folder.split("-", 1)[0].trim() || path.win32.basename(executablePath, ".exe");
}

export function addGameToConfig(configPath, executablePath) {
  const resolved = path.win32.normalize(String(executablePath).trim());
  if (!path.win32.isAbsolute(resolved)) throw new TypeError("游戏路径必须是绝对路径");
  if (path.win32.extname(resolved).toLowerCase() !== ".exe") throw new TypeError("游戏路径必须指向 .exe 文件");
  if (!fs.existsSync(resolved)) throw new Error(`游戏文件不存在：${resolved}`);

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const item of raw.games ?? []) delete item.priority;
  const configs = loadGameConfig(raw);
  const key = resolved.toLowerCase();
  const existing = configs.find((game) => game.executablePath.toLowerCase() === key);
  if (existing) return { config: raw, game: existing, created: false };

  const displayName = inferGameName(resolved);
  const processName = path.win32.basename(resolved);
  const game = {
    key: `${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "game"}-${Date.now()}`,
    displayName,
    aliases: [],
    processName,
    executablePath: resolved,
    steamId: null,
  };
  raw.games.push(game);
  const temp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  fs.renameSync(temp, configPath);
  return { config: raw, game: loadGameConfig(raw).at(-1), created: true };
}

export function removeGamesFromConfig(configPath, keys) {
  const wanted = new Set(keys.map(String));
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const before = loadGameConfig(raw);
  const removed = before.filter((game) => wanted.has(game.key));
  raw.games = (raw.games ?? []).filter((game) => !wanted.has(String(game.key)));
  for (const item of raw.games) delete item.priority;
  loadGameConfig(raw);
  const temp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  fs.renameSync(temp, configPath);
  return removed;
}
