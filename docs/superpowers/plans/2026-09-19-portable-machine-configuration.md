# Portable Machine Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Plan project installable from any Windows checkout path with one local machine configuration and no old-machine path or WeChat identifiers in production source.

**Architecture:** A PowerShell initializer installs a shared configuration helper and `%LOCALAPPDATA%\MashiroBot\config\machine.json`. PowerShell workers resolve delivery and software settings through that helper, while Node.js loads the same JSON through a small core module. The OpenClaw adapter is generated at repair time from the current checkout instead of importing a fixed source URI.

**Tech Stack:** PowerShell 7, Node.js ES modules, JSON, Windows Task Scheduler, Node test runner, Pester-free PowerShell assertion scripts.

## Global Constraints

- Windows 11 x64 only.
- Real machine configuration stays outside Git at `%LOCALAPPDATA%\MashiroBot\config\machine.json`.
- Resolution order is explicit parameter, machine configuration, safe discovery, then a specific actionable error.
- OpenClaw credentials remain under `%USERPROFILE%\.openclaw` and never enter Git.
- The SQLite database remains outside Git under `sqlite\openclaw-planner.sqlite`.
- Temperature monitoring is not migrated or installed.
- Preserve the user's unrelated modification to `plugin/mashirobot-plugin-game-timer/qq/powershell/qq-session-worker-v1.ps1`.

---

### Task 1: Shared machine configuration

**Files:**
- Create: `core/config/MashiroBot.MachineConfig.ps1`
- Create: `core/config/machine-config.mjs`
- Create: `core/config/machine.example.json`
- Create: `core/config/initialize-machine-config.ps1`
- Create: `tests/machine-config.test.mjs`
- Create: `tests/test-machine-config.ps1`

**Interfaces:**
- Produces PowerShell functions `Get-MashiroMachineConfigPath`, `Read-MashiroMachineConfig`, `Resolve-MashiroOpenClawCommand`, and `Resolve-MashiroWeixinDelivery`.
- Produces Node functions `machineConfigPath(env)`, `readMachineConfig({ env, exists, readFile })`, and `applyGameExecutableOverrides(games, config)`.

- [ ] **Step 1: Write failing Node and PowerShell tests**

Test missing, malformed, and valid schema version 1 files; verify explicit delivery values override discovered values and game overrides change only `executablePath`.

- [ ] **Step 2: Run tests and verify missing modules fail**

```powershell
node --test .\tests\machine-config.test.mjs
pwsh -NoProfile -File .\tests\test-machine-config.ps1
```

- [ ] **Step 3: Implement shared readers and initializer**

The initializer accepts `-OpenClawCommand`, `-WeixinAccount`, `-WeixinTarget`, and `-CloudMusicPath`; it discovers omitted safe values, writes via a temporary file plus `Move-Item`, and installs the PowerShell helper beside `machine.json`.

- [ ] **Step 4: Run focused tests**

```powershell
node --test .\tests\machine-config.test.mjs
pwsh -NoProfile -File .\tests\test-machine-config.ps1
```

- [ ] **Step 5: Commit**

```powershell
git add core/config tests/machine-config.test.mjs tests/test-machine-config.ps1
git commit -m "feat: add portable machine configuration"
```

### Task 2: Generate the OpenClaw adapter from the current checkout

**Files:**
- Modify: `core/adapter/fast-routine.adapter.js`
- Modify: `core/adapter/repair-openclaw-adapter.ps1`
- Modify: `core/adapter/tests/test_adapter_repair.ps1`
- Modify: `core/health/check-mashirobot.ps1`

**Interfaces:**
- `repair-openclaw-adapter.ps1` generates an adapter string from `(Resolve-Path core/index.mjs).Path` converted through `[Uri]`.
- Health output adds `installed-adapter-current-root` with installed URI evidence.

- [ ] **Step 1: Extend the repair test with a temporary checkout path containing spaces and Chinese characters**

Assert the generated adapter references that fixture's `core/index.mjs` URI and contains no `D:/BaiduSyncdisk` literal.

- [ ] **Step 2: Run the repair test and verify failure**

```powershell
pwsh -NoProfile -File .\core\adapter\tests\test_adapter_repair.ps1
```

- [ ] **Step 3: Replace the static adapter source with generated content and add the health assertion**

Keep `fast-routine.adapter.js` as a path-free template or remove its fixed export body from production use. The repair command must validate the generated source file URI before modifying the installed package.

- [ ] **Step 4: Run the repair and health tests**

```powershell
pwsh -NoProfile -File .\core\adapter\tests\test_adapter_repair.ps1
pwsh -NoProfile -File .\core\health\check-mashirobot.ps1
```

- [ ] **Step 5: Commit**

```powershell
git add core/adapter core/health/check-mashirobot.ps1
git commit -m "fix: generate adapter for current checkout"
```

