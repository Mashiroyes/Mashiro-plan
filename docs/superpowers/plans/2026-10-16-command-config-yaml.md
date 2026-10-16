# Plan Command Configuration YAML Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all user-facing Plan robot command names, aliases, templates, and help labels into `plan/commands.yaml`, loaded and validated once when the gateway runtime starts.

**Architecture:** A small command-config loader reads YAML through the existing Python runtime, validates a versioned command registry, freezes it, and passes it through the MashiroBot context. Plugins consume configured aliases/prefixes while retaining internal command kinds, argument validation, permissions, and side effects in code. Help rendering reads the same registry so displayed examples stay synchronized.

**Tech Stack:** Node.js ESM, PowerShell gateway startup, Python 3 + PyYAML already required by Plan runtime, Node test runner.

## Global Constraints

- Configuration file: `plan/commands.yaml`.
- Gateway reads configuration once per process start; edits require a gateway restart.
- Configuration controls user-facing text only; internal IDs, parser semantics, permissions, database fields, and worker actions remain code-owned.
- Invalid YAML or schema fails startup with a precise error.
- Existing command behavior remains the default represented by the checked-in YAML.

### Task 1: Command configuration loader and checked-in registry

**Files:**
- Create: `plan/core/config/command-config.mjs`
- Create: `plan/commands.yaml`
- Test: `plan/tests/command-config.test.mjs`

- [ ] Add failing tests for YAML loading, schema validation, frozen output, and useful invalid-config errors.
- [ ] Implement `loadCommandConfig(planRoot, options)` using the configured Python executable and stdin-safe YAML parsing; require `version: 1`, non-empty command IDs, and unique user-facing names.
- [ ] Implement lookup helpers for aliases, prefixes, and help metadata.
- [ ] Populate YAML with every current user-facing command entry from core and all active plugins.
- [ ] Run `node --test plan/tests/command-config.test.mjs` and require PASS.

### Task 2: Load once at runtime startup and expose through context

**Files:**
- Modify: `plan/core/runtime/mashirobot-runtime.mjs`
- Modify: `plan/core/bridge/context.mjs`
- Test: `plan/tests/runtime-lifecycle.test.mjs`

- [ ] Load and validate `commands.yaml` before plugin lifecycle registration.
- [ ] Pass the frozen registry to lifecycle hooks, plugin match/handle contexts, and help rendering.
- [ ] Add a startup test proving the loader runs once and invalid config prevents runtime creation.

### Task 3: Migrate plugin command matching and help metadata

**Files:**
- Modify: `plan/core/contracts/reserved-commands.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/index.mjs`
- Modify: `plan/plugin/mashirobot-plugin-plan/routes/*.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/index.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/core/parser.mjs`
- Modify: `plan/plugin/mashirobot-plugin-game-timer/core/qq-session-parser.mjs`
- Modify: `plan/plugin/mashirobot-plugin-language/index.mjs`
- Modify: `plan/plugin/mashirobot-plugin-status/index.mjs`
- Modify: `plan/plugin/mashirobot-plugin-loot/core/parser.mjs`
- Test: existing plugin parser and route tests

- [ ] Replace hard-coded user-facing aliases/prefixes with config lookups, preserving default behavior from YAML.
- [ ] Keep regex numeric/date/argument semantics in code and expose only their names/templates in YAML.
- [ ] Make scoped help aliases and core aliases derive from the registry without moving internal routing logic into YAML.
- [ ] Update help text generation to use configured names and usage strings.
- [ ] Run focused plugin tests and fix only regressions caused by this migration.

### Task 4: Gateway/startup verification and documentation

**Files:**
- Modify: `plan/core/adapter/start-openclaw-gateway.ps1`
- Modify: `plan/README.md`
- Test: `plan/tests/test-runtime-resolution.ps1` or focused startup test

- [ ] Ensure the normal gateway startup path passes the Plan root so the same YAML is loaded.
- [ ] Document editing `commands.yaml`, restart semantics, supported fields, and configuration failure behavior.
- [ ] Run the focused Node and PowerShell verification commands and report any machine-level deployment gap separately.
