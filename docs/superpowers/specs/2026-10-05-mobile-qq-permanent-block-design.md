# Mobile QQ Permanent Block Design

## Goal

Turn the saved `mobile/qq-guard` policy into a permanent QQ/TIM block while retaining the installed apps and their user data.

## Policy

- Standard QQ, TIM, known QQ variants, clones, and matching packages in other Android users remain force-stopped and disabled.
- `玩QQN分钟` remains a recognized command but always fails with a clear permanent-block message; it can never enable or launch QQ.
- Any saved `playing` or `cooldown` state is normalized to `ready` on the first reconciliation, but `ready` means permanently blocked rather than eligible to play.
- The daemon keeps checking packages and re-disables a restricted package if it is manually enabled.
- Existing QQ/TIM website hosts blocking and download-directory APK cleanup remain active.
- QQ and its app data are not uninstalled or deleted. The explicit guard uninstall command remains the recovery path for intentionally removing this protection.

## Defense in Depth

- The pure model rejects every new play request.
- The root controller blocks Android packages before returning a permanent-block error.
- Reconciliation invalidates any pre-upgrade authorization and forces Android enforcement.
- CLI/help/status text no longer advertises a usable play window or cooldown.

## Verification

- Desktop unit tests prove no play request can produce a `playing` state or invoke Android launch.
- Packaging regenerates the checked archive and checksum from the saved project copy.
- The connected phone is upgraded from that archive without reading phone source back into the project.
- True-device acceptance requires: daemon healthy, QQ disabled, website block active, no active authorization, play command rejected, QQ still disabled after rejection, and phone-side tests passing.
