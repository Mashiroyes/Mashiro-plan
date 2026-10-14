#!/data/data/com.termux/files/usr/bin/bash
export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
python - <<'PY'
from pathlib import Path
import zipfile
with zipfile.ZipFile('/sdcard/Download/plan-mobile-qq-guard.zip') as archive:
    for name in ('README.md', 'VALIDATION.md'):
        Path('/data/data/com.termux/files/home/qq-guard', name).write_bytes(archive.read('qq-guard/' + name))
PY
. "$PREFIX/share/plan-qq-guard/bash-hook.sh"
查询QQ > /sdcard/Download/plan-qq-command-check.log 2>&1
玩QQ0分钟 >> /sdcard/Download/plan-qq-command-check.log 2>&1
[ "$?" = 1 ] && echo INVALID_MINUTES_REJECTED >> /sdcard/Download/plan-qq-command-check.log
