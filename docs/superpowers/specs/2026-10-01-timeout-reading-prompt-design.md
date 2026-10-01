# Timeout Reading Prompt Design

## Goal

Open `C:\Users\Mashiroyes\Desktop\语言引论 (弗罗姆金) (z-library.sk, 1lib.sk, z-lib.sk).pdf` when a desktop Bilibili or QQ timed release ends, and when the user attempts to start QQ during its active cooldown.

## Scope

- Bilibili temporary-release expiry opens the PDF once after the restriction is restored.
- QQ timed-session expiry opens the PDF once after the QQ client barrier is restored.
- Each QQ launch attempt during an active cooldown opens the PDF while QQ remains blocked.
- Permanent restrictions, manual restores, malformed state, deployment checks, and non-timeout failures do not open the PDF.

## Design

1. Install an interactive-user scheduled task that opens the fixed PDF through the default Windows PDF application.
2. Add a durable event ledger keyed by Bilibili expiry timestamp and QQ session identifier/end timestamp. Workers submit expiry events only after their relevant restriction is confirmed active; the ledger suppresses duplicate task runs.
3. Have the Bilibili block worker and QQ session worker submit their respective expiry events to the shared task.
4. Replace the FocusLock QQ IFEO `cmd /c exit` debugger with a small user-context wrapper. The wrapper reads the active QQ session state; if and only if the phase is `cooldown` and its cooldown end is still in the future, it opens the PDF, then exits without starting QQ.
5. Preserve the existing IFEO backup and restoration semantics. A removed QQ restriction restores the original debugger rather than retaining the wrapper.

## Verification

- Fixture tests prove Bilibili and QQ expiry each submit exactly one event after reapplying the block.
- Repeated expiry reconciliation does not create another event.
- A cooldown QQ launch invokes the wrapper and opens the configured PDF; a ready, permanently blocked, or missing session does not.
- The installed runtime copies and scheduled task match the source configuration.
