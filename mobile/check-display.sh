#!/data/data/com.termux/files/usr/bin/bash
export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
qq-phone status > /sdcard/Download/plan-qq-display-check.log 2>&1
qq-phone doctor >> /sdcard/Download/plan-qq-display-check.log 2>&1
sh /sdcard/Download/plan-qq-test.sh
