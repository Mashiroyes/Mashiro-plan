"""QQ-family identities shared by installed-app and downloaded-APK checks."""
PRIMARY_PACKAGE = "com.tencent.mobileqq"
KNOWN_PACKAGES = frozenset({PRIMARY_PACKAGE, "com.tencent.tim", "com.tencent.qqlite", "com.tencent.minihd.qq"})


def restricted_package(package):
    if not isinstance(package, str):
        return False
    # QQ International and common vendor/repackage suffixes; never match
    # com.tencent.mm (WeChat) or the complete com.tencent namespace.
    return package in KNOWN_PACKAGES or package.startswith(PRIMARY_PACKAGE) or any(
        package.startswith(base + ".") for base in KNOWN_PACKAGES)
