"""Android root operations. Imported safely on a desktop; never run on import."""
from pathlib import Path
import os
import re
import json
import subprocess
import time
from contextlib import contextmanager

from apk import PACKAGE
from model import Clock
from policy import restricted_package

DOMAINS = ("im.qq.com", "www.im.qq.com", "mobile.qq.com", "qq.com", "www.qq.com", "down.qq.com",
           "tim.qq.com", "www.tim.qq.com")
BEGIN_MARKER = "# BEGIN PLAN PHONE QQ GUARD"
END_MARKER = "# END PLAN PHONE QQ GUARD"


def render_hosts(original):
    lines = []
    inside = False
    for line in original.splitlines():
        if line.strip() == BEGIN_MARKER:
            inside = True
        elif line.strip() == END_MARKER:
            inside = False
        elif not inside:
            lines.append(line)
    if inside:
        raise ValueError("hosts 标记段不完整")
    lines.extend([BEGIN_MARKER, *[f"0.0.0.0 {domain}\n:: {domain}" for domain in DOMAINS], END_MARKER])
    return "\n".join(lines) + "\n"


class Android:
    def __init__(self, root):
        self.root = Path(root)
        self.hosts = Path("/system/etc/hosts")
        self.pm = "/system/bin/pm"
        self.am = "/system/bin/am"

    def run(self, args, timeout=12):
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                                stdin=subprocess.DEVNULL, env={"PATH": "/system/bin:/system/xbin"})
        if result.returncode:
            raise RuntimeError(f"{Path(args[0]).name} 失败: {(result.stderr or result.stdout).strip()[:600]}")
        return result.stdout.strip()

    def clock(self):
        import time
        return Clock(Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                     float(Path("/proc/uptime").read_text().split()[0]), time.time())

    def installed(self):
        result = self.run([self.pm, "list", "packages", "--user", "0", PACKAGE])
        return f"package:{PACKAGE}" in result.splitlines()

    def disabled(self):
        result = self.run([self.pm, "list", "packages", "-d", "--user", "0", PACKAGE])
        return f"package:{PACKAGE}" in result.splitlines()

    @contextmanager
    def file_lock(self, name):
        import fcntl
        with (self.root / name).open("a") as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(file, fcntl.LOCK_UN)

    def users(self):
        output = self.run([self.pm, "list", "users"])
        users = sorted({int(value) for value in re.findall(r"UserInfo\{(\d+):", output)})
        if 0 not in users:
            raise RuntimeError("无法枚举 Android 用户，拒绝遗漏双开/其他用户中的 QQ")
        return users

    def package_set(self, user, disabled=False):
        args = [self.pm, "list", "packages"]
        if disabled:
            args.append("-d")
        return {line[len("package:"):] for line in self.run(args + ["--user", str(user)]).splitlines()
                if line.startswith("package:")}

    def record_original(self, user, package, disabled):
        # Keep install-before state for every QQ/TIM app, including variants
        # installed later. This file is independent of the session-state lock.
        from guard import atomic_json
        with self.file_lock("apps.lock"):
            path = self.root / "original-apps.json"
            original = json.loads(path.read_text()) if path.exists() else {}
            key = f"{user}:{package}"
            if key not in original:
                original[key] = {"user": user, "package": package, "was_disabled": disabled}
                atomic_json(path, original)

    def disable_one(self, user, package, was_disabled):
        record_error = None
        try:
            self.record_original(user, package, was_disabled)
        except Exception as error:
            record_error = error
        if not was_disabled:
            self.run([self.am, "force-stop", "--user", str(user), package])
            self.run([self.pm, "disable-user", "--user", str(user), package])
            if package not in self.package_set(user, disabled=True):
                raise RuntimeError(f"未确认 {user}:{package} 已停用")
        if record_error:
            raise RuntimeError(f"已执行封禁，但安装前状态记录失败: {record_error}")

    def block_primary(self):
        if self.installed():
            self.disable_one(0, PACKAGE, self.disabled())

    def block_alternatives(self):
        targets = []
        errors = []
        for user in self.users():
            try:
                packages = self.package_set(user)
                disabled = self.package_set(user, disabled=True)
            except Exception as error:
                errors.append(str(error))
                continue
            for package in sorted(packages):
                if restricted_package(package) and (user != 0 or package != PACKAGE):
                    try:
                        self.disable_one(user, package, package in disabled)
                    except Exception as error:
                        errors.append(str(error))
                    targets.append(f"{user}:{package}")
        if errors:
            raise RuntimeError("变体/多用户封禁异常：" + "; ".join(errors)[:800])
        return targets

    def block(self):
        # Primary QQ expiry is enforced BEFORE enumerating other user profiles.
        errors = []
        for action in (self.block_primary, self.block_alternatives):
            try:
                action()
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError("QQ/TIM 封禁异常：" + "; ".join(errors)[:800])

    def launch(self):
        result = self.run([self.pm, "enable", "--user", "0", PACKAGE])
        if self.disabled() or not self.installed():
            raise RuntimeError(f"未确认 QQ 已启用: {result}")
        # QQ has many alternate launcher aliases. A package-only intent may
        # fail resolution on Android 16; use its actual main activity directly.
        result = self.run([self.am, "start", "-W", "--user", "0", "-a", "android.intent.action.MAIN",
                           "-c", "android.intent.category.LAUNCHER", "-n",
                           PACKAGE + "/.activity.SplashActivity"], timeout=25)
        if "Status: ok" not in result or "Error:" in result:
            raise RuntimeError(f"QQ 启动未确认: {result}")

    def wake_lock(self):
        # Same documented intent used by termux-wake-lock. CPU wake lock is
        # needed because userspace deadline loops alone cannot wake a sleeping CPU.
        result = self.run([self.am, "startservice", "--user", "0", "-a",
                           "com.termux.service_wake_lock", "com.termux/com.termux.app.TermuxService"])
        if "Error" in result:
            raise RuntimeError(f"无法取得 Termux 唤醒锁: {result}")
        deadline = time.monotonic() + 3
        while not self.has_wake_lock():
            if time.monotonic() >= deadline:
                raise RuntimeError("未在 Android 电源服务中确认 Termux 唤醒锁，请先打开 Termux")
            time.sleep(0.2)

    def has_wake_lock(self):
        result = self.run(["/system/bin/dumpsys", "power"])
        # Tag from the official TermuxService implementation.
        return any(re.search(r"PARTIAL_WAKE_LOCK.*['\"]termux:service-wakelock['\"]", line)
                   for line in result.splitlines())

    def wake_unlock(self):
        self.run([self.am, "startservice", "--user", "0", "-a",
                  "com.termux.service_wake_unlock", "com.termux/com.termux.app.TermuxService"])

    def ensure_hosts(self):
        with self.file_lock("hosts.lock"):
            self.ensure_hosts_locked()

    def ensure_hosts_locked(self):
        if (self.root / "stop").exists():
            raise RuntimeError("服务停止中，禁止重新挂载官网规则")
        source = self.root / "blocked-hosts"
        if self.hosts_ok():
            return
        # We are launched inside PID 1's mount namespace. Never remount /system rw.
        original = self.hosts.read_text()
        rendered = render_hosts(original)
        if source.exists() and os.path.samestat(source.stat(), self.hosts.stat()):
            # A changed file is still our active bind mount; update in place.
            source.write_text(rendered)
        else:
            source.write_text(rendered)
            source.chmod(0o644)
            self.run(["/system/bin/chcon", "u:object_r:system_file:s0", str(source)])
            self.run(["/system/bin/mount", "--bind", str(source), str(self.hosts)])
        if not self.hosts_ok():
            raise RuntimeError("QQ 官网 hosts 拦截未生效")

    def hosts_ok(self):
        text = self.hosts.read_text()
        lines = set(text.splitlines())
        return BEGIN_MARKER in lines and END_MARKER in lines and all(
            f"0.0.0.0 {domain}" in lines and f":: {domain}" in lines for domain in DOMAINS)

    def restore_hosts(self):
        with self.file_lock("hosts.lock"):
            self.restore_hosts_locked()

    def restore_hosts_locked(self):
        source = self.root / "blocked-hosts"
        if source.exists() and os.path.samestat(source.stat(), self.hosts.stat()):
            self.run(["/system/bin/umount", str(self.hosts)])
        elif BEGIN_MARKER in self.hosts.read_text():
            raise RuntimeError("hosts 挂载已被其他工具替换，请手动检查，未卸载其他工具的挂载")

    def restore_package(self, was_disabled):
        if self.installed():
            self.run([self.pm, "disable-user" if was_disabled else "enable", "--user", "0", PACKAGE])

    def restore_all_packages(self, primary_was_disabled):
        path = self.root / "original-apps.json"
        original = json.loads(path.read_text()) if path.exists() else {}
        users = set(self.users())
        for entry in original.values():
            user, package, disabled = entry["user"], entry["package"], entry["was_disabled"]
            if not isinstance(user, int) or not restricted_package(package) or not isinstance(disabled, bool):
                raise RuntimeError("安装前应用状态记录损坏，拒绝恢复不相关应用")
            if user in users and package in self.package_set(user):
                self.run([self.pm, "disable-user" if disabled else "enable", "--user", str(user), package])
        if f"0:{PACKAGE}" not in original:
            self.restore_package(primary_was_disabled)

    def check_namespace(self):
        if os.readlink("/proc/self/ns/mnt") != os.readlink("/proc/1/ns/mnt"):
            raise RuntimeError("执行器未进入系统全局挂载命名空间，拒绝启动 QQ")
