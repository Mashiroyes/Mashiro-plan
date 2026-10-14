# Disable Bilibili Browser Shutdown Design

## Goal

When a temporary Bilibili release expires, restore all network and browser-policy blocking layers without closing any browser process.

## Scope

- Remove the Bilibili-expiry browser-process termination function and its required synchronization layer.
- Keep expiry detection, hosts restoration, browser-policy restoration, Clash rule restoration/reload, and the existing timeout reading prompt.
- Update regression tests so ordinary synchronization and expired Bilibili synchronization both prove that no browser-shutdown layer is emitted.
- Redeploy the block worker and verify the scheduled scan task succeeds with the deployed source hash matching the repository source.

## Safety and Verification

No test may start or terminate a real browser. The expiry scenario is exercised with a temporary SQLite fixture and `-DryRun`. Deployment verification uses worker hashes, task exit status, and the persisted successful layer report.
