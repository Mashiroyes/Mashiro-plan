#!/system/bin/sh
set -eu
QQ_ROOT=/data/local/plan-qq-guard
QQ_PREFIX=/data/data/com.termux/files/usr
export PATH=/system/bin:/system/xbin
if [ "$(id -u)" != 0 ]; then
    echo '请通过 Termux qq-phone 命令取得 Root 权限。' >&2
    exit 1
fi
. "$QQ_ROOT/tools.sh"
if [ "$(readlink /proc/self/ns/mnt)" != "$(readlink /proc/1/ns/mnt)" ]; then
    qq_tool nsenter -t 1 -m /system/bin/sh "$QQ_ROOT/root-entry.sh" "$@"
    exit $?
fi
case "${1:-}" in
    start)
        if [ -e "$QQ_ROOT/stop" ]; then
            echo '已卸载，重新运行 install.sh 才能安装。' >&2
            exit 1
        fi
        # Do not let the background service inherit the installer's flock FD.
        # Otherwise installation succeeds once but every upgrade stays locked.
        /system/bin/env -i PATH="$QQ_PREFIX/bin:/system/bin" \
            LD_LIBRARY_PATH="$QQ_PREFIX/lib" "$QQ_PREFIX/bin/python" -I -c \
            'import subprocess,sys; subprocess.Popen(["/system/bin/sh",sys.argv[1]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)' \
            "$QQ_ROOT/supervisor.sh"
        echo '已请求启动手机后台；用 qq-phone doctor 检查是否就绪。'
        exit 0
        ;;
    init|daemon|play|status|doctor|recover|uninstall) ;;
    *) echo '无效 Root 执行命令。' >&2; exit 1 ;;
esac
mkdir -p "$QQ_ROOT/tmp"
cd "$QQ_ROOT"
# Clear caller-controlled Python/loader variables. The Termux runtime itself
# remains a phone prerequisite and must remain installed on the primary user.
exec /system/bin/env -i \
    PATH="$QQ_PREFIX/bin:/system/bin" \
    HOME="$QQ_ROOT" TMPDIR="$QQ_ROOT/tmp" \
    LD_LIBRARY_PATH="$QQ_PREFIX/lib" \
    "$QQ_PREFIX/bin/python" -I "$QQ_ROOT/guard.py" "$@"
