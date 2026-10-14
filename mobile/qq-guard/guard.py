"""Root phone runtime. Desktop tests inject an adapter and an in-memory store."""
from contextlib import contextmanager
import json
import logging
import math
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time

# root-entry uses Python -I; add ONLY this protected code directory for imports.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from android import Android
from apk import scan_downloads
from model import idle, reconcile, recover, remaining, validate, local_time, PERMANENT_BLOCK_MESSAGE

ROOT = Path("/data/local/plan-qq-guard")
DOWNLOADS = ["/storage/emulated/0/Download", "/storage/emulated/0/Downloads", "/storage/emulated/0/安装包"]
LOG = logging.getLogger("qq-phone")
APP_CHECK_SECONDS = 30
DEADLINE_CHECK_SECONDS = 30
HEARTBEAT_MAX_AGE = 60


def atomic_json(path, value, durable=True):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".qq-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, allow_nan=False)
            file.flush()
            if durable:
                os.fsync(file.fileno())
        os.replace(temporary, path)
        if durable and sys.platform == "linux":
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.path = self.root / "state.json"

    @contextmanager
    def locked(self):
        import fcntl
        with (self.root / "state.lock").open("a") as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(file, fcntl.LOCK_UN)

    def load(self):
        try:
            return dict(validate(json.loads(self.path.read_text(encoding="utf-8"))))
        except (OSError, ValueError, TypeError) as error:
            raise RuntimeError("手机状态缺失或损坏；执行 qq-phone recover 恢复永久封禁") from error

    def save(self, state):
        atomic_json(self.path, validate(state))


class Controller:
    def __init__(self, store, android, healthy=lambda: False):
        self.store, self.android, self.healthy = store, android, healthy
        self.last_enforcement = None

    def initialize(self):
        with self.store.locked():
            try:
                self.store.load()
            except RuntimeError:
                # Only install.sh may create the initial state; upgrade never
                # resets a missing/corrupt state or an existing cooldown.
                if (self.store.root / "installed.json").exists():
                    self.android.block()
                    raise
                if not self.android.installed():
                    raise RuntimeError("请先安装标准 QQ，再安装限制工具")
                previous = {"was_disabled": self.android.disabled()}
                atomic_json(self.store.root / "installed.json", previous)
                self.android.block()
                self.android.ensure_hosts()
                self.store.save(idle(self.android.clock()))
            else:
                self.tick_locked()

    def play(self, minutes):
        if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes < 1:
            raise ValueError("游玩分钟数必须是正整数")
        with self.store.locked():
            self.android.block()
            self.android.ensure_hosts()
            self.store.save(reconcile(self.store.load(), self.android.clock()))
            self.android.wake_unlock()
            raise ValueError(PERMANENT_BLOCK_MESSAGE)

    def tick_locked(self, enforce=True):
        try:
            old = self.store.load()
            clock = self.android.clock()
            state = reconcile(old, clock)
        except Exception:
            self.android.block()
            raise
        # Persist the expiry before Android operations, so an interrupted worker
        # cannot reuse an expired authorization.
        changed = state["phase"] != old["phase"] or state["boot"] != old["boot"]
        if changed:
            self.store.save(state)
        enforce = (enforce or changed or self.last_enforcement is None
                   or clock.elapsed < self.last_enforcement
                   or clock.elapsed - self.last_enforcement >= APP_CHECK_SECONDS)
        if state["phase"] != "playing":
            if enforce:
                self.android.block()
            if old["phase"] == "playing" or old["boot"] != state["boot"]:
                self.android.wake_unlock()
        elif enforce:
            try:
                self.android.block_alternatives()
            except Exception:
                # Failure to block a newly installed TIM/clone cancels the QQ
                # authorization rather than continuing with an escape route.
                self.store.save(recover(self.android.clock()))
                self.android.block_primary()
                self.android.wake_unlock()
                raise
        if enforce:
            self.last_enforcement = self.android.clock().elapsed
        return state

    def tick(self, enforce=True):
        with self.store.locked():
            return self.tick_locked(enforce=enforce)

    def restore_cooldown(self):
        with self.store.locked():
            state = recover(self.android.clock())
            self.store.save(state)
            self.android.block()
            self.android.ensure_hosts()
            self.android.wake_unlock()
            return state


def heartbeat_ok(root, android):
    try:
        import fcntl
        with (root / "daemon.lock").open("a") as file:
            try:
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                fcntl.flock(file, fcntl.LOCK_UN)
                return False
        heartbeat = json.loads((root / "heartbeat.json").read_text())
        clock = android.clock()
        return heartbeat["boot"] == clock.boot and 0 <= clock.elapsed - heartbeat["elapsed"] <= HEARTBEAT_MAX_AGE and not heartbeat["error"]
    except (OSError, ValueError, KeyError, TypeError):
        return False


def maintenance(root, android, stopping):
    while not stopping.is_set():
        report = {"checked_at": time.time(), "deleted": [], "errors": []}
        try:
            android.ensure_hosts()
            report["deleted"], report["errors"] = scan_downloads(DOWNLOADS)
        except Exception as error:
            report["errors"].append(str(error))
            LOG.exception("后台官网/安装包检查失败")
        try:
            atomic_json(root / "scan-status.json", report, durable=False)
        except OSError:
            LOG.exception("扫描状态写入失败")
        stopping.wait(60)


