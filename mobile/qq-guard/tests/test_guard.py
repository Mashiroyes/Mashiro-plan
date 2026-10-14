import copy
from contextlib import contextmanager
from datetime import datetime
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from model import Clock, begin, idle, parse_play, reconcile, recover, remaining, validate, forbidden
from apk import PACKAGE, manifest_package, scan_downloads, is_qq_package
from android import Android, BEGIN_MARKER, END_MARKER, DOMAINS, render_hosts
from guard import Controller, Store, atomic_json
from cli import arguments
from policy import restricted_package


NOON = datetime.fromisoformat("2026-09-29T12:00:00+08:00").timestamp()


def clock(seconds=100, boot="boot-a", wall=None):
    return Clock(boot, seconds, NOON + seconds - 100 if wall is None else wall)


def binary_manifest(package=PACKAGE, utf8=True):
    strings = ["manifest", "package", package]
    encoded, offsets = b"", []
    for string in strings:
        offsets.append(len(encoded))
        raw = string.encode("utf-8" if utf8 else "utf-16le")
        encoded += bytes([len(string), len(raw)]) + raw + b"\0" if utf8 else struct.pack("<H", len(string)) + raw + b"\0\0"
    encoded += b"\0" * (-len(encoded) % 4)
    start = 28 + 4 * len(strings)
    pool = struct.pack("<HHIIIIII", 1, 28, start + len(encoded), len(strings), 0, 0x100 if utf8 else 0, start, 0)
    pool += struct.pack("<III", *offsets) + encoded
    node = struct.pack("<HHIII", 0x102, 16, 56, 1, 0xffffffff)
    node += struct.pack("<IIHHHHHH", 0xffffffff, 0, 20, 20, 1, 0, 0, 0)
    node += struct.pack("<IIIHBBI", 0xffffffff, 1, 2, 8, 0, 3, 2)
    return struct.pack("<HHI", 3, 8, 8 + len(pool) + len(node)) + pool + node


def apk_bytes(package=PACKAGE, binary=False):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("AndroidManifest.xml", binary_manifest(package) if binary else f'<manifest package="{package}"/>')
    return data.getvalue()


class ModelTests(unittest.TestCase):
    def test_permanent_policy_rejects_every_play_request(self):
        for minutes in (1, 10, 60, 1440):
            with self.assertRaisesRegex(ValueError, "永久禁止"):
                begin(idle(clock()), clock(), minutes)

    def test_permanent_policy_invalidates_legacy_authorization(self):
        legacy = {**idle(clock()), "phase": "playing", "play_minutes": 10,
                  "play_end": 700, "cooldown_end": 11500}
        self.assertEqual(reconcile(legacy, clock(200)), idle(clock(200)))

    def test_variable_minutes(self):
        for minutes in (1, 10, 25, 60, 90, 1440, 10080):
            self.assertEqual(parse_play(f"玩QQ{minutes}分钟"), minutes)
            with self.assertRaisesRegex(ValueError, "永久禁止"):
                begin(idle(clock()), clock(), minutes)

    def test_case_whitespace_and_no_wechat_prefix(self):
        self.assertEqual(parse_play(" 玩 qq 12 分钟 "), 12)
        self.assertIsNone(parse_play("手机玩QQ10分钟"))
        self.assertEqual(arguments("玩QQ025分钟"), ["play", "25"])

    def test_invalid_commands(self):
        for text in ("玩QQ-1分钟", "玩QQ1.5分钟", "玩QQ1小时", "玩QQ10分钟; echo hi", "玩QQ10分钟 && su", "玩QQ十分钟"):
            self.assertIsNone(parse_play(text))
            with self.assertRaises(ValueError):
                arguments(text)
        with self.assertRaises(ValueError):
            parse_play("玩QQ0分钟")

    def test_forbidden_window_edges(self):
        for local, blocked in (("00:00:00", True), ("11:59:59", True), ("12:00:00", False),
                               ("21:59:59", False), ("22:00:00", True), ("23:59:59", True)):
            now = clock(wall=datetime.fromisoformat(f"2026-09-29T{local}+08:00").timestamp())
            self.assertEqual(forbidden(now), blocked)
            with self.assertRaisesRegex(ValueError, "永久禁止"):
                begin(idle(now), now, 10)

    def test_ready_reboot_stays_ready(self):
        self.assertEqual(reconcile(idle(clock()), clock(1, "boot-b"))["phase"], "ready")

    def test_schema_corruption(self):
        for field, value in (("phase", "unlocked"), ("schema", 2), ("play_end", float("nan")),
                             ("cooldown_end", -1), ("boot", ""), ("last_elapsed", True)):
            state = idle(clock())
            state[field] = value
            with self.assertRaises(ValueError):
                validate(state)
        invalid = {**idle(clock()), "phase": "playing", "play_end": 700,
                   "cooldown_end": 11500}
        invalid["cooldown_end"] += 1
        with self.assertRaises(ValueError):
            validate(invalid)


