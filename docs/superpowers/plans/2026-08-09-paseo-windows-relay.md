# Paseo Windows Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure Paseo on Windows so Codex can be controlled from a phone over mobile data without repeatedly opening CMD windows.

**Architecture:** Paseo listens only on `127.0.0.1:6867` and makes an outbound encrypted relay connection. It reuses the installed Codex CLI and existing local authentication. A per-user scheduled task starts Paseo hidden at Windows logon after pairing and end-to-end verification.

**Tech Stack:** Windows PowerShell 7, Paseo CLI 0.3.0, Codex CLI 0.146.0, Windows Task Scheduler

## Global Constraints

- Keep the daemon bound to localhost; do not open Windows Firewall ports or configure router port forwarding.
- Never print, copy, or export Codex authentication files or Paseo pairing secrets.
- Stop only processes whose command line is confirmed to belong to Paseo.
- Preserve a timestamped backup of the original Paseo configuration.
- Treat the pairing QR code/link as a password and display it only in a local interactive window.

---

## Task 1: Repair the crashing daemon configuration

**Files:**
- Modify: `C:\Users\Mashiroyes\.paseo\config.json`
- Create: `C:\Users\Mashiroyes\.paseo\config.backup-<timestamp>.json`

- [ ] Re-check that port 6767 is in a Windows excluded range and that port 6867 is free.
- [ ] Enumerate Paseo-related processes and stop only a confirmed crash-loop process.
- [ ] Back up the current configuration.
- [ ] Change `daemon.listen` from `127.0.0.1:6767` to `127.0.0.1:6867`.
- [ ] Change `daemon.relay.enabled` from `false` to `true`.
- [ ] Parse the edited JSON to verify it remains valid.

## Task 2: Start Paseo and prove the crash loop is gone

- [ ] Inspect the installed CLI help for the exact daemon start/status syntax.
- [ ] Start Paseo hidden with relay enabled.
- [ ] Poll daemon status and confirm a listener exists only on `127.0.0.1:6867`.
- [ ] Inspect fresh log output and confirm there are no new worker-crash or `EACCES` entries.
- [ ] Re-check after a short stability interval to ensure the daemon stays alive.

## Task 3: Verify the Codex integration

- [ ] Confirm the installed Codex CLI version and login status without reading credential files.
- [ ] Run a minimal Paseo-to-Codex prompt in the workspace.
- [ ] Require the exact response `PASEO_CODEX_OK` as proof of the full local path.

## Task 4: Pair the phone securely

- [ ] Open `paseo daemon pair --relay` in a visible local PowerShell window.
- [ ] Have the user scan the QR code or open the pairing link on the phone.
- [ ] Confirm the phone appears as paired without copying the pairing link into chat or files.

## Task 5: Install hidden per-user auto-start

**Files:**
- Create: `C:\Users\Mashiroyes\.paseo\start-daemon.ps1`

- [ ] Create a small launcher that uses explicit Paseo and Node paths.
- [ ] Register a current-user logon task named `Paseo Daemon`, hidden, with restart-on-failure and single-instance behavior.
- [ ] Stop the temporary daemon, trigger the scheduled task, and verify the daemon returns on port 6867.
- [ ] Confirm no CMD window appears during scheduled startup.

## Task 6: Verify use away from home

- [ ] On the phone, disable Wi-Fi and use cellular data.
- [ ] Send a minimal Codex request and confirm the response returns through Paseo.
- [ ] Record the final working state and the paths of the backup, launcher, and task.
