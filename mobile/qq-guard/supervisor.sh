#!/system/bin/sh
set -u
QQ_ROOT=/data/local/plan-qq-guard
export PATH=/system/bin:/system/xbin
. "$QQ_ROOT/tools.sh"
if [ "${1:-}" != --locked ]; then
    qq_tool flock -n -- "$QQ_ROOT/supervisor.lock" /system/bin/sh "$QQ_ROOT/supervisor.sh" --locked || :
    exit 0
fi
while [ ! -e "$QQ_ROOT/stop" ]; do
    if [ -f "$QQ_ROOT/supervisor.log" ] && [ "$(wc -c < "$QQ_ROOT/supervisor.log")" -gt 128000 ]; then
        mv "$QQ_ROOT/supervisor.log" "$QQ_ROOT/supervisor.log.old"
    fi
    /system/bin/sh "$QQ_ROOT/root-entry.sh" daemon >>"$QQ_ROOT/supervisor.log" 2>&1
    [ -e "$QQ_ROOT/stop" ] && break
    # Fail closed if the Python worker exited or cannot run (including upgrades).
    /system/bin/am force-stop --user 0 com.tencent.mobileqq >/dev/null 2>&1 || :
    /system/bin/pm disable-user --user 0 com.tencent.mobileqq >/dev/null 2>&1 || :
    /system/bin/am force-stop --user 0 com.tencent.tim >/dev/null 2>&1 || :
    /system/bin/pm disable-user --user 0 com.tencent.tim >/dev/null 2>&1 || :
    sleep 2
done
