import json
import subprocess
from pathlib import Path

tests = {}
for name, args in (("root", ["/system/bin/pm", "list", "users"]),
                   ("shell", ["/system/bin/su", "-M", "-Z", "u:r:shell:s0", "2000", "-c", "/system/bin/pm list users"])):
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                env={"PATH": "/system/bin:/system/xbin"}, timeout=10)
        tests[name] = {"exit": result.returncode, "out": result.stdout, "err": result.stderr}
    except Exception as error:
        tests[name] = {"error": str(error)}
Path('/sdcard/Download/plan-qq-binder-check.json').write_text(json.dumps(tests))
