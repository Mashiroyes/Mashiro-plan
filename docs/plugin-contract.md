# MashiroBot 插件契约

本文档定义本机可信 MashiroBot 插件的发现、清单、导出接口和冲突处理规则。核心只在 OpenClaw 网关启动时扫描插件；新增、删除或修改插件后必须重启网关，本系统不提供热加载。

## 目录与发现

插件位于 `plan/plugin` 的直接子目录中。核心只发现名称匹配 `mashirobot-plugin-*` 的文件夹，不递归扫描。每个插件至少包含：

```text
mashirobot-plugin-example/
├─ plugin.json
├─ index.mjs
└─ README.md
```

`README.md` 是插件完整用户与维护说明的正式位置。插件代码由本机用户手动放入目录并视为可信代码；加载器做结构和冲突校验，但不是安全沙箱，也不会从网络安装或更新插件。

## plugin.json

清单版本目前固定为 `1`：

```json
{
  "schemaVersion": 1,
  "id": "mashirobot-plugin-plan",
  "name": "计划",
  "version": "1.0.0",
  "description": "计划、记录、作息与提醒",
  "menuIndex": 1,
  "priority": 100,
  "enabled": true,
  "entry": "index.mjs",
  "exactCommands": ["/计划", "/计划详细"]
}
```

字段约束：

- `schemaVersion` 必须严格等于 `1`。
- `id`、`name`、`version`、`description` 必须为非空字符串；`id` 必须与目录名完全一致。
- `menuIndex` 必须为大于 `0` 的整数并在已启用插件中唯一。
- `priority` 必须为有限数值。优先级高者先匹配；相同优先级按插件 ID 稳定排序。
- `enabled` 必须为布尔值。值为 `false` 时不导入入口、不进入菜单或路由。
- `entry` 必须是插件目录内的相对文件路径，禁止绝对路径和路径穿越。
- `exactCommands` 必须是已去除首尾空格的非空字符串数组；插件内以及插件间不能重复。
- `help`、`/help`、`帮助` 是全局保留指令，插件不得声明。

## 入口导出

入口模块必须以同步函数形式导出以下接口：

```js
export function match(message, context) {}
export function handle(message, context) {}
export function healthCheck() {}
export function getHelp() {}
```

- `match(message, context)` 只判断自然语言是否匹配，不允许产生副作用。
- `handle(message, context)` 执行本地操作并返回标准结果。
- `healthCheck()` 检查插件脚本、数据库和系统入口。
- `getHelp()` 返回图片帮助所需的分组数据和文字降级内容。

入口模块不能使用 `async function` 导出上述接口。加载器在启动阶段一次性导入模块；每条微信消息不会重新扫描目录或动态导入插件。

## context

核心传入的上下文至少包含：

- `accountId`：当前微信账号 ID。
- `conversationId`：当前会话 ID。
- `now`：当前时间，日期语义采用 Asia/Shanghai。
- `planRoot`：`plan` 系统根目录。
- `sqlitePath`：正式 SQLite 数据库路径。
- `tempRoot`：MashiroBot 临时文件根目录。
- 受控的本地进程调用和日志接口。
- `renderPluginHelp(pluginId, { detailed })`：由核心拥有的帮助图片渲染能力。

插件不得自行保留全局菜单会话，也不应自行决定 OpenClaw 是否继续调用 GPT。

## 标准结果

`handle` 的返回值由 `normalizePluginResult(value, pluginId)` 规范化为：

```js
{
  handled: true,
  command: "本地命令名称",
  reply: "可选微信文字",
  mediaPaths: ["可选本地图片绝对路径"]
}
```

`handled` 必须严格为 `true`。`command` 缺省时使用插件 ID；`reply` 缺省为空字符串；`mediaPaths` 缺省为空数组。插件匹配后即使执行失败，也由核心返回本地错误并截断 GPT，不把同一条消息交给模型重试。

## 冲突与失败

加载器先按 `priority` 降序、再按插件 ID 排序。随后按此顺序启用插件：

- 菜单编号冲突时保留先到插件，后到插件整体不启用，记录 `DUPLICATE_MENU_INDEX`。
- 精确指令冲突时保留先到插件，后到插件整体不启用，记录 `DUPLICATE_EXACT_COMMAND`；不会只加载该插件的其他指令。
- 保留指令、目录/ID 不一致、入口越界、缺少 README、入口不可导入或导出接口不完整时，跳过对应插件并记录失败。
- 一个插件加载失败不阻止其他合法插件加载，也不会覆盖已经建立的编号或指令映射。
- 日志统一写入 `%USERPROFILE%\.openclaw\logs\mashirobot.log`，每行一个 UTF-8 JSON 对象并包含插件 ID。

加载结果结构为：

```js
{
  plugins: [],
  byMenuIndex: new Map(),
  byExactCommand: new Map(),
  failures: []
}
```

`plugins` 已按自然语言匹配优先级排列；两个映射只包含真正启用的插件；`failures` 保留结构化失败代码、插件 ID、目录和简短原因。