class ApkTests(unittest.TestCase):
    def test_tim_and_known_qq_variants(self):
        for package in ("com.tencent.tim", "com.tencent.qqlite", "com.tencent.minihd.qq", "com.tencent.mobileqqi", "com.tencent.mobileqq.clone"):
            self.assertTrue(restricted_package(package))
            self.assertTrue(is_qq_package(io.BytesIO(apk_bytes(package, binary=True)), ".apk"))
        for package in ("com.tencent.mm", "com.tencent.timi", "org.example.qq", None):
            self.assertFalse(restricted_package(package))

    def test_binary_manifest_both_encodings(self):
        self.assertEqual(manifest_package(binary_manifest()), PACKAGE)
        self.assertEqual(manifest_package(binary_manifest(utf8=False)), PACKAGE)
        self.assertEqual(manifest_package(binary_manifest("com.tencent.mm")), "com.tencent.mm")

    def test_malformed_binary_retained(self):
        with self.assertRaises(ValueError):
            manifest_package(binary_manifest()[:-1])
        with self.assertRaises(ValueError):
            manifest_package(b"not an APK manifest")

    def test_package_identity_over_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            qq = root / "something-unrelated.apk"
            wechat = root / "QQ-installer.apk"
            broken = root / "QQ-broken.apk"
            qq.write_bytes(apk_bytes(binary=True))
            wechat.write_bytes(apk_bytes("com.tencent.mm"))
            broken.write_bytes(b"download incomplete")
            deleted, errors = scan_downloads([root])
            self.assertEqual(deleted, [str(qq)])
            self.assertTrue(wechat.exists())
            self.assertTrue(broken.exists())
            self.assertEqual(len(errors), 1)

    def test_container_only_if_all_nested_apks_are_qq(self):
        for packages, matched in (([PACKAGE, PACKAGE], True), ([PACKAGE, "com.tencent.mm"], False), ([], False)):
            container = io.BytesIO()
            with zipfile.ZipFile(container, "w") as archive:
                for index, package in enumerate(packages):
                    archive.writestr(f"{index}.apk", apk_bytes(package))
            container.seek(0)
            self.assertEqual(is_qq_package(container, ".xapk"), matched)

    def test_outside_directory_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            download = root / "Download"
            download.mkdir()
            outside = root / "QQ.apk"
            outside.write_bytes(apk_bytes())
            (download / "text.txt").write_text("com.tencent.mobileqq")
            self.assertEqual(scan_downloads([download])[0], [])
            self.assertTrue(outside.exists())

    def test_symlink_not_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "QQ.apk"
            outside.write_bytes(apk_bytes())
            download = root / "Download"
            download.mkdir()
            try:
                (download / "link.apk").symlink_to(outside)
            except OSError:
                self.skipTest("host does not permit symlink creation")
            self.assertEqual(scan_downloads([download])[0], [])
            self.assertTrue(outside.exists())


class FakeStore:
    def __init__(self, state, root):
        self.state = copy.deepcopy(state)
        self.root = root
        self.mutex = threading.RLock()

    @contextmanager
    def locked(self):
        with self.mutex:
            yield

    def load(self):
        if self.state is None:
            raise RuntimeError("corrupt state")
        return copy.deepcopy(self.state)

    def save(self, state):
        self.state = copy.deepcopy(validate(state))


