"""Unprivileged Termux command parser. All real operations use fixed root code."""
import shlex
import subprocess
import sys

from model import parse_play

ENTRY = "/data/local/plan-qq-guard/root-entry.sh"
HELP = """手机 QQ 命令：
  玩QQ10分钟              保留兼容入口，但会拒绝并维持永久封禁
  qq-phone status          查看永久封禁状态
  qq-phone doctor          查看后台、官网封禁和安装包检查
  qq-phone start           启动/补启动后台
  qq-phone recover         异常恢复：立即停用 QQ 并恢复永久封禁
  qq-phone uninstall       停止限制并恢复安装前 QQ/TIM 启用状态
规则：QQ、TIM 和已识别变体始终停用，不提供临时放行。
"""


def arguments(text):
    minutes = parse_play(text)
    if minutes is not None:
        return ["play", str(minutes)]
    aliases = {"查询QQ": "status", "QQ状态": "status", "自检QQ": "doctor"}
    text = aliases.get(text, text)
    if text in {"status", "doctor", "start", "recover", "uninstall"}:
        return [text]
    raise ValueError("未识别命令；用 玩QQ10分钟 或 qq-phone help 查看帮助")


def main():
    text = " ".join(sys.argv[1:]).strip()
    if not text:
        text = input("请输入手机 QQ 命令：").strip()
    if text in {"help", "帮助", "--help", "-h"}:
        print(HELP)
        return 0
    args = arguments(text)
    return subprocess.run(["su", "-c", shlex.join(["/system/bin/sh", ENTRY, *args])]).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, EOFError) as error:
        print(f"手机 QQ 命令失败：{error}", file=sys.stderr)
        sys.exit(1)
