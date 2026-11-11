#!/usr/bin/env python3
"""Stage a checked disk bundle locally. Never create a tag, push, upload or publish."""
import argparse
from datetime import datetime, timezone
from email.parser import Parser
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")


def validate_bundle(mpp: Path, version: str):
    with zipfile.ZipFile(mpp) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate bundle entries")
        for required in ("classes.dex", "disk/runtime.js", "disk/build-info.json", "META-INF/MANIFEST.MF"):
            if required not in names:
                raise ValueError("Required bundle entry missing: " + required)
        if not archive.read("classes.dex").startswith(b"dex\n"):
            raise ValueError("Invalid classes.dex")
        info = json.loads(archive.read("disk/build-info.json"))
        if not isinstance(info, dict) or info.get("schema") != 1 or info.get("hbcVersion") != 98 or info.get("uiSmoke") is not False:
            raise ValueError("Not a normal HBC98 bundle; rebuild with DISK_UI_SMOKE=0")
        # The JAR manifest wraps continuation lines at 72 bytes.
        manifest = archive.read("META-INF/MANIFEST.MF").decode("utf-8").replace("\r\n", "\n").replace("\n ", "")
        fields = Parser().parsestr(manifest)
        if fields.get("Name") != "disk" or fields.get("Version") != version:
            raise ValueError("Bundle name/version does not match the release")
        if not archive.read("disk/runtime.js").strip():
            raise ValueError("Empty runtime")


def stage(mpp: Path, out: Path, version: str, repository: str, notes: str, created_at: str | None = None):
    if not VERSION.fullmatch(version) or not REPOSITORY.fullmatch(repository):
        raise ValueError("Invalid version or owner/repository")
    if any(part in (".", "..") for part in repository.split("/")):
        raise ValueError("Invalid repository")
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise ValueError("Output must be an empty directory")
    validate_bundle(mpp, version)
    # Read all repository files before creating output, so missing inputs cannot yield a plausible release.
    extra = {name: (ROOT / name).read_bytes() for name in ("patches-list.json", "LICENSE", "NOTICE", "CHANGELOG.md")}
    patch_list = json.loads(extra["patches-list.json"])
    if not isinstance(patch_list, dict) or patch_list.get("version") != version or not patch_list.get("patches"):
        raise ValueError("Invalid patch list or mismatched patch-list version")
    created = created_at or datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")
    datetime.fromisoformat(created)
    filename = f"patches-{version}.mpp"
    metadata = {"created_at": created, "description": notes,
                "download_url": f"https://github.com/{repository}/releases/download/v{version}/{filename}",
                "signature_download_url": "", "version": version, "public_key": ""}
    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(mpp, out / filename)
    for name, content in extra.items():
        (out / name).write_bytes(content)
    (out / "patches-bundle.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # Checksums are corruption checks, NOT a cryptographic signature or proof of origin.
    hashes = [f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}" for path in sorted(out.iterdir())]
    (out / "SHA256SUMS").write_text("\n".join(hashes) + "\n", encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mpp", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", default="uta-a/disk")
    parser.add_argument("--notes", type=Path, required=True, help="UTF-8 release notes (no upload)")
    args = parser.parse_args()
    try:
        stage(args.mpp, args.out, args.version, args.repository, args.notes.read_text(encoding="utf-8"))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Release staging rejected: {error}\n")
    print(f"Staged locally: {args.out}. Nothing was published.")


if __name__ == "__main__":
    main()
