#!/system/bin/sh
# Called by install.sh; code paths are shell-quoted by Python on the phone.
set -eu
export PATH=/system/bin:/system/xbin
[ "$(id -u)" = 0 ] || { echo '安装需要 Root。' >&2; exit 1; }
QQ_SOURCE=$1
QQ_BOOT=$2
QQ_ROOT=/data/local/plan-qq-guard
[ -x /data/data/com.termux/files/usr/bin/python ] || { echo '请先在主用户 Termux 安装 Python。' >&2; exit 1; }
case "$QQ_BOOT" in termux|service|magisk|manual) ;; *) exit 1 ;; esac
if { [ "$QQ_BOOT" = magisk ] || [ "$QQ_BOOT" = service ]; } && [ ! -d /data/adb/service.d ]; then
    echo '没有 Root service.d；改用 termux 或 manual。' >&2
    exit 1
fi
umask 077
[ ! -L "$QQ_ROOT" ] || { echo '拒绝使用符号链接作为 Root 运行目录。' >&2; exit 1; }
mkdir -p "$QQ_ROOT"
chown 0:0 "$QQ_ROOT"
chmod 700 "$QQ_ROOT"
. "$QQ_SOURCE/tools.sh"
if [ "${3:-}" != --locked ]; then
    # Android shells/root wrappers may close inherited numeric descriptors.
    # Let flock own its descriptor and run the complete locked command instead.
    qq_tool flock -n -- "$QQ_ROOT/install.lock" /system/bin/sh "$0" "$QQ_SOURCE" "$QQ_BOOT" --locked
    exit $?
fi
for qq_file in model.py policy.py apk.py android.py guard.py tools.sh root-entry.sh supervisor.sh; do
    [ -f "$QQ_SOURCE/$qq_file" ] && [ ! -L "$QQ_SOURCE/$qq_file" ] || exit 1
    cp "$QQ_SOURCE/$qq_file" "$QQ_ROOT/$qq_file.new"
    chown 0:0 "$QQ_ROOT/$qq_file.new"
    chmod 600 "$QQ_ROOT/$qq_file.new"
    mv "$QQ_ROOT/$qq_file.new" "$QQ_ROOT/$qq_file"
done
# Installer preflights flock before enabling anything. Namespace entry and Python
# availability are validated by init. No existing state is overwritten.
. "$QQ_ROOT/tools.sh"
rm -f "$QQ_ROOT/stop"
/system/bin/sh "$QQ_ROOT/root-entry.sh" init
if [ "$QQ_BOOT" = magisk ] || [ "$QQ_BOOT" = service ]; then
    cat > /data/adb/service.d/plan-qq-guard.sh <<'BOOT'
#!/system/bin/sh
while [ "$(/system/bin/getprop sys.boot_completed)" != 1 ]; do sleep 2; done
[ -e /data/local/plan-qq-guard/stop ] && exit 0
/system/bin/sh /data/local/plan-qq-guard/root-entry.sh start
BOOT
    chmod 700 /data/adb/service.d/plan-qq-guard.sh
elif [ -f /data/adb/service.d/plan-qq-guard.sh ]; then
    rm -f /data/adb/service.d/plan-qq-guard.sh
fi
/system/bin/sh "$QQ_ROOT/root-entry.sh" start
