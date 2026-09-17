const SOFTWARES = [
  {
    key: "qq",
    displayName: "QQ",
    aliases: ["qq", "QQ", "腾讯QQ"],
    processNames: ["QQ.exe", "QQNT.exe", "TencentQQ.exe", "QQLauncher.exe", "QQScLauncher.exe", "QQProtect.exe", "TIM.exe"],
    installerPatterns: ["QQ*.exe", "QQ*.msi", "QQNT*.exe", "TIM*.exe", "TIM*.msi"],
    watchedDirs: ["Downloads", "Desktop"],
    downloadDomains: ["im.qq.com", "pc.qq.com", "dldir.qq.com", "dldir1.qq.com", "dldir1v6.qq.com", "download.imqq.com"],
  },
  {
    key: "bilibili",
    displayName: "Bilibili",
    aliases: ["bilibili", "Bilibili", "哔哩哔哩", "B站"],
    processNames: [],
    installerPatterns: ["哔哩哔哩*.exe", "Bilibili*.exe"],
    watchedDirs: ["Downloads", "Desktop"],
    downloadDomains: ["bilibili.com", "bilivideo.com", "hdslb.com", "b23.tv"],
  },
];

export function listSoftware() { return SOFTWARES.map((item) => structuredClone(item)); }

export function findSoftware(value) {
  const target = String(value ?? "").trim().toLocaleLowerCase("zh-CN");
  return SOFTWARES.find((item) => item.aliases.some((alias) => alias.toLocaleLowerCase("zh-CN") === target)) ?? null;
}

export function softwareByKey(key) { return SOFTWARES.find((item) => item.key === key) ?? null; }
