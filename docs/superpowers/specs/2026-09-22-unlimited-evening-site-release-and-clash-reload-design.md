# Unlimited Evening Site Release and Clash Reload Recovery Design

## Scope

Change only the MashiroBot block plugin's website-release quota and Clash synchronization behavior.

- Keep the morning website quota at 20 minutes.
- Keep the afternoon website quota at 30 minutes.
- Remove the evening website quota ceiling. Requests starting in the evening may use any positive duration accepted by the existing command parser.
- Preserve per-website accounting, overlap deduplication, cross-period splitting, and full-request rejection for insufficient bounded periods.
- Do not change QQ session limits, game timers, or unrelated focus-lock behavior.

## Quota Model

Represent the evening period as unbounded instead of assigning it a large synthetic minute limit. Quota evaluation must continue reporting bounded morning and afternoon periods normally while treating evening usage as always sufficient. Cross-period requests must still fail when their morning or afternoon portion exceeds the relevant quota, even if the evening portion is unbounded.

User-facing help and quota output must describe evening as unlimited rather than showing a numeric remainder.

## Clash Reload Recovery

The worker continues to update the persistent active rule-provider file and generated Clash configuration before attempting reload.

Reload order:

1. Try the authenticated HTTP controller.
2. Try the configured named-pipe controller.
3. If both transports remain unavailable, restart `verge-mihomo` and wait for a new running process/listener.

The worker reports synchronization success only when one reload path succeeds. If restart fails or the process does not return within the bounded recovery window, retain `ClashReloadPending=true` and return a concise error containing all attempted methods.

## Testing and Deployment

- Add quota tests for unlimited evening requests and cross-period requests that still enforce afternoon quota.
- Add worker/static tests proving the bounded restart fallback and success verification are present.
- Run the focused block-plugin test suite.
- Deploy with the existing block installer so repository source and `C:\ProgramData\MashiroBot\mashirobot-plugin-block` remain aligned.
- Run an elevated reapply and verify the worker state records a successful sync without the HTTP 400 / pipe timeout error.
