#!/data/data/com.termux/files/usr/bin/bash
set -eu
export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
if [ "$(id -u)" = 0 ]; then
    echo 'Return to the normal Termux shell with exit before installation.' >&2
    exit 1
fi
exec > /sdcard/Download/plan-qq-install.log 2>&1
python - <<'PY'
from pathlib import Path
import zipfile
source = Path('/sdcard/Download/plan-mobile-qq-guard.zip')
target = Path('/data/data/com.termux/files/home')
with zipfile.ZipFile(source) as archive:
    for item in archive.infolist():
        path = Path(item.filename)
        if path.is_absolute() or '..' in path.parts or path.parts[0] != 'qq-guard':
            raise RuntimeError('Unexpected archive path')
    archive.extractall(target)
PY
cd "$HOME/qq-guard"
bash install.sh service
source "$PREFIX/share/plan-qq-guard/bash-hook.sh"
sleep 3
qq-phone doctor
echo PHONE_DEPLOY_DONE
