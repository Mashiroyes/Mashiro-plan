#!/system/bin/sh
{
    id
    /system/bin/id -Z
    cat /proc/self/attr/current
    /system/bin/getenforce
    command -v su
    ls -l /data/data/com.termux/files/usr/bin/python /data/data/com.termux/files/usr/bin/unzip
    ls -ld /data/adb/service.d /data/adb/ksu /data/adb/ksu/bin/busybox
    /data/data/com.termux/files/usr/bin/python --version
    echo ROOT_NULL_STDIN
    /system/bin/timeout 8 /system/bin/env -i PATH=/system/bin:/system/xbin /system/bin/pm list users </dev/null
    echo SHELL_NULL_STDIN
    /system/bin/timeout 8 /system/bin/su -M -Z u:r:shell:s0 2000 -c '/system/bin/env -i PATH=/system/bin:/system/xbin /system/bin/pm list users </dev/null'
} > /sdcard/Download/plan-qq-root-check.txt 2>&1
