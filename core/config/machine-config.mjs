import fs from "node:fs";
import path from "node:path";

export function machineConfigPath(env = process.env) {
  const base = env.LOCALAPPDATA;
  if (!base) throw new Error("LOCALAPPDATA is unavailable; cannot locate MashiroBot machine configuration");
  return path.join(base, "MashiroBot", "config", "machine.json");
}

export function readMachineConfig({ env = process.env, configPath, exists = fs.existsSync, readFile = fs.readFileSync } = {}) {
  const target = configPath ?? machineConfigPath(env);
  if (!exists(target)) throw new Error(`MashiroBot machine configuration is missing: ${target}. Run core/config/initialize-machine-config.ps1.`);
  let value;
  try { value = JSON.parse(readFile(target, "utf8")); }
  catch (error) { throw new Error(`MashiroBot machine configuration is invalid JSON: ${target}: ${error.message}`); }
  if (value?.schemaVersion !== 1) throw new Error(`Unsupported MashiroBot machine configuration schemaVersion in ${target}`);
  if (value.gameExecutableOverrides != null && (typeof value.gameExecutableOverrides !== "object" || Array.isArray(value.gameExecutableOverrides))) {
    throw new Error(`gameExecutableOverrides must be an object in ${target}`);
  }
  return Object.freeze({
    schemaVersion: 1,
    openClawCommand: String(value.openClawCommand ?? "").trim(),
    weixinAccount: String(value.weixinAccount ?? "").trim(),
    weixinTarget: String(value.weixinTarget ?? "").trim(),
    cloudMusicPath: String(value.cloudMusicPath ?? "").trim(),
    gameExecutableOverrides: Object.freeze({ ...(value.gameExecutableOverrides ?? {}) }),
  });
}

export function applyGameExecutableOverrides(games, config) {
  const overrides = config?.gameExecutableOverrides ?? {};
  return games.map((game) => {
    const override = String(overrides[game.key] ?? "").trim();
    return override ? { ...game, executablePath: path.win32.normalize(override) } : game;
  });
}
