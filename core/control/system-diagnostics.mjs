import fs from "node:fs";
import path from "node:path";
import { inspectDatabase } from "./database-health.mjs";
import { openControlDatabase } from "./database.mjs";
import { runLocalProcess } from "../execution/local-process.mjs";
import { collectDeploymentIdentity } from "../health/deployment-identity.mjs";

function entry(name, status, detail, repair = null) { return { name, status, detail, repair }; }
async function command(file, args, runner) {
  try {
    const result = await runner({
      executable: file,
      args,
      timeoutMs: 8_000,
      output: "text",
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    return { ok: true, text: String(result.stdout || result.value || "").trim().slice(0, 160) };
  } catch (error) {
    return { ok: false, text: String(error?.stderr || error?.message || "").trim().slice(0, 160) };
  }
}

export async function runSystemDiagnostics({ sqlitePath, planRoot, env = process.env, jobInspection = null, runner = runLocalProcess, runtimeStatus = null } = {}) {
  const rows = [];
  const identity = collectDeploymentIdentity({ planRoot, sqlitePath, env, startedAt: runtimeStatus?.startedAt });
  rows.push(entry("运行状态", runtimeStatus?.status === "failed" ? "failed" : runtimeStatus?.status === "ready" ? "ok" : "unknown", runtimeStatus?.status ?? "unknown"));
  const deploymentMatches = identity.sourceCommit === "unknown" || identity.runtimeCommit === "unknown" || identity.sourceCommit === identity.runtimeCommit;
  rows.push(entry("部署身份", deploymentMatches ? "ok" : "failed", `源码 ${identity.sourceCommit}，运行副本 ${identity.runtimeCommit}，数据库 ${identity.databasePath}`, deploymentMatches ? null : "运行正式部署同步程序"));
  try { const h = inspectDatabase(sqlitePath, { backupRoot: path.join(path.dirname(sqlitePath), "backups", "control") }); rows.push(entry("SQLite", h.ok && h.latestBackup ? "ok" : "failed", `完整性 ${h.integrity}，最近备份 ${h.latestBackup ?? "无"}`, h.ok && h.latestBackup ? null : "运行数据库备份恢复流程")); } catch { rows.push(entry("SQLite", "failed", "数据库无法读取", "先停止写入并从最近备份恢复")); }
  const gateway = process.platform === "win32"
    ? await command(process.env.MASHIROBOT_PWSH || "pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "& openclaw gateway health --timeout 5000"], runner)
    : await command("openclaw", ["gateway", "health", "--timeout", "5000"], runner);
  rows.push(entry("微信网关", gateway.ok ? "ok" : "failed", gateway.ok ? "健康检查通过" : "健康检查失败", gateway.ok ? null : "运行网关恢复脚本"));
  if (process.platform === "win32") {
    const tasks = await command(process.env.MASHIROBOT_PWSH || "pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$t=@(Get-ScheduledTask -TaskName 'MashiroBot*','OpenClaw*' -ErrorAction SilentlyContinue);$t.Count"], runner); rows.push(entry("计划任务", tasks.ok ? "ok" : "unknown", tasks.ok ? `可读取，数量 ${tasks.text}` : "未核验", "以当前用户重新运行统一安装器"));
    const hosts = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts"); let hostsWritable=false; try{fs.accessSync(hosts,fs.constants.R_OK|fs.constants.W_OK);hostsWritable=true;}catch{} rows.push(entry("Hosts 写权限", hostsWritable ? "ok" : "failed", hostsWritable ? "当前进程可读写" : "当前进程不可写", hostsWritable ? null : "以管理员身份运行禁止名单同步"));
    const policies = await command(process.env.MASHIROBOT_PWSH || "pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Item 'Registry::HKEY_CURRENT_USER\\Software\\Policies' -ErrorAction Stop|Out-Null"], runner); rows.push(entry("浏览器 Policy", policies.ok ? "ok" : "unknown", policies.ok ? "策略根可读取" : "策略根未核验", "检查当前用户注册表 Policy 权限"));
    rows.push(entry("Clash 配置", fs.existsSync(path.join(env.USERPROFILE ?? "", ".config", "mihomo")) ? "ok" : "unknown", "仅检查配置目录", "确认 Clash 配置目录和控制端口"));
  } else rows.push(entry("Windows 控制层", "unknown", "当前不是 Windows", "在部署电脑运行自检"));
  try {
    const db = openControlDatabase(sqlitePath); const conflicts = db.prepare("SELECT COUNT(*) count FROM operation_journal WHERE state IN ('conflict','failed')").get().count;
    let protectedExecutables = 0; try { protectedExecutables = db.prepare("SELECT COUNT(*) count FROM game_executable_vault WHERE state IN ('pending','preparing','quarantined','restore_conflict','failed')").get().count; } catch {}
    const recoveryCount = Number(conflicts) + Number(protectedExecutables); rows.push(entry("待恢复 EXE/保护目录", recoveryCount ? "failed" : "ok", recoveryCount ? `${recoveryCount} 项待恢复或冲突` : "没有保护目录残留或恢复冲突", recoveryCount ? "发送“恢复所有游戏文件”" : null)); db.close();
  } catch { rows.push(entry("待恢复 EXE/保护目录", "unknown", "未核验", "先修复 SQLite")); }
  if (jobInspection) { const count = (jobInspection.missing?.length ?? 0) + (jobInspection.drifted?.length ?? 0) + (jobInspection.orphaned?.length ?? 0) + (jobInspection.failed?.length ?? 0); rows.push(entry("计划任务一致性", count ? "failed" : "ok", count ? `缺失 ${jobInspection.missing?.length ?? 0}，动作漂移 ${jobInspection.drifted?.length ?? 0}，孤儿 ${jobInspection.orphaned?.length ?? 0}，失败 ${jobInspection.failed?.length ?? 0}` : "登记、动作路径与 Windows 任务一致", count ? "运行任务协调修复" : null)); }
  else rows.push(entry("计划任务一致性", "unknown", "未核验", "运行计划任务只读协调检查"));
  return rows;
}

export function formatDiagnostics(rows) { return rows.map((x) => `${x.status === "ok" ? "正常" : x.status === "failed" ? "异常" : "未核验"}｜${x.name}：${x.detail}${x.repair && x.status !== "ok" ? `；处理：${x.repair}` : ""}`).join("\n"); }
