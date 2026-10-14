"""Read QQ APK identity without executing it or trusting its filename."""
from pathlib import Path
import io
import os
import stat
import struct
import zipfile
import xml.etree.ElementTree as ET
from policy import PRIMARY_PACKAGE, restricted_package

PACKAGE = PRIMARY_PACKAGE
MAX_MANIFEST = 2 * 1024 * 1024
MAX_NESTED_APK = 64 * 1024 * 1024


def manifest_package(data):
    if len(data) > MAX_MANIFEST:
        raise ValueError("manifest too large")
    if data.lstrip().startswith(b"<"):
        root = ET.fromstring(data)
        return root.attrib.get("package") if root.tag == "manifest" else None
    if len(data) < 8 or struct.unpack_from("<H", data)[0] != 3:
        raise ValueError("not Android binary XML")
    total = struct.unpack_from("<I", data, 4)[0]
    if total != len(data):
        raise ValueError("invalid XML length")
    strings = []
    offset = struct.unpack_from("<H", data, 2)[0]

    def length(pos, wide):
        if wide:
            value = struct.unpack_from("<H", data, pos)[0]
            if value & 0x8000:
                return ((value & 0x7fff) << 16) | struct.unpack_from("<H", data, pos + 2)[0], pos + 4
            return value, pos + 2
        value = data[pos]
        return (((value & 0x7f) << 8) | data[pos + 1], pos + 2) if value & 0x80 else (value, pos + 1)

    while offset + 8 <= total:
        kind, header, size = struct.unpack_from("<HHI", data, offset)
        if header < 8 or size < header or offset + size > total:
            raise ValueError("invalid XML chunk")
        if kind == 1:
            if header < 28:
                raise ValueError("invalid string pool")
            count, styles, flags, start, _ = struct.unpack_from("<IIIII", data, offset + 8)
            if count > 65536 or header + 4 * (count + styles) > size:
                raise ValueError("invalid string table")
            for index in range(count):
                relative = struct.unpack_from("<I", data, offset + header + index * 4)[0]
                pos = offset + start + relative
                if not offset + header <= pos < offset + size:
                    raise ValueError("invalid string offset")
                if flags & 0x100:
                    _, pos = length(pos, False)
                    size_chars, pos = length(pos, False)
                    end = pos + size_chars
                    encoding = "utf-8"
                else:
                    size_chars, pos = length(pos, True)
                    end = pos + size_chars * 2
                    encoding = "utf-16le"
                if end >= offset + size:
                    raise ValueError("truncated string")
                strings.append(data[pos:end].decode(encoding))
        elif kind == 0x102:
            if header < 16 or size < header + 20:
                raise ValueError("invalid start element")
            ext = offset + header
            _, name, attr_start, attr_size, count = struct.unpack_from("<IIHHH", data, ext)
            if name >= len(strings):
                raise ValueError("invalid element name")
            if strings[name] == "manifest":
                if attr_size < 20 or attr_start < 20 or ext + attr_start + attr_size * count > offset + size:
                    raise ValueError("invalid attributes")
                for index in range(count):
                    pos = ext + attr_start + index * attr_size
                    _, attr_name, raw, _, _, dtype, value = struct.unpack_from("<IIIHBBI", data, pos)
                    if attr_name >= len(strings):
                        raise ValueError("invalid attribute name")
                    if strings[attr_name] == "package":
                        index = raw if raw != 0xffffffff else value if dtype == 3 else 0xffffffff
                        return strings[index] if index < len(strings) else None
                return None
        offset += size
    return None


def read_manifest(archive):
    entry = archive.getinfo("AndroidManifest.xml")
    if entry.file_size > MAX_MANIFEST:
        raise ValueError("manifest too large")
    return manifest_package(archive.read(entry))


def is_qq_package(file, suffix):
    with zipfile.ZipFile(file) as archive:
        if suffix == ".apk":
            return restricted_package(read_manifest(archive))
        # Delete a container only when every enclosed APK is in the QQ family.
        entries = [entry for entry in archive.infolist() if entry.filename.lower().endswith(".apk")]
        if not entries or len(entries) > 64:
            return False
        for entry in entries:
            if entry.file_size > MAX_NESTED_APK:
                return False
            with zipfile.ZipFile(io.BytesIO(archive.read(entry))) as nested:
                if not restricted_package(read_manifest(nested)):
                    return False
        return True


def scan_downloads(roots, limit=None):
    """Only immediate files in explicit directories; never traverse symlinks."""
    deleted, errors = [], []
    inspected = 0
    for root in roots:
        root = Path(root)
        # Android /sdcard itself is a symlink; installer uses /storage/emulated/0.
        if root.is_symlink() or not root.exists():
            continue
        for path in root.iterdir():
            suffix = path.suffix.lower()
            if suffix not in {".apk", ".apks", ".xapk"}:
                continue
            inspected += 1
            if limit is not None and inspected > limit:
                errors.append("扫描数量超出限制，请清理下载目录")
                return deleted, errors
            try:
                before = path.lstat()
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                    continue
                descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(descriptor, "rb") as file:
                    opened = os.fstat(file.fileno())
                    if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                        continue
                    matched = is_qq_package(file, suffix)
                after = path.lstat()
                if matched and (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (
                        before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
                    path.unlink()
                    deleted.append(str(path))
            except (OSError, ValueError, KeyError, IndexError, struct.error, UnicodeError, zipfile.BadZipFile, ET.ParseError) as error:
                errors.append(f"保留 {path.name}: {error}")
    return deleted, errors
