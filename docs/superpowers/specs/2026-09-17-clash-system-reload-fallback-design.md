# Clash SYSTEM reload fallback design

## Problem

The MashiroBot block worker runs as SYSTEM so it can update hosts and machine browser policies. Clash Verge's `verge-mihomo` named pipe is reachable from the signed-in user session but SYSTEM pipe connections time out. A pipe-only reload therefore leaves a correct generated configuration unapplied and reports synchronization failure.

## Design

Enable Clash Verge's authenticated external controller on `127.0.0.1:9097`. It remains loopback-only and does not expose the controller to the LAN.

The worker will try the loopback HTTP controller first and the existing named pipe second within the existing bounded retry window. Both transports send the same authenticated `PUT /configs?force=true` request and count only HTTP 200 or 204 as success. A failure reports the last error from both transports.

Do not alter block-list contents, temporary-release duration, hosts rules, browser policies, QQ controls, or other FocusLock behavior.

## Verification

- Prove the new worker test fails before implementation and passes afterward.
- Enable the persistent Clash Verge controller setting and apply the generated configuration.
- Verify `127.0.0.1:9097/version` succeeds with authentication and is not listening on a non-loopback address.
- Deploy the tested worker without resetting state or recreating rules.
- Trigger a SYSTEM reapply that has `ClashReloadPending=true`; require a fresh successful `LastSync`, task result 0, and `ClashReloadPending=false`.
- Verify the requested Bilibili release is effective and QQ remains blocked.

