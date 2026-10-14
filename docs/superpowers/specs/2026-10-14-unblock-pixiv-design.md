# Permanently Unblock Pixiv on Windows

## Goal

Remove the computer-wide Pixiv restriction, including Clash/Mihomo rules, while preserving all unrelated FocusLock controls such as adult-content filtering, QQ, Bilibili, and HAnime policy.

## Scope

- Remove `pixiv.net` and `pximg.net` entries from the FocusLock managed hosts list.
- Remove Pixiv and pximg URL patterns from managed Chrome and Edge block policies.
- Remove Pixiv and pximg `REJECT` rules from the FocusLock Clash rule generator and every effective Clash Verge YAML file.
- Update both the repository source and the deployed FocusLock copy so scheduled repair cannot recreate the restriction.
- Remove currently effective Pixiv entries from hosts and browser policies without changing unrelated entries.
- Reload or restart Mihomo as needed for the active configuration to take effect.

## Preservation Rules

- Do not change adult-category DNS enforcement.
- Do not remove blocks for MissAV or other adult sites.
- Do not change QQ, Bilibili, HAnime, application, or game restrictions.
- Preserve unrelated existing edits in the dirty working tree.

## Verification

- No Pixiv or pximg entry remains in the repository or deployed FocusLock managed lists.
- No Pixiv or pximg entry remains in the Windows hosts file or Chrome/Edge URL block policies.
- No Pixiv or pximg `REJECT` rule remains in generated or profile Clash YAML files.
- Requests to `www.pixiv.net` and `i.pximg.net` through the configured Clash proxy reach a remote response rather than a local reject.
- A representative still-blocked target remains blocked, and a normal-site control remains reachable.

## Failure Handling

If administrator rights prevent a runtime layer from being changed, retain the source change, report the exact remaining layer, and do not claim full completion. If a Clash reload API is unavailable, restart the Clash Verge/Mihomo runtime and verify the active listener before testing.
