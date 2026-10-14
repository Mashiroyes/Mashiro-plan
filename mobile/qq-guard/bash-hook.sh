# Bash compatibility: recognize legacy play commands so the guard can reject them clearly.
# Preserve Termux's previous command-not-found handler for unrelated commands.
if [ -n "${BASH_VERSION:-}" ] && [ "${QQ_PHONE_BASH_HOOK_LOADED:-0}" != 1 ]; then
    QQ_PHONE_BASH_HOOK_LOADED=1
    if declare -F command_not_found_handle >/dev/null; then
        eval "$(declare -f command_not_found_handle | sed '1s/command_not_found_handle/qq_phone_previous_not_found/')"
    fi
    command_not_found_handle() {
        case "$1" in
            玩QQ*分钟|玩qq*分钟|玩QQ|玩qq|查询QQ|QQ状态|自检QQ)
                command qq-phone "$@"
                ;;
            *)
                if declare -F qq_phone_previous_not_found >/dev/null; then
                    qq_phone_previous_not_found "$@"
                else
                    printf '%s: command not found\n' "$1" >&2
                    return 127
                fi
                ;;
        esac
    }
fi
