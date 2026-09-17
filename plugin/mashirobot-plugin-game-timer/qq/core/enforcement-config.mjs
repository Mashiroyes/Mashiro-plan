export const qqDomains = Object.freeze([
  "im.qq.com",
  "pc.qq.com",
  "dldir.qq.com",
  "dldir1.qq.com",
  "dldir1v6.qq.com",
  "download.imqq.com",
]);

export const qqBrowserPatterns = Object.freeze([
  "*://im.qq.com/*",
  "*://*.im.qq.com/*",
  "*://pc.qq.com/*",
  "*://dldir.qq.com/*",
  "*://*.dldir.qq.com/*",
  "*://dldir1.qq.com/*",
  "*://dldir1v6.qq.com/*",
  "*://download.imqq.com/*",
]);

export const qqClashRules = Object.freeze(qqDomains.map((domain) => `DOMAIN,${domain},REJECT`));

export const qqClientImages = Object.freeze([
  "QQ.exe",
  "QQNT.exe",
  "TencentQQ.exe",
  "QQLauncher.exe",
  "QQScLauncher.exe",
  "QQProtect.exe",
  "TIM.exe",
]);

export const qqSetupImages = Object.freeze(["QQSetup.exe", "QQInstaller.exe"]);
