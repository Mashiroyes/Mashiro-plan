# QQ Two-Hour Cooldown Design

## Goal

Keep the existing temporary QQ session feature, but require a fixed 120-minute cooldown after each successful session reaches its play deadline.

## Behavior

- `玩QQ N分钟` continues to accept play durations from 1 through 60 minutes under the existing daily time-window rules.
- New QQ sessions are rejected all day from Monday through Saturday in the `Asia/Shanghai` calendar.
- Sunday keeps the existing local-time window: a session may start at or after 12:00 only when its requested play deadline does not exceed 22:00.
- A newly activated session sets `cooldownEndsAt` to `playEndsAt + 120 minutes`.
- While a session is in cooldown, another QQ session cannot be created.
- When cooldown ends, QQ remains protected; the next valid `玩QQ N分钟` command restores and starts it.
- Existing database rows keep their stored `cooldownEndsAt`. No migration recalculates or extends an active historical session.
- Failed launches do not consume a cooldown, preserving the existing rollback behavior.

## Implementation

- Change the canonical `QQ_COOLDOWN_MINUTES` constant from 60 to 120.
- Extend the canonical start-eligibility check so only Sunday requests can pass the existing 12:00—22:00 boundary.
- Keep all scheduling, storage, worker, and temporary-launch code intact so every consumer uses the new constant automatically for new sessions.
- Update rejection and help text to state the Sunday-only rule and fixed 120-minute cooldown.
- Update model, storage, plugin, and PowerShell worker regression tests to prove the new-session calculation and the preservation of stored historical deadlines.

## Deployment and Verification

- Run all QQ JavaScript and PowerShell worker tests.
- Deploy through `install-qq-session.ps1` using the production SQLite database and runtime descriptor.
- Confirm repository and deployed copies have matching hashes.
- Run the installed status/reconciliation path and verify the worker remains healthy without changing any active session's stored deadline.