class FakeAndroid:
    def __init__(self):
        self.now = clock()
        self.enabled = False
        self.present = True
        self.host_error = False
        self.launch_error = False
        self.wake_error = False
        self.launches = 0
        self.blocks = 0
        self.wake = False
        self.tim_enabled = True
        self.alt_error = False

    def clock(self): return self.now
    def installed(self): return self.present
    def disabled(self): return not self.enabled
    def block(self):
        self.blocks += 1
        self.enabled = False
        self.block_alternatives()
    def block_primary(self): self.enabled = False
    def block_alternatives(self):
        if self.alt_error:
            raise RuntimeError("TIM disable failure")
        self.tim_enabled = False
        return ["0:com.tencent.tim"]
    def ensure_hosts(self):
        if self.host_error:
            raise RuntimeError("hosts failure")
    def wake_lock(self):
        self.wake = True
        if self.wake_error:
            raise RuntimeError("wake-lock failure")
    def wake_unlock(self): self.wake = False
    def launch(self):
        self.launches += 1
        self.enabled = True
        if self.launch_error:
            raise RuntimeError("launch failure")


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.android = FakeAndroid()
        self.store = FakeStore(idle(clock()), self.root)
        self.controller = Controller(self.store, self.android, lambda: True)

    def test_permanent_policy_blocks_before_rejecting_play(self):
        self.android.enabled = True
        with self.assertRaisesRegex(ValueError, "永久禁止"):
            self.controller.play(10)
        self.assertFalse(self.android.enabled)
        self.assertEqual(self.android.launches, 0)

    def test_idle_light_ticks_only_enforce_every_30_seconds(self):
        self.controller.tick(enforce=False)
        blocks = self.android.blocks
        self.android.enabled = True
        self.android.now = clock(129)
        self.controller.tick(enforce=False)
        self.assertEqual(self.android.blocks, blocks)
        self.assertTrue(self.android.enabled)
        self.android.now = clock(130)
        self.controller.tick(enforce=False)
        self.assertFalse(self.android.enabled)
        self.assertEqual(self.android.blocks, blocks + 1)

    def test_variants_checked_every_30_seconds(self):
        self.controller.tick(enforce=False)
        self.android.tim_enabled = True
        self.android.now = clock(129)
        self.controller.tick(enforce=False)
        self.assertTrue(self.android.tim_enabled)
        self.android.now = clock(130)
        self.controller.tick(enforce=False)
        self.assertFalse(self.android.tim_enabled)
        self.assertFalse(self.android.enabled)

    def test_explicit_status_check_enforces_without_waiting(self):
        self.controller.tick(enforce=False)
        self.android.enabled = True
        self.android.now = clock(101)
        self.controller.tick()
        self.assertFalse(self.android.enabled)

    def test_alternative_block_failure_keeps_standard_qq_blocked(self):
        self.android.alt_error = True
        with self.assertRaises(RuntimeError): self.controller.tick()
        self.assertFalse(self.android.enabled)
        self.assertFalse(self.android.wake)
        self.assertEqual(self.store.state["phase"], "ready")

    def test_concurrent_requests_start_once(self):
        barrier = threading.Barrier(3)
        results = []
        def play():
            barrier.wait()
            try:
                self.controller.play(10)
                results.append("started")
            except ValueError:
                results.append("denied")
        threads = [threading.Thread(target=play) for _ in range(2)]
        for thread in threads: thread.start()
        barrier.wait()
        for thread in threads: thread.join()
        self.assertCountEqual(results, ["denied", "denied"])
        self.assertEqual(self.android.launches, 0)
        self.assertFalse(self.android.enabled)

    def test_no_daemon_no_launch(self):
        self.controller.healthy = lambda: False
        with self.assertRaisesRegex(ValueError, "永久禁止"): self.controller.play(10)
        self.assertFalse(self.android.enabled)

    def test_hosts_failure_no_launch(self):
        self.android.host_error = True
        with self.assertRaises(RuntimeError): self.controller.play(10)
        self.assertFalse(self.android.enabled)
        self.assertEqual(self.android.launches, 0)

    def test_missing_state_enforces_block(self):
        self.store.state = None
        self.android.enabled = True
        with self.assertRaises(RuntimeError): self.controller.tick()
        self.assertFalse(self.android.enabled)

    def test_play_with_corrupt_state_blocks_immediately(self):
        self.store.state = None
        self.android.enabled = True
        with self.assertRaises(RuntimeError): self.controller.play(10)
        self.assertFalse(self.android.enabled)

    def test_recovery_is_not_an_unlock(self):
        self.store.state = None
        state = self.controller.restore_cooldown()
        self.assertEqual(remaining(state, clock()), 0)
        self.assertEqual(state["phase"], "ready")
        self.assertFalse(self.android.enabled)

    def test_legacy_playing_state_closes_qq(self):
        self.store.state = {**idle(clock()), "phase": "playing", "play_end": 700,
                            "cooldown_end": 11500}
        self.android.enabled = True
        self.android.now = clock(10, "boot-b")
        state = self.controller.tick()
        self.assertFalse(self.android.enabled)
        self.assertEqual(state["phase"], "ready")
        self.assertEqual(remaining(state, self.android.now), 0)

    def test_morning_command_blocks_even_when_manually_enabled(self):
        self.android.now = clock(wall=NOON - 1)
        self.android.enabled = True
        with self.assertRaises(ValueError): self.controller.play(10)
        self.assertFalse(self.android.enabled)
        self.assertEqual(self.android.launches, 0)

    def test_22_command_blocks_even_when_manually_enabled(self):
        self.android.now = clock(wall=NOON + 10 * 3600)
        self.android.enabled = True
        with self.assertRaises(ValueError): self.controller.play(10)
        self.assertFalse(self.android.enabled)
        self.assertEqual(self.android.launches, 0)

    def test_invalid_duration_has_no_side_effect(self):
        with self.assertRaises(ValueError): self.controller.play(0)
        self.assertEqual(self.android.blocks, 0)


