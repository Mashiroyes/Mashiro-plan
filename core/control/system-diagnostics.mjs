import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectDatabase } from "./database-health.mjs";
import { openControlDatabase } from "./database.mjs";

function entry(name, status, detail, repair = null) { return { name, status, detail, repair }; }
function command(file, args) { const r = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 8000 }); return { ok: r.status === 0, text: String(r.stdout || r.stderr || "").trim().slice(0, 160) }; }

export function runSystemDiagnostics({ sqlitePath, planRoot, env = process.env, jobInspection = null } = {}) {
  const rows = [];
  try { const h = inspectDatabase(sqlitePath, { backupRoot: path.join(path.dirname(sqlitePath), "backups", "control") }); rows.push(entry("SQLite", h.ok && h.latestBackup ? "ok" : "failed", `完整性 ${h.integrity}，最近备份 ${h.latestBackup ?? "无"}`, h.ok && h.latestBackup ? null : "运行数据库备份恢复流程")); } catch { rows.push(entry("SQLite", "failed", "数据库无法读取", "先停止写入并从最近备份恢复")); }
  const gateway = process.platform === "win32" ? command("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "& openclaw gateway health --timeout 5000"]) : command("openclaw", ["gateway", "health", "--timeout", "5000"]); rows.push(entry("微信网关", gateway.ok ? "ok" : "failed", gateway.ok ? "健康检查通过" : "健康检查失败", gateway.ok ? null : "运行网关恢复脚本"));
  if (process.platform === "win32") {
    const tasks = command("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$t=@(Get-ScheduledTask -TaskName 'MashiroBot*','OpenClaw*' -ErrorAction SilentlyContinue);$t.Count"]); rows.push(entry("计划任务", tasks.ok ? "ok" : "unknown", tasks.ok ? `可读取，数量 ${tasks.text}` : "未核验", "以当前用户重新运行统一安装器"));
    const hosts = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts"); let hostsWritable=false; try{fs.accessSync(hosts,fs.constants.R_OK|fs.constants.W_OK);hostsWritable=true;}catch{} rows.push(entry("Hosts 写权限", hostsWritable ? "ok" : "failed", hostsWritable ? "当前进程可读写" : "当前进程不可写", hostsWritable ? null : "以管理员身份运行禁止名单同步"));
    const policies = command("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Item 'Registry::HKEY_CURRENT_USER\\Software\\Policies' -ErrorAction Stop|Out-Null"]); rows.push(entry("浏览器 Policy", policies.ok ? "ok" : "unknown", policies.ok ? "策略根可读取" : "策略根未核验", "检查当前用户注册表 Policy 权限"));
    rows.push(entry("Clash 配置", fs.existsSync(path.join(env.USERPROFILE ?? "", ".config", "mihomo")) ? "ok" : "unknown", "仅检查配置目录", "确认 Clash 配置目录和控制端口"));
  } else rows.push(entry("Windows 控制层", "unknown", "当前不是 Windows", "在部署电脑运行自检"));
  try {
    const db = openControlDatabase(sqlitePath); const conflicts = db.prepare("SELECT COUNT(*) count FROM operation_journal WHERE state IN ('conflict','failed')").get().count;
    let protectedExecutables = 0; try { protectedExecutables = db.prepare("SELECT COUNT(*) count FROM game_executable_vault WHERE state IN ('pending','preparing','quarantined','restore_conflict','failed')").get().count; } catch {}
    const recoveryCount = Number(conflicts) + Number(protectedExecutables); rows.push(entry("待恢复 EXE/保护目录", recoveryCount ? "failed" : "ok", recoveryCount ? `${recoveryCount} 项待恢复或冲突` : "没有保护目录残留或恢复冲突", recoveryCount ? "发送“恢复所有游戏文件”" : null)); db.close();
  } catch { rows.push(entry("待恢复 EXE/保护目录", "unknown", "未核验", "先修复 SQLite")); }
  if (jobInspection) { const count = (jobInspection.missing?.length ?? 0) + (jobInspection.orphaned?.length ?? 0) + (jobInspection.failed?.length ?? 0); rows.push(entry("孤儿任务", count ? "failed" : "ok", count ? `缺失 ${jobInspection.missing.length}，孤儿 ${jobInspection.orphaned.length}，失败 ${jobInspection.failed.length}` : "登记与 Windows 任务一致", count ? "运行任务协调修复" : null)); }
  else rows.push(entry("孤儿任务", "unknown", "未核验", "运行计划任务只读协调检查"));
  return rows;
}

export function formatDiagnostics(rows) { return rows.map((x) => `${x.status === "ok" ? "正常" : x.status === "failed" ? "异常" : "未核验"}｜${x.name}：${x.detail}${x.repair && x.status !== "ok" ? `；处理：${x.repair}` : ""}`).join("\n"); }
