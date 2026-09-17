import fs from "node:fs";
import path from "node:path";

export function buildAuditTargets(games, qqExecutablePaths = []) {
  const targets = games.map((game) => ({
    key: game.key,
    displayName: game.displayName,
    kind: "game",
    executablePath: path.win32.normalize(game.executablePath),
  }));
  for (const executablePath of qqExecutablePaths ?? []) {
    targets.push({ key: "qq", displayName: "QQ", kind: "software", executablePath: path.win32.normalize(executablePath) });
  }
  const unique = new Map();
  for (const target of targets) unique.set(`${target.key}\0${target.executablePath.toLowerCase()}`, target);
  return [...unique.values()];
}

export function writeAuditTargetManifest(targetPath, targets) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), targets }, null, 2)}\n`, "utf8");
  fs.renameSync(temp, targetPath);
  return { path: targetPath, count: targets.length };
}