class AdapterAndStorageTests(unittest.TestCase):
    def test_all_user_variants_blocked_without_touching_wechat(self):
        adapter = Android(Path("unused"))
        packages = {0: {PACKAGE, "com.tencent.tim", "com.tencent.mm"},
                    999: {PACKAGE, "com.tencent.qqlite", "com.tencent.mm"}}
        disabled = {0: set(), 999: set()}
        calls, recorded = [], []
        def run(args, timeout=12):
            calls.append(args)
            if args[1:] == ["list", "users"]:
                return "Users:\n UserInfo{0:Owner:13} running\n UserInfo{999:DualApps:1}"
            user = int(args[args.index("--user") + 1])
            if args[1:3] == ["list", "packages"]:
                values = disabled[user] if "-d" in args else packages[user]
                return "\n".join(f"package:{package}" for package in sorted(values))
            if args[1] == "disable-user": disabled[user].add(args[-1])
            return "ok"
        adapter.run = run
        adapter.record_original = lambda *args: recorded.append(args)
        targets = adapter.block_alternatives()
        self.assertNotIn(PACKAGE, disabled[0])
        self.assertIn("com.tencent.tim", disabled[0])
        self.assertIn(PACKAGE, disabled[999])
        self.assertIn("com.tencent.qqlite", disabled[999])
        self.assertNotIn("com.tencent.mm", disabled[0] | disabled[999])
        self.assertIn(f"999:{PACKAGE}", targets)
        self.assertTrue(recorded)
        before = len([args for args in calls if "disable-user" in args])
        adapter.block_alternatives()
        self.assertEqual(len([args for args in calls if "disable-user" in args]), before)

    def test_users_unavailable_is_an_error(self):
        adapter = Android(Path("unused"))
        adapter.run = lambda _: "not a user listing"
        with self.assertRaises(RuntimeError): adapter.users()

    def test_hosts_preserves_existing_and_is_idempotent(self):
        original = "127.0.0.1 localhost\n0.0.0.0 ads.example\n"
        rendered = render_hosts(original)
        self.assertIn("0.0.0.0 ads.example", rendered)
        self.assertEqual(render_hosts(rendered), rendered)
        self.assertEqual(rendered.count(BEGIN_MARKER), 1)
        self.assertNotIn("dldir1.qq.com", rendered)  # Shared Tencent CDN.
        for domain in DOMAINS:
            self.assertIn(f"0.0.0.0 {domain}", rendered)

    def test_broken_hosts_marker_rejected(self):
        with self.assertRaises(ValueError): render_hosts(BEGIN_MARKER + "\n")

    def test_exact_android_commands_and_launch_confirmation(self):
        adapter = Android(Path("unused"))
        calls = []
        def run(args, timeout=12):
            calls.append(args)
            if "list" in args:
                return "" if "-d" in args else f"package:{PACKAGE}"
            if "start" in args: return "Status: ok\nActivity: com.tencent.mobileqq/.activity.SplashActivity"
            return "ok"
        adapter.run = run
        adapter.launch()
        self.assertIn(["/system/bin/pm", "enable", "--user", "0", PACKAGE], calls)
        self.assertIn(["/system/bin/am", "start", "-W", "--user", "0", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", PACKAGE + "/.activity.SplashActivity"], calls)

    def test_wake_lock_tag(self):
        adapter = Android(Path("unused"))
        adapter.run = lambda _: 'PARTIAL_WAKE_LOCK "termux:service-wakelock" ACQ=-1s'
        self.assertTrue(adapter.has_wake_lock())
        adapter.run = lambda _: "PARTIAL_WAKE_LOCK 'termux:service-wakelock' ACQ=-1s"
        self.assertTrue(adapter.has_wake_lock())
        adapter.run = lambda _: 'PARTIAL_WAKE_LOCK "unrelated" ACQ=-1s'
        self.assertFalse(adapter.has_wake_lock())

    def test_atomic_state_and_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            with self.assertRaises(RuntimeError): store.load()
            store.save(idle(clock()))
            self.assertEqual(store.load()["phase"], "ready")
            store.path.write_text('{"schema":')
            with self.assertRaises(RuntimeError): store.load()
            atomic_json(store.path, recover(clock()))
            self.assertEqual(store.load()["phase"], "ready")
            self.assertEqual(list(Path(directory).glob(".qq-*")), [])

    def test_cli_rejects_shell_injection(self):
        for command in ("start; echo hi", "play 10", "玩QQ$(id)分钟", "uninstall && echo hi"):
            with self.assertRaises(ValueError): arguments(command)
        self.assertEqual(arguments("查询QQ"), ["status"])


if __name__ == "__main__":
    unittest.main()
