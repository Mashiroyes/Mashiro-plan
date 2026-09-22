import fs from "node:fs";
import path from "node:path";

function readText(file) {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; }
}

function gitIdentity(root) {
  const gitEntry = path.join(root, ".git");
  let gitDirectory = gitEntry;
  try {
    const stat = fs.statSync(gitEntry);
    if (stat.isFile()) {
      const match = /^gitdir:\s*(.+)$/imu.exec(readText(gitEntry) ?? "");
      if (!match) return null;
      gitDirectory = path.resolve(root, match[1]);
    }
  } catch { return null; }
  const head = readText(path.join(gitDirectory, "HEAD"));
  if (!head) return null;
  if (!head.startsWith("ref: ")) return head.slice(0, 40);
  const ref = head.slice(5).trim();
  return (readText(path.join(gitDirectory, ...ref.split("/"))) ?? readText(path.join(gitDirectory, "packed-refs"))?.split(/\r?\n/u).find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? null)?.slice(0, 40) ?? null;
}

export function collectDeploymentIdentity({ planRoot, sqlitePath, env = process.env, startedAt = new Date().toISOString() } = {}) {
  const sourceRoot = path.resolve(planRoot);
  const runtimeRoot = path.resolve(env.MASHIROBOT_RUNTIME_ROOT ?? path.join(env.LOCALAPPDATA ?? sourceRoot, "MashiroBot"));
  return Object.freeze({
    sourceRoot,
    runtimeRoot,
    databasePath: path.resolve(sqlitePath),
    machineConfigPath: path.join(env.LOCALAPPDATA ?? sourceRoot, "MashiroBot", "config", "machine.json"),
    sourceCommit: gitIdentity(sourceRoot) ?? "unknown",
    runtimeCommit: readText(path.join(runtimeRoot, "runtime-commit.txt")) ?? "unknown",
    runtimeVersion: readText(path.join(runtimeRoot, "runtime-version.txt")) ?? "unknown",
    startedAt,
  });
}