def daemon(root, android, controller):
    import fcntl
    with (root / "daemon.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        stopping = threading.Event()
        def stop_signal(*_):
            stopping.set()
        signal.signal(signal.SIGTERM, stop_signal)
        signal.signal(signal.SIGINT, stop_signal)
        worker = threading.Thread(target=maintenance, args=(root, android, stopping), daemon=True)
        worker.start()
        try:
            while not stopping.is_set() and not (root / "stop").exists():
                error = ""
                try:
                    state = controller.tick(enforce=False)
                    clock = android.clock()
                    if state["phase"] == "playing":
                        if not android.has_wake_lock() or not android.hosts_ok():
                            controller.restore_cooldown()
                            raise RuntimeError("唤醒锁或官网封禁失效，已停止 QQ 并恢复永久封禁")
                except Exception as exception:
                    error = str(exception)
                    LOG.exception("封禁对账失败")
                clock = android.clock()
                atomic_json(root / "heartbeat.json", {"boot": clock.boot, "elapsed": clock.elapsed,
                                                       "pid": os.getpid(), "error": error}, durable=False)
                # Check state at most 30s apart, and wake earlier when the 30s
                # application audit is due. State transitions always enforce.
                delay = DEADLINE_CHECK_SECONDS
                if controller.last_enforcement is not None:
                    delay = min(delay, max(0.1, APP_CHECK_SECONDS -
                                          (android.clock().elapsed - controller.last_enforcement)))
                stopping.wait(delay)
        finally:
            stopping.set()
            # Explicit termination invalidates any legacy authorization and closes QQ.
            with controller.store.locked():
                try:
                    state = controller.store.load()
                    if state["phase"] == "playing":
                        controller.store.save(recover(android.clock()))
                finally:
                    if not (root / "stop").exists():
                        android.block()


def doctor(root, android, controller):
    state = controller.tick()
    clock = android.clock()
    scan = root / "scan-status.json"
    return {"phase": state["phase"], "remaining_minutes": math.ceil(remaining(state, clock) / 60),
            "beijing_time": local_time(clock).isoformat(), "permanent_block": True,
            "daemon_healthy": heartbeat_ok(root, android), "qq_installed": android.installed(),
            "qq_disabled": android.disabled(), "website_block": android.hosts_ok(),
            "wake_lock": android.has_wake_lock(),
            "restricted_packages": json.loads((root / "original-apps.json").read_text()) if (root / "original-apps.json").exists() else {},
            "scan": json.loads(scan.read_text()) if scan.exists() else {"errors": ["尚未扫描"]}}


def uninstall(root, android, store):
    with store.locked():
        previous = json.loads((root / "installed.json").read_text())
        if not isinstance(previous.get("was_disabled"), bool):
            raise RuntimeError("缺少安装前状态，拒绝猜测恢复方式")
        (root / "stop").touch(mode=0o600)
    # Wait for daemon singleton lock release. No broad pkill or process-name kills.
    import fcntl
    deadline = time.monotonic() + 45
    with (root / "daemon.lock").open("a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("后台尚未停止，稍后重试 qq-phone uninstall")
                time.sleep(1)
        android.restore_hosts()
        android.restore_all_packages(previous["was_disabled"])
        android.wake_unlock()
        for name in ("installed.json", "state.json", "original-apps.json"):
            path = root / name
            if path.exists():
                path.replace(root / (name + ".uninstalled"))
        # Leave stop marker and preserved state/logs for recovery; no recursive rm.


def main():
    if sys.platform != "linux" or os.geteuid() != 0 or not Path("/system/bin/pm").is_file():
        raise RuntimeError("此执行器只能在 Root Android 手机上运行")
    if Path(__file__).resolve().parent != ROOT:
        raise RuntimeError("请使用 install.sh 安装受保护副本，不直接运行下载目录代码")
    ROOT.mkdir(mode=0o700, exist_ok=True)
    android = Android(ROOT)
    android.check_namespace()
    handler = RotatingFileHandler(ROOT / "guard.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    store = Store(ROOT)
    controller = Controller(store, android, lambda: heartbeat_ok(ROOT, android))
    if (ROOT / "stop").exists() and command not in {"init", "uninstall"}:
        raise RuntimeError("服务已卸载或停止；重新运行 install.sh 才能安装")
    if command == "init":
        controller.initialize()
        print("手机 QQ 限制已初始化；默认停用 QQ。")
    elif command == "daemon":
        daemon(ROOT, android, controller)
    elif command == "play" and len(sys.argv) == 3:
        controller.play(int(sys.argv[2]))
    elif command in {"status", "doctor"}:
        report = doctor(ROOT, android, controller)
        if command == "doctor":
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            labels = {"playing": "旧授权清理中", "cooldown": "旧状态清理中", "ready": "永久禁止（QQ已停用）"}
            print(f"手机 QQ：{labels[report['phase']]}。")
            print(f"后台正常：{report['daemon_healthy']}；官网封禁：{report['website_block']}；QQ停用：{report['qq_disabled']}")
    elif command == "recover":
        controller.restore_cooldown()
        print("已停用 QQ 并恢复永久封禁。")
    elif command == "uninstall":
        uninstall(ROOT, android, store)
        print("已停止后台、撤销自己的官网挂载并恢复 QQ/TIM 安装前启用状态。记录保留在手机 Root 目录。")
    else:
        raise ValueError("无效手机执行器命令")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"手机 QQ 操作失败：{error}", file=sys.stderr)
        sys.exit(1)
