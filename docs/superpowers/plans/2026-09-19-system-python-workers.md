# System Python Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every production MashiroBot Python invocation use the system `python.exe` resolved through `PATH`.

**Architecture:** Node worker launchers use the literal command `python`; PowerShell workers and installers resolve it once with `Get-Command python.exe`. Health checks validate that same command and Pillow rather than testing a user-directory executable.

**Tech Stack:** Node.js ESM, PowerShell 7, Python/Pillow, Windows Task Scheduler

## Global Constraints

- Do not use `OPENCLAW_PYTHON_PATH`, `MASHIROBOT_PYTHON`, `context.pythonExecutable`, or `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe` in production code.
- Do not alter Python business behavior, SQLite schema, OpenClaw configuration, database files, or temperature-monitoring scope.
- Preserve the user-owned QQ worker modification.

---

### Task 1: Unify production Python resolution

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/bridge/planner-runner.mjs`
- Modify: `plugin/mashirobot-plugin-plan/health.mjs`
- Modify: `plugin/mashirobot-plugin-plan/windows/reminder-common.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/english-skills-worker.ps1`
- Modify: `plugin/mashirobot-plugin-plan/windows/install-english-skills.ps1`
- Modify: `core/health/check-mashirobot.ps1`
- Modify: `plugin/mashirobot-plugin-status/index.mjs`

**Interfaces:**
- Consumes: system `python.exe` discoverable with `Get-Command` or `PATH`
- Produces: worker process launches whose executable is `python`/the current `Get-Command python.exe` result

- [ ] **Step 1: Add failing source-policy assertions**

Extend a PowerShell regression test to reject the two environment variables, the old `pythoncore-3.14-64` path, and production Python executable injection in the listed files.

- [ ] **Step 2: Run the focused policy test**

Run the new PowerShell test and verify it fails against the old source references.

- [ ] **Step 3: Replace every production resolver**

Use `python` in Node launchers. In PowerShell, initialize `$python = (Get-Command python.exe -ErrorAction Stop).Source` and use it for SQLite integrity checks, planner calls, and scheduled worker execution.

- [ ] **Step 4: Make health checks test the system command**

Have PowerShell health checks resolve `python.exe` from `PATH`, run `--version`, and verify `from PIL import Image`; remove file-existence checks for a fixed executable path.

- [ ] **Step 5: Run focused tests**

Run Node plan/plugin health tests, the plan Python unittest suite, and PowerShell Windows action tests using system `python`.

### Task 2: Update tests, runtime deployment, and documentation

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/tests/test_chart.py`
- Modify: `plugin/mashirobot-plugin-plan/tests/test_windows_actions.ps1`
- Modify: `plugin/mashirobot-plugin-plan/README.md`
- Modify: `docs/new-computer-setup.md`

**Interfaces:**
- Consumes: Task 1 system-Python policy
- Produces: tests and migration documentation that require only `python` on `PATH` plus Pillow

- [ ] **Step 1: Replace test-only fixed Python paths**

Resolve `python.exe` from `PATH` in PowerShell tests and use `shutil.which('python')` in Python tests; fail clearly if the command is unavailable.

- [ ] **Step 2: Remove obsolete migration guidance**

Delete environment-variable and old-directory setup instructions; document `python --version` and `python -c "from PIL import Image"` as the required checks.

- [ ] **Step 3: Reinstall the English Skills runtime**

Run `install-english-skills.ps1 -Action Install` with the formal SQLite path, then inspect deployed runtime source and task state to prove it uses system Python.

- [ ] **Step 4: Run full verification and commit**

Run `git diff --check`, source-policy scan, focused Node/PowerShell/Python tests, then commit and push only intended files.
