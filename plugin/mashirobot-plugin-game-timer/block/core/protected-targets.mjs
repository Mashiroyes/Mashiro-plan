const PROTECTED_SOFTWARE_KEYS = new Set(["mashirobot", "openclaw", "wechat", "weixin", "pwsh", "powershell", "python", "node", "clash"]);
const PROTECTED_DOMAIN_SUFFIXES = ["localhost", "localhost.localdomain"];
const BROAD_LABELS = new Set(["com", "net", "org", "cn", "io", "app"]);

export function classifyBlockRisk(command) {
  if (command.kind !== "upsert") return { decision: "direct", impact: "" };
  const target = String(command.targetKey ?? "").toLowerCase();
  if (command.ruleKind === "software" && PROTECTED_SOFTWARE_KEYS.has(target)) {
    return { decision: "reject", impact: "该目标属于 MashiroBot、微信投递或本机恢复链路，不能加入禁止名单。" };
  }
  if (command.ruleKind === "website" && (PROTECTED_DOMAIN_SUFFIXES.includes(target) || target.endsWith(".localhost"))) {
    return { decision: "reject", impact: "本地管理地址和回环链路不能加入禁止名单。" };
  }
  const labels = target.split(".");
  const broad = command.ruleKind === "website" && (labels.length < 2 || BROAD_LABELS.has(target));
  if (classifyRisk({ permanent: command.permanent, broad, externalSideEffect: true, reversible: !command.permanent && !broad }) === RISK_LEVELS.HIGH) {
    const layers = command.ruleKind === "software" ? "程序启动、安装包和下载域名" : "Hosts、浏览器策略和 Clash";
    return { decision: "confirm", impact: `${command.displayName} 将被${command.permanent ? "永久" : "广泛"}限制，影响 ${layers}。` };
  }
  return { decision: "direct", impact: "" };
}
import { classifyRisk, RISK_LEVELS } from "../../../../core/control/risk-policy.mjs";
