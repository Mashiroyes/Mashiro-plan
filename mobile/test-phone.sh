#!/data/data/com.termux/files/usr/bin/sh
/data/data/com.termux/files/usr/bin/python -B -m unittest discover \
    -s /data/data/com.termux/files/home/qq-guard/tests -v \
    > /sdcard/Download/plan-qq-phone-tests.log 2>&1
