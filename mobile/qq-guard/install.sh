#!/data/data/com.termux/files/usr/bin/sh
set -eu
QQ_BOOT=${1:-termux}
case "$QQ_BOOT" in
    termux|service|magisk|manual) ;;
    *) echo '用法：bash install.sh [termux|service|magisk|manual]' >&2; exit 1 ;;
esac
[ "${PREFIX:-}" = /data/data/com.termux/files/usr ] || { echo '仅支持 Android 主用户的标准 Termux。' >&2; exit 1; }
command -v python >/dev/null || { echo '先执行 pkg install python。' >&2; exit 1; }
QQ_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QQ_SHARE=$PREFIX/share/plan-qq-guard
mkdir -p "$QQ_SHARE" "$HOME/.termux/boot"
cp "$QQ_SOURCE/cli.py" "$QQ_SOURCE/model.py" "$QQ_SOURCE/bash-hook.sh" "$QQ_SHARE/"
cp "$QQ_SOURCE/qq-phone" "$PREFIX/bin/qq-phone"
chmod 700 "$PREFIX/bin/qq-phone"
# shlex handles Chinese paths and spaces; no text command is interpolated into su.
QQ_INSTALL_COMMAND=$(python - "$QQ_SOURCE" "$QQ_BOOT" <<'PY'
import shlex, sys
from pathlib import Path
source = Path(sys.argv[1])
print(shlex.join(['/system/bin/sh', str(source / 'install-root.sh'), str(source), sys.argv[2]]))
PY
)
su -c "$QQ_INSTALL_COMMAND"
if [ "$QQ_BOOT" = termux ]; then
    cat > "$HOME/.termux/boot/plan-qq-guard" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/sh
/data/data/com.termux/files/usr/bin/qq-phone start
BOOT
    chmod 700 "$HOME/.termux/boot/plan-qq-guard"
elif [ -f "$HOME/.termux/boot/plan-qq-guard" ]; then
    rm -f "$HOME/.termux/boot/plan-qq-guard"
fi
if ! grep -q '^# PLAN PHONE QQ COMMAND HOOK$' "$HOME/.bashrc" 2>/dev/null; then
    cat >> "$HOME/.bashrc" <<'HOOK'

# PLAN PHONE QQ COMMAND HOOK
[ -f /data/data/com.termux/files/usr/share/plan-qq-guard/bash-hook.sh ] && . /data/data/com.termux/files/usr/share/plan-qq-guard/bash-hook.sh
HOOK
fi
echo '安装完成。QQ/TIM 已永久停用；旧的 玩QQN分钟 命令会被明确拒绝。'
echo '先执行 qq-phone doctor；更换手机时，按 README.md 重新安装。'
if [ "$QQ_BOOT" = termux ]; then
    echo '开机自启需要同来源的 Termux:Boot，安装后至少打开一次；否则重启后手动 qq-phone start。'
fi
