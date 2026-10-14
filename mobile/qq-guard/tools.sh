#!/system/bin/sh
# Root-only native utilities, using the root manager's BusyBox if necessary.
qq_tool() {
    qq_name=$1
    shift
    # Android ToyBox flock accepts only a numeric FD; use BusyBox's command
    # mode to survive Android shell / Root wrappers closing inherited FDs.
    if [ "$qq_name" = flock ]; then
        for qq_box in /data/adb/magisk/busybox /data/adb/ksu/bin/busybox /data/adb/ap/bin/busybox; do
            if [ -x "$qq_box" ] && "$qq_box" --list | /system/bin/grep -qx flock; then
                "$qq_box" flock "$@"
                return $?
            fi
        done
        echo '文件锁需要 Root 管理器 BusyBox 的 flock 命令模式。' >&2
        return 1
    fi
    if [ -x "/system/bin/$qq_name" ]; then
        "/system/bin/$qq_name" "$@"
        return $?
    fi
    for qq_box in /data/adb/magisk/busybox /data/adb/ksu/bin/busybox /data/adb/ap/bin/busybox; do
        if [ -x "$qq_box" ] && "$qq_box" --list | /system/bin/grep -qx "$qq_name"; then
            "$qq_box" "$qq_name" "$@"
            return $?
        fi
    done
    echo "缺少 Root 工具 $qq_name；需要原生工具或 Root 管理器 BusyBox。" >&2
    return 1
}
