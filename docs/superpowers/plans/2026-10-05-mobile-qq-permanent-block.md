# Mobile QQ Permanent Block Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently block QQ/TIM on the rooted Android phone while preserving installed apps and data.

**Architecture:** Add a fail-closed permanent policy to the pure model, root controller, and user-facing command layer. Preserve the existing Android package enforcement, hosts mount, APK scanner, supervisor, boot entry, and uninstall recovery path; deploy only from the saved `mobile/qq-guard` source archive.

**Tech Stack:** Python 3.11 standard library, Android Root `pm`/`am`, Termux, shell, ADB

## Global Constraints

- Do not uninstall QQ/TIM or delete their app data.
- Never enable or launch QQ from any play command.
- Keep website blocking, APK cleanup, multi-user/variant enforcement, supervisor, and boot persistence.
- Do not copy phone source back over the project backup.

---

### Task 1: Fail-closed model and controller

**Files:**
- Modify: `mobile/qq-guard/model.py`
- Modify: `mobile/qq-guard/guard.py`
- Modify: `mobile/qq-guard/tests/test_guard.py`

**Interfaces:**
- Consumes: `begin(state, clock, minutes)`, `reconcile(state, clock)`, and `Controller.play(minutes)`.
- Produces: permanent rejection, state normalization, and immediate Android blocking.

- [ ] Add tests proving every positive play duration is rejected, legacy playing/cooldown states normalize to blocked-ready, and controller rejection blocks a manually enabled QQ without launching it.
- [ ] Run the focused tests and verify they fail against the current temporary-release behavior.
- [ ] Add the permanent policy/message, normalize state during reconciliation, and make the root controller block before rejecting play.
- [ ] Run the full desktop test suite and require all tests to pass.

### Task 2: User contract, documentation, and reproducible package

**Files:**
- Modify: `mobile/qq-guard/cli.py`
- Modify: `mobile/qq-guard/README.md`
- Modify: `mobile/qq-guard/DESIGN.md`
- Modify: `mobile/qq-guard/VALIDATION.md`
- Modify: `mobile/README.md`
- Regenerate: `mobile/plan-mobile-qq-guard.zip`
- Regenerate: `mobile/plan-mobile-qq-guard.zip.sha256`

**Interfaces:**
- Consumes: the permanent-block model and existing `package.py` manifest.
- Produces: accurate command/help/status text plus a deterministic transfer archive.

- [ ] Replace play-window/cooldown claims with permanent-block behavior while retaining query, doctor, start, recover, and uninstall instructions.
- [ ] Run `python -B package.py` and independently verify the SHA-256 checksum and archive members.

### Task 3: Connected-phone deployment and acceptance

**Files:**
- Transfer: archive, deploy/upgrade scripts, phone tests, and verifier under `mobile/`.
- Runtime target: `/data/local/plan-qq-guard`.

**Interfaces:**
- Consumes: the rebuilt archive and the connected ADB device `a12eab1c`.
- Produces: protected root runtime, healthy supervisor, and permanent QQ disablement.

- [ ] Record pre-upgrade package presence/disabled state, daemon health, and existing state phase without copying source files back.
- [ ] Push the archive and fixed deployment scripts, then run the existing upgrade flow through Termux and Root.
- [ ] Run phone-side unit tests and `qq-phone doctor`.
- [ ] Invoke `玩QQ1分钟`; require a nonzero exit and permanent-block message.
- [ ] Verify QQ remains installed but disabled, no QQ process is running, website blocking is healthy, supervisor/daemon are alive, and the boot entry remains installed.
