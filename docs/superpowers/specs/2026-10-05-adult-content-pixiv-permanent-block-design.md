# 成人内容与 Pixiv 永久拦截设计

## 目标

在当前 Windows 电脑上永久拦截 `pixiv.net`、其静态资源域名、MissAV 及成人内容类别网站；同时压缩浏览器安全 DNS、Clash、常见代理/VPN 与手工改 DNS 等绕过路径。现有 Bilibili、QQ 等 FocusLock 规则必须保持不变。

“永久”表示规则没有日常临时解除入口，并由计划任务持续修复。拥有本机管理员权限的人最终仍能删除系统规则或重装系统，因此不能声称达到不可逆的绝对禁止。

## 方案选择

采用三层组合，而不是只改 hosts 或只换 DNS：

1. **类别过滤层**：为 Windows 当前网络适配器设置成人内容过滤 DNS，并禁用 Chrome/Edge 的自定义安全 DNS，覆盖未事先枚举的成人站点。
2. **明确域名层**：将 Pixiv、Pixiv 图片资源、MissAV 及已知镜像加入 FocusLock 的 hosts、Chrome/Edge URLBlocklist 与 Clash `REJECT` 规则，避免单一 DNS 或代理路径绕过。
3. **持续修复层**：扩展现有 FocusLock 安装、重应用、扫描和状态检查；计划任务发现 DNS、浏览器策略、hosts 或 Clash 规则被修改后恢复。

不采用“仅 hosts”方案，因为代理和浏览器安全 DNS可以绕过；不采用“只阻止浏览器进程”方案，因为会破坏正常网页访问且不能覆盖其他客户端。

## 组件边界

- `FocusLock.ps1` 继续作为唯一规则生成器，新增永久成人内容域名集合、DNS/浏览器策略维护与状态输出。
- 新增一个静态配置文件保存明确域名和需要阻止的常见代理/VPN 程序名，便于审计，避免把大列表散落在脚本逻辑中。
- hosts 只放明确域名；类别识别交给过滤 DNS，不尝试把公共成人域名列表全部塞进 hosts。
- Clash 的永久 `REJECT` 规则必须写入基础配置、检查配置和实际活动 profile，并在修改后重载 Mihomo。
- 只限制已安装或明确识别的代理/VPN客户端，不删除程序或用户文件；Clash 保留运行，因为它同时承担现有网络与拦截职责。

## 恢复与安全

- 安装前备份 hosts、相关注册表策略、DNS 设置、FocusLock 状态和 Clash 配置。
- 不创建临时解锁脚本，不修改现有 Bilibili/QQ 的独立授权逻辑。
- 恢复只能通过管理员执行的维护模式完成；该模式恢复本次新增的 DNS与策略，不碰无关网络配置。
- 变更失败时保持旧版 FocusLock 可用，不留下半写入的 hosts 或 YAML 文件。

## 验证标准

1. FocusLock 静态测试通过，原有 Bilibili/QQ 测试不回归。
2. hosts、Chrome/Edge URLBlocklist、过滤 DNS 与活动 Clash profile 均包含预期规则。
3. 直接请求与经本机 Clash 代理请求访问 Pixiv、Pixiv 图片域名和 MissAV 均失败。
4. 一个正常网站通过直接与代理路径均可访问，证明不是全网断开。
5. 手工移除一条测试规则后，修复任务能够恢复；任务最后运行结果为成功。

