# 系统 Python 统一设计

## 目标

让所有 MashiroBot 正式 Python 调用统一使用 Windows `PATH` 中的 `python.exe`，不依赖用户目录、环境变量或调用方注入的绝对路径。

## 规则

- Node.js worker/渲染器启动 Python 时固定使用 `python`。
- PowerShell worker、安装器和健康检查通过 `Get-Command python.exe` 获取系统解释器。
- 删除 `OPENCLAW_PYTHON_PATH`、`MASHIROBOT_PYTHON`、`context.pythonExecutable` 和 `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe` 的生产回退逻辑。
- 测试使用系统 `python`，不绑定开发电脑的用户目录。
- 换机指南只要求 Python 已加入 `PATH` 且已安装 Pillow。

## 边界

- 不安装、迁移或配置温度监控组件。
- 不改动 Python 业务逻辑、数据库结构或 OpenClaw 配置。
- 不提交数据库、账号凭据或运行时状态。

## 验证

- 源码中的正式 worker 不再引用旧路径和两个 Python 环境变量。
- 系统 Python 可导入 Pillow，健康检查和计划插件测试通过。
- 已部署的 English Skills runtime worker 使用系统 Python。
