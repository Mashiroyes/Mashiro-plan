# Desktop QQ Session Window Design

## Goal

Allow the desktop Plan robot to remove QQ restrictions only from 12:00 through 22:00 in the Asia/Shanghai time zone.

## Scope

- Applies only to the desktop `玩QQN分钟` command and its scheduled QQ-session worker.
- Does not change the Android QQ guard, QQ website blocking, cooldown calculation, or historical SQLite sessions.

## Rules

1. A request may start only at or after 12:00 and before 22:00 Shanghai time.
2. The requested play duration must end no later than 22:00 Shanghai time. A request that would cross 22:00 is rejected rather than shortened.
3. A worker re-checks the same authorization window before it removes the QQ client barrier, so a delayed task cannot release QQ after 22:00.
4. An already authorized session continues only until its stored `playEndsAt`; no new post-22:00 release is created.

## Implementation Boundary

- Extend the QQ session time helper with a Shanghai-time end-of-window calculation and a clear rejection message for requests at/after 22:00 or crossing that boundary.
- Use that helper in the plugin command handler before creating a session.
- Add a worker-side guard before authorization and cover both layers with focused boundary tests.

## Acceptance Evidence

- `12:00` accepts a duration that ends by `22:00`.
- `11:59:59`, `22:00`, and any request whose requested end is after `22:00` are rejected without creating or authorizing a session.
- A delayed worker invocation outside the window does not remove the QQ client barrier.
- Existing QQ-session tests and the focused worker test pass.