### Task 3: Move PowerShell workers to shared delivery configuration

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/windows/reminder-common.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/wakeup-common.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/routine-reminder.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/english-skills-worker.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/install-english-skills.ps1`
- Modify: `plugin/mashirobot-plugin-loot/windows/loot-worker.ps1`
- Modify: `plugin/mashirobot-plugin-loot/windows/install.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/powershell/game-timer-worker-v1.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/powershell/install-game-timer.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/game-locker/powershell/game-locker-worker-v1.ps1`
- Modify: `plugin/mashirobot-plugin-game-timer/game-locker/powershell/install-game-locker.ps1`
- Modify: `plugin/mashirobot-plugin-financial-report/windows/common.ps1`
- Modify: `plugin/mashirobot-plugin-financial-report/windows/install-financial-report.ps1`
- Test: existing worker and installer tests plus `tests/test-machine-path-policy.ps1`

**Interfaces:**
- Workers dot-source `%LOCALAPPDATA%\MashiroBot\config\MashiroBot.MachineConfig.ps1` and call `Resolve-MashiroWeixinDelivery`.
- Installers fail with the initializer command when the helper or required delivery fields are absent.

- [ ] **Step 1: Add a static failing policy test**

Reject production references to `D:\Program\nodejs\npm_global24`, the old account ID, the old target ID, `C:\Users\Mashiroyes`, and `D:\BaiduSyncdisk\Study\AI\codex\codex-study`.

- [ ] **Step 2: Run the policy test and verify current failures**

```powershell
pwsh -NoProfile -File .\tests\test-machine-path-policy.ps1
```

- [ ] **Step 3: Update workers and runtime-copy installers**

Pass `-MachineConfigPath` only for test overrides. Production defaults use the standard local path. Copy the shared helper into runtime packages when isolation is required, while preserving the standard configuration file as the single data source.

- [ ] **Step 4: Run worker, installer, and policy tests**

```powershell
pwsh -NoProfile -File .\tests\test-machine-path-policy.ps1
pwsh -NoProfile -File .\plugin\mashirobot-plugin-plan\tests\test_english_skills_windows.ps1
node --test .\plugin\mashirobot-plugin-loot\tests\*.test.mjs
pwsh -NoProfile -File .\plugin\mashirobot-plugin-financial-report\tests\test-installer.ps1
```

- [ ] **Step 5: Commit**

```powershell
git add plugin tests/test-machine-path-policy.ps1
git commit -m "refactor: use shared machine delivery config"
```

### Task 4: Apply machine-specific software and game paths

**Files:**
- Modify: `plugin/mashirobot-plugin-game-timer/core/game-config.mjs`
- Modify: `plugin/mashirobot-plugin-plan/windows/routine-reminder.ps1`
- Modify: `core/config/initialize-machine-config.ps1`
- Modify: `tests/machine-config.test.mjs`
- Modify: game timer route/config tests

**Interfaces:**
- `loadGameConfig({ machineConfig })` merges `gameExecutableOverrides` by game key without changing other fields.
- `Resolve-MashiroCloudMusicPath` returns a verified file or `$null`; playback actions turn `$null` into one feature-specific error.

- [ ] **Step 1: Write failing tests for game and CloudMusic resolution**

Cover an override, an unknown game key, an absent optional executable, and an explicit nonexistent path.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
node --test .\tests\machine-config.test.mjs .\plugin\mashirobot-plugin-game-timer\tests\*.test.mjs
pwsh -NoProfile -File .\tests\test-machine-config.ps1
```

- [ ] **Step 3: Implement merging and optional discovery**

Unknown override keys remain unused and are reported by initialization/health output. An unavailable CloudMusic path must not stop unrelated reminder commands.

- [ ] **Step 4: Run focused tests**

Use the commands from Step 2 and require zero new failures.

- [ ] **Step 5: Commit**

```powershell
git add core/config plugin/mashirobot-plugin-game-timer plugin/mashirobot-plugin-plan/windows/routine-reminder.ps1 tests
git commit -m "feat: configure machine-specific software paths"
```

### Task 5: Unified migration validation and documentation

**Files:**
- Create: `core/config/install-new-computer.ps1`
- Modify: `core/health/check-mashirobot.ps1`
- Modify: `docs/new-computer-setup.md`
- Modify: `README.md`
- Modify: `tests/health-contract.test.mjs`
- Modify: `tests/test-machine-path-policy.ps1`

**Interfaces:**
- `install-new-computer.ps1` accepts database and delivery overrides, initializes config, performs preflight, and invokes selected existing installers without installing temperature monitoring.
- Health JSON identifies each configuration failure independently.

- [ ] **Step 1: Extend health and policy tests**

Assert schema, OpenClaw, delivery, adapter root, database, task actions, optional paths, and absence of temperature-monitor installation.

- [ ] **Step 2: Run tests and verify new checks fail**

```powershell
node --test .\tests\health-contract.test.mjs
pwsh -NoProfile -File .\tests\test-machine-path-policy.ps1
```

- [ ] **Step 3: Implement the installer and rewrite migration order**

Document exact OpenClaw files, database checkpoint/copy, initializer command, install command, Gateway restart, health check, and real WeChat commands. State that runtime/state folders are rebuilt and temperature monitoring is excluded.

- [ ] **Step 4: Perform completion verification**

```powershell
node --test .\tests\*.test.mjs .\plugin\mashirobot-plugin-*\tests\*.test.mjs
pwsh -NoProfile -File .\tests\test-machine-config.ps1
pwsh -NoProfile -File .\tests\test-machine-path-policy.ps1
pwsh -NoProfile -File .\core\adapter\tests\test_adapter_repair.ps1
pwsh -NoProfile -File .\core\health\check-mashirobot.ps1
git diff --check
```

Run a source scan over production files and inspect every remaining absolute path. Deploy locally, restart Gateway, verify `openclaw gateway health`, inspect scheduled-task actions, and dry-run English skills plus one message worker.

- [ ] **Step 5: Commit and push**

```powershell
git add core/config core/health docs README.md tests
git commit -m "docs: complete portable new-computer setup"
git push origin main
```
