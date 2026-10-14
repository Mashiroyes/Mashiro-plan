"""Phone deployment check; does not authorize QQ or change its cooldown."""
from pathlib import Path
import json
import sys
import time

sys.path.insert(0, '/data/local/plan-qq-guard')
from android import Android
from guard import Store, Controller, doctor

root = Path('/data/local/plan-qq-guard')
android = Android(root)
result = {}
try:
    android.check_namespace()
    result['global_namespace'] = True
    held = android.has_wake_lock()
    try:
        android.wake_lock()
        result['wake_lock_verified'] = android.has_wake_lock()
    finally:
        if not held:
            android.wake_unlock()
    store = Store(root)
    controller = Controller(store, android)
    result['doctor'] = doctor(root, android, controller)
    boot = Path('/data/adb/service.d/plan-qq-guard.sh')
    result['boot_script_exists'] = boot.exists()
    result['boot_script_mode'] = oct(boot.stat().st_mode & 0o777)
    result['boot_script'] = boot.read_text()
    result['state_unchanged_ready'] = store.load()['phase'] == 'ready'
except Exception as error:
    result['error'] = str(error)
Path('/sdcard/Download/plan-qq-verify.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
