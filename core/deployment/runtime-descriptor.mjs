import fs from "node:fs";
import path from "node:path";

export function runtimeDescriptorPath(env = process.env) {
  const base = env.LOCALAPPDATA;
  if (!base) throw new Error("LOCALAPPDATA is unavailable; cannot locate MashiroBot runtime descriptor");
  return path.join(base, "MashiroBot", "config", "runtime.json");
}

function requireAbsolute(value, key, source) {
  const normalized = String(value ?? "").trim();
  if (!path.isAbsolute(normalized)) throw new Error(`${key} must be absolute in ${source}`);
  return path.normalize(normalized);
}

export function readRuntimeDescriptor({
  env = process.env,
  descriptorPath,
  exists = fs.existsSync,
  readFile = fs.readFileSync,
} = {}) {
  const target = descriptorPath ?? runtimeDescriptorPath(env);
  if (!exists(target)) throw new Error(`MashiroBot runtime descriptor is missing: ${target}. Run core/deployment/resolve-runtime.ps1.`);
  let value;
  try { value = JSON.parse(readFile(target, "utf8")); }
  catch (error) { throw new Error(`MashiroBot runtime descriptor is invalid JSON: ${target}: ${error.message}`); }
  if (value?.schemaVersion !== 1) throw new Error(`Unsupported runtime descriptor schemaVersion in ${target}`);
  const descriptor = {
    ...value,
    schemaVersion: 1,
    planRoot: requireAbsolute(value.planRoot, "planRoot", target),
    sqlitePath: requireAbsolute(value.sqlitePath, "sqlitePath", target),
    pwshPath: requireAbsolute(value.pwshPath, "pwshPath", target),
    nodePath: requireAbsolute(value.nodePath, "nodePath", target),
    pythonPath: requireAbsolute(value.pythonPath, "pythonPath", target),
    openClawCommand: requireAbsolute(value.openClawCommand, "openClawCommand", target),
    openClawPackageRoot: requireAbsolute(value.openClawPackageRoot, "openClawPackageRoot", target),
    interactiveUser: String(value.interactiveUser ?? "").trim(),
    openClawPackageVersion: String(value.openClawPackageVersion ?? "").trim(),
    openClawLayoutId: String(value.openClawLayoutId ?? "").trim(),
  };
  if (!descriptor.interactiveUser) throw new Error(`interactiveUser is required in ${target}`);
  return Object.freeze(descriptor);
}
