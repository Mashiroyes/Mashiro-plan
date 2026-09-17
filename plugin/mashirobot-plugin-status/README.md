# 状态插件

微信指令：

```text
状态
硬件信息
```

`状态` 返回 Windows 状态图片、硬件温度图片，并额外返回文字运行时间。温度图片沿用状态图的浅紫至浅蓝背景，显示处理器、显卡核心、磁盘和主板温度。采集使用 LiteMonitor 同类的 LibreHardwareMonitor/PawnIO 读取链路，并通过 `MashiroBot Temperature Monitor` 高权限计划任务执行，避免 Gateway 每次触发 UAC；磁盘温度只采用 Composite/实际温度传感器，排除 Warning/Critical 阈值传感器。当前设备没有返回某项传感器时显示“未检测到”。状态图片包含 2.5 倍尺寸的圆形 MashiroBot 头像、CPU、RAM、带卷标的固定磁盘、百度与 Google 的 HTTP 连通性和按内存降序排列的前 8 个应用进程；同一应用的全部子进程会合并为一个条目，内存与 CPU 分别汇总。进程内存采用 Windows 任务管理器默认的“活动专用工作集”口径，不使用会重复计算共享页的总工作集。不包含 SWAP、网卡流量明细和 Windows `Memory Compression` 伪进程。Google 固定通过 `http://127.0.0.1:7897` 发起 4 秒超时、无缓存的 HEAD 请求到 Google favicon，成功时显示 `200 OK`；图片显示该完整 HTTP 请求的实际耗时，不读取 Clash 控制器或节点延迟。磁盘名称来自 Windows 卷标，显示为 `盘符 卷标`，没有卷标时只显示盘符。

`硬件信息` 使用与状态图一致的浅紫至浅蓝背景，紧凑显示系统、处理器频率/电压/核心/线程、七彩虹主板型号、显卡 CUDA 核心/显存/频率/驱动、内存频率、物理磁盘和 HKC 显示器；CPU 频率使用 Windows 性能百分比连续 12 次采样（约 3 秒）换算的实时有效 Boost 峰值，性能计数器不可用时才回退到 Windows 报告的基准频率。G27H7Pro [惠科 HKC2723] 按 2560×1440、144Hz、27.2 英寸显示。硬盘同时显示标称容量（如 1TB）与 Windows 读取的“总容量”（如 932GB）。不显示主板/内存第二行详情、声卡或网卡信息。

采集使用 PowerShell 7 和 Windows CIM，渲染使用系统 Python/Pillow。`状态` 只采集状态图所需数据，超时为 30 秒；`硬件信息` 执行完整硬件枚举，超时为 45 秒。网络测试失败只显示失败，不影响其他状态数据。图片写入 `%TEMP%\MashiroBot\status`，由 OpenClaw 发送副本。

测试：

```powershell
node --test plan/plugin/mashirobot-plugin-status/tests/*.test.mjs
pwsh.exe -NoProfile -File plan/plugin/mashirobot-plugin-status/tests/test-renderer.ps1
node --test plan/tests/*.test.mjs
```
