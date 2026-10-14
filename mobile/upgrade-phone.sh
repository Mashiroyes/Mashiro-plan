#!/data/data/com.termux/files/usr/bin/bash
set -eu
export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
exec > /sdcard/Download/plan-qq-upgrade.log 2>&1
su -M -c '/data/data/com.termux/files/usr/bin/python /sdcard/Download/plan-qq-upgrade-stop.py'
if ! bash /sdcard/Download/plan-qq-deploy.sh; then
    su -M -c 'rm -f /data/local/plan-qq-guard/stop; sh /data/local/plan-qq-guard/root-entry.sh start'
    echo UPGRADE_FAILED
    exit 1
fi
sh /sdcard/Download/plan-qq-test.sh
qq-phone doctor
echo POWER_UPGRADE_DONE
