#!/usr/bin/env python3
"""Open a hidden-input GLM key dialog, validate the key, and save it privately."""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import platform
import re
import ssl
import subprocess
import sys
from typing import Dict
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
DEFAULT_MODEL = "glm-5.3"
MANAGED_KEYS = {"ZHIPU_API_KEY", "ZHIPU_MODEL", "ZHIPU_BASE_URL"}


def credentials_path() -> Path:
    configured = os.environ.get("MATH_AI_SECRETS_FILE", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".config" / "math-ai" / "credentials.env"


def prompt_key() -> str:
    if platform.system() == "Darwin" and subprocess.run(
        ["/usr/bin/which", "osascript"], capture_output=True, check=False
    ).returncode == 0:
        script = '''
set dialogResult to display dialog "请输入智谱 GLM API Key。密钥将先做最小请求验证，再保存到本机私密配置；不会显示在终端或写入项目源码。" default answer "" with hidden answer buttons {"取消", "保存并验证"} default button "保存并验证" cancel button "取消" with title "MathSight - 配置 GLM"
return text returned of dialogResult
'''
        result = subprocess.run(
            ["osascript", "-e", script], capture_output=True, text=True, check=False
        )
        if result.returncode != 0:
            raise KeyboardInterrupt
        return result.stdout.rstrip("\r\n")
    return getpass.getpass("GLM API Key: ").strip()


def read_credentials(path: Path) -> Dict[str, str]:
    if not path.exists():
        return {}
    values: Dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1].replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
        values[name.strip()] = value
    return values


def https_context() -> ssl.SSLContext:
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def validate_key(key: str, model: str, base_url: str, timeout: int) -> None:
    request_payload = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 32,
    }
    if model.casefold().startswith(("glm-4.7", "glm-5")):
        request_payload["thinking"] = {"type": "disabled"}
    body = json.dumps(request_payload).encode("utf-8")
    request = Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=timeout, context=https_context()) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"GLM validation failed: HTTP {exc.code} - {detail}") from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(f"GLM validation failed: {exc}") from exc

    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not choices:
        raise RuntimeError("GLM validation failed: response contained no choices")


def dotenv_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def update_credentials(path: Path, values: Dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    old_lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    kept = []
    pattern = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")
    for line in old_lines:
        match = pattern.match(line)
        if match and match.group(1) in MANAGED_KEYS:
            continue
        kept.append(line)
    if kept and kept[-1].strip():
        kept.append("")
    kept.append("# MathSight GLM provider - managed by build-knowledge-relations")
    for name in ("ZHIPU_API_KEY", "ZHIPU_MODEL", "ZHIPU_BASE_URL"):
        kept.append(f"{name}={dotenv_quote(values[name])}")
    content = "\n".join(kept).rstrip() + "\n"

    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content, encoding="utf-8")
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, path)
    os.chmod(path, 0o600)


def mask_key(key: str) -> str:
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}…{key[-4:]}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=os.environ.get("ZHIPU_MODEL", DEFAULT_MODEL))
    parser.add_argument("--base-url", default=os.environ.get("ZHIPU_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="Save without a live request. Use only when network validation is impossible.",
    )
    parser.add_argument(
        "--reuse-saved-key",
        action="store_true",
        help="Revalidate the private key already on disk and update its model without opening a dialog.",
    )
    args = parser.parse_args()

    target = credentials_path()
    if args.reuse_saved_key:
        saved = read_credentials(target)
        key = (saved.get("ZHIPU_API_KEY") or saved.get("BIGMODEL_API_KEY") or "").strip()
        if not key:
            print(f"No saved GLM key found in {target}.", file=sys.stderr)
            return 2
    else:
        try:
            key = prompt_key().strip()
        except KeyboardInterrupt:
            print("Configuration cancelled.")
            return 130
    if not key:
        print("No key entered; nothing was saved.", file=sys.stderr)
        return 2

    if not args.skip_validation:
        print(f"Validating GLM model {args.model}…")
        try:
            validate_key(key, args.model, args.base_url, args.timeout)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            print("The key was not saved.", file=sys.stderr)
            return 1

    update_credentials(
        target,
        {
            "ZHIPU_API_KEY": key,
            "ZHIPU_MODEL": args.model,
            "ZHIPU_BASE_URL": args.base_url,
        },
    )
    print(f"GLM configured: {mask_key(key)}")
    print(f"Saved to {target} with permissions 0600.")
    print("Restart any running MathSight server before using the new key.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
