"""Rebuild a phone-transfer archive from this saved code and documentation."""
import hashlib
from pathlib import Path
import zipfile

FILES = ["README.md", "DESIGN.md", "VALIDATION.md", "model.py", "policy.py", "apk.py", "android.py", "guard.py",
         "cli.py", "qq-phone", "bash-hook.sh", "install.sh", "install-root.sh", "root-entry.sh",
         "tools.sh", "supervisor.sh", "package.py", "tests/test_guard.py", ".gitignore"]


def main():
    root = Path(__file__).resolve().parent
    destination = root.parent / "plan-mobile-qq-guard.zip"
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for relative in FILES:
            source = root / relative
            data = source.read_bytes()
            if b"\r" in data:
                raise ValueError(f"请保持 LF 换行: {relative}")
            info = zipfile.ZipInfo("qq-guard/" + relative, (2026, 9, 29, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100644 << 16)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    checksum = destination.with_suffix(".zip.sha256")
    checksum.write_text(f"{digest}  {destination.name}\n", encoding="utf-8")
    print(f"已生成 {destination.name}，包含 {len(FILES)} 个源码/文档/测试文件。")
    print(f"SHA256: {digest}")


if __name__ == "__main__":
    main()
