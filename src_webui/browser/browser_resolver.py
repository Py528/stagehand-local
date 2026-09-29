import os
import sys
import platform
import shutil
import logging
import socket
from pathlib import Path
from typing import Tuple, Optional, List

logger = logging.getLogger(__name__)

KNOWN_BROWSERS = {
    "darwin": [
        {
            "name": "Google Chrome",
            "binary": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "user_data": "~/Library/Application Support/Google/Chrome"
        },
        {
            "name": "Arc",
            "binary": "/Applications/Arc.app/Contents/MacOS/Arc",
            "user_data": "~/Library/Application Support/Arc/User Data"
        },
        {
            "name": "Brave",
            "binary": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "user_data": "~/Library/Application Support/BraveSoftware/Brave-Browser"
        },
        {
            "name": "Microsoft Edge",
            "binary": "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "user_data": "~/Library/Application Support/Microsoft Edge"
        },
        {
            "name": "Chromium",
            "binary": "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "user_data": "~/Library/Application Support/Chromium"
        }
    ],
    "linux": [
        {
            "name": "Google Chrome",
            "binary": "/usr/bin/google-chrome",
            "user_data": "~/.config/google-chrome"
        },
        {
            "name": "Google Chrome Stable",
            "binary": "/usr/bin/google-chrome-stable",
            "user_data": "~/.config/google-chrome"
        },
        {
            "name": "Chromium",
            "binary": "/usr/bin/chromium-browser",
            "user_data": "~/.config/chromium"
        },
        {
            "name": "Brave",
            "binary": "/usr/bin/brave-browser",
            "user_data": "~/.config/BraveSoftware/Brave-Browser"
        }
    ],
    "windows": [
        {
            "name": "Google Chrome",
            "binary": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            "user_data": r"~\AppData\Local\Google\Chrome\User Data"
        },
        {
            "name": "Google Chrome (x86)",
            "binary": r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            "user_data": r"~\AppData\Local\Google\Chrome\User Data"
        },
        {
            "name": "Microsoft Edge",
            "binary": r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            "user_data": r"~\AppData\Local\Microsoft\Edge\User Data"
        },
        {
            "name": "Brave",
            "binary": r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
            "user_data": r"~\AppData\Local\BraveSoftware\Brave-Browser\User Data"
        }
    ]
}

def is_cdp_port_active(host: str = "127.0.0.1", port: int = 9222) -> bool:
    """Check if Chrome DevTools Protocol port is open and listening."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False

def detect_default_browser() -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Detects the installed default browser binary path and user data dir.
    Returns: (browser_name, binary_path, user_data_dir)
    """
    os_name = platform.system().lower()
    browsers = KNOWN_BROWSERS.get(os_name, KNOWN_BROWSERS.get("darwin", []))

    for b in browsers:
        bin_path = os.path.expanduser(b["binary"])
        data_path = os.path.expanduser(b["user_data"])
        if os.path.exists(bin_path):
            return b["name"], bin_path, data_path if os.path.exists(data_path) else None

    if os_name != "windows":
        for cmd in ["google-chrome", "google-chrome-stable", "chromium", "brave"]:
            bin_path = shutil.which(cmd)
            if bin_path:
                return cmd, bin_path, None

    return None, None, None

def prepare_session_user_data_dir(source_user_data_dir: str) -> str:
    """
    Creates or updates an automation profile cloned from the user's browser profile.
    This copies cookies, local storage, sessions, and credentials without locking
    or interfering with the user's running browser instance.
    """
    src_dir = Path(os.path.expanduser(source_user_data_dir))
    if not src_dir.exists():
        return source_user_data_dir

    target_dir = Path(os.path.expanduser("~/.config/browseruse/profiles/my_browser_session"))
    target_dir.mkdir(parents=True, exist_ok=True)

    # 1. Copy Local State (crucial for decrypting cookies/credentials on macOS/Windows/Linux)
    local_state_src = src_dir / "Local State"
    if local_state_src.exists():
        try:
            shutil.copy2(local_state_src, target_dir / "Local State")
        except Exception as e:
            logger.debug(f"Could not copy Local State: {e}")

    # 2. Sync profile directories (Default or primary profile)
    for profile_name in ["Default", "Profile 1"]:
        src_profile = src_dir / profile_name
        if not src_profile.exists() and profile_name == "Default":
            src_profile = src_dir

        if not src_profile.exists():
            continue

        target_profile = target_dir / profile_name
        target_profile.mkdir(parents=True, exist_ok=True)

        # Critical single files for auth & sessions
        critical_files = [
            "Cookies", "Login Data", "Web Data",
            "Preferences", "Secure Preferences",
            "Network Persistent State"
        ]
        for f in critical_files:
            sf = src_profile / f
            if sf.exists():
                try:
                    shutil.copy2(sf, target_profile / f)
                except Exception as e:
                    logger.debug(f"Could not copy {f}: {e}")

        # Directory structures for cookies & storage
        for folder in ["Network", "Local Storage", "Sessions", "Session Storage"]:
            sf = src_profile / folder
            if sf.exists():
                df = target_profile / folder
                try:
                    shutil.copytree(sf, df, dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.lock", "*.tmp", "*SingletonLock*"))
                except Exception as e:
                    logger.debug(f"Could not copy folder {folder}: {e}")

    # Remove any stray SingletonLock in the target directory
    for lock in target_dir.glob("**/SingletonLock"):
        try:
            lock.unlink()
        except Exception:
            pass

    logger.info(f"✅ Synchronized browser session into: {target_dir}")
    return str(target_dir)

def resolve_browser_configuration(
    use_own_browser: bool,
    configured_binary: Optional[str] = None,
    configured_user_data: Optional[str] = None,
    configured_cdp: Optional[str] = None,
    debug_port: int = 9222
) -> Tuple[Optional[str], Optional[str], Optional[str], List[str]]:
    """
    Resolves the exact browser binary, user data dir, cdp_url, and extra_args.
    Returns: (browser_binary_path, user_data_dir, cdp_url, extra_args)
    """
    if not use_own_browser:
        return None, None, configured_cdp, []

    # 1. If CDP port is already open or configured, reuse running browser directly
    if configured_cdp:
        return None, None, configured_cdp, []

    if is_cdp_port_active("127.0.0.1", debug_port):
        cdp_url = f"http://127.0.0.1:{debug_port}"
        logger.info(f"🔌 Detected active browser debugging session on {cdp_url}. Connecting directly!")
        return None, None, cdp_url, []

    # 2. Resolve Binary Path
    binary = configured_binary or os.getenv("BROWSER_PATH") or None
    user_data = configured_user_data or os.getenv("BROWSER_USER_DATA") or None

    detected_name, detected_bin, detected_data = detect_default_browser()

    if not binary and detected_bin:
        binary = detected_bin
        logger.info(f"🔍 Auto-detected browser binary: {detected_name} at {binary}")

    if not user_data and detected_data:
        user_data = detected_data
        logger.info(f"🔍 Auto-detected browser user data: {user_data}")

    extra_args = []
    if user_data:
        effective_user_data = prepare_session_user_data_dir(user_data)
        extra_args.append(f"--user-data-dir={effective_user_data}")

    return binary, user_data, None, extra_args
