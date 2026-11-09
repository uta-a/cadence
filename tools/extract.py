#!/usr/bin/env python3
"""Extract selected data files from an APKM, split APK directory, or base APK."""
from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import zipfile

MAX_FILE_SIZE = 1024 * 1024 * 1024


def manifest_version(raw: bytes) -> str | None:
    """Read a literal versionName from Android's binary XML string pool."""
    def u16(p):
        return struct.unpack_from('<H', raw, p)[0]

    def u32(p):
        return struct.unpack_from('<I', raw, p)[0]

    strings = []
    p = u16(2)
    while p + 8 <= len(raw):
        kind, header, size = struct.unpack_from('<HHI', raw, p)
        if size < header or size < 8 or p + size > len(raw):
            raise ValueError('Invalid binary XML chunk')
        if kind == 1:
            count, _, flags, start, _ = struct.unpack_from('<5I', raw, p + 8)
            if header + count * 4 > size:
                raise ValueError('Invalid string pool')
            strings = []
            for i in range(count):
                q = p + start + u32(p + header + i * 4)
                if flags & 256:
                    # Both UTF-16 character length and UTF-8 byte length precede data.
                    if raw[q] & 128:
                        q += 2
                    else:
                        q += 1
                    n = raw[q]
                    q += 1
                    if n & 128:
                        n = ((n & 127) << 8) | raw[q]
                        q += 1
                    strings.append(raw[q:q + n].decode('utf-8'))
                else:
                    n = u16(q)
                    q += 2
                    if n & 32768:
                        n = ((n & 32767) << 16) | u16(q)
                        q += 2
                    strings.append(raw[q:q + n * 2].decode('utf-16-le'))
        elif kind == 0x102:
            attr_start, attr_size, attr_count = struct.unpack_from('<3H', raw, p + 24)
            if attr_size < 20 or 16 + attr_start + attr_count * attr_size > size:
                raise ValueError('Invalid XML attributes')
            for i in range(attr_count):
                q = p + 16 + attr_start + i * attr_size
                _, name, literal = struct.unpack_from('<3I', raw, q)
                if name < len(strings) and strings[name] == 'versionName':
                    if literal < len(strings):
                        return strings[literal]
                    if raw[q + 15] == 3:
                        return strings[u32(q + 16)]
        p += size
    return None


def apk_version(apk: Path) -> str | None:
    with zipfile.ZipFile(apk) as z:
        try:
            info = z.getinfo('AndroidManifest.xml')
            if info.file_size > 16 * 1024 * 1024:
                raise ValueError('Manifest too large')
            version = manifest_version(z.read(info))
            if version:
                return version
        except (KeyError, ValueError, IndexError, struct.error, UnicodeError):
            pass
    home = os.environ.get('ANDROID_HOME')
    if home:
        for tool in sorted((Path(home) / 'build-tools').glob('*/aapt2'), reverse=True):
            result = subprocess.run([str(tool), 'dump', 'badging', str(apk)], capture_output=True,
                                    text=True, timeout=30, check=False)
            match = re.search(r"versionName='([^']+)'", result.stdout)
            if match:
                return match[1]
    return None


def copy_member(z: zipfile.ZipFile, name: str, target: Path):
    info = z.getinfo(name)
    if info.file_size > MAX_FILE_SIZE:
        raise ValueError(f'Refusing oversized ZIP entry: {name}')
    target.parent.mkdir(parents=True, exist_ok=True)
    with z.open(info) as source, target.open('wb') as dest:
        shutil.copyfileobj(source, dest)


def extract(source: Path, out: Path | None, version: str | None) -> dict:
    # Never extractall: archive paths cannot choose output paths or executable files.
    if source.is_dir():
        source = source / 'base.apk'
    if not source.is_file():
        raise ValueError(f'Input not found: {source}')
    if source.suffix.lower() == '.apkm':
        with zipfile.ZipFile(source) as z:
            names = [n for n in z.namelist() if Path(n).name == 'base.apk']
            if len(names) != 1:
                raise ValueError('APKM must contain exactly one base.apk')
            info = z.getinfo(names[0])
            if info.file_size > MAX_FILE_SIZE:
                raise ValueError('Base APK too large')
            apk_data = z.read(info)
        with zipfile.ZipFile(io.BytesIO(apk_data)) as z:
            try:
                detected = manifest_version(z.read('AndroidManifest.xml'))
            except (KeyError, ValueError, IndexError, struct.error, UnicodeError):
                detected = None
        version = detected if version is None else version
    else:
        apk_data = None
        version = apk_version(source) if version is None else version
    if version is None:
        raise ValueError('Cannot read versionName; provide --version')
    safe_version = re.sub(r'[^A-Za-z0-9._-]', '_', version.split(' - ')[0])
    if safe_version in ('', '.', '..'):
        raise ValueError('Unsafe version for output directory')
    if out is None:
        out = Path('work') / safe_version
        if not out.resolve().is_relative_to(Path.cwd() / 'work'):
            raise ValueError('Default output directory escapes work')
    out.mkdir(parents=True, exist_ok=True)
    target = out / 'base.apk'
    if apk_data is not None:
        target.write_bytes(apk_data)
    elif target.resolve() != source.resolve():
        shutil.copyfile(source, target)
    with zipfile.ZipFile(target) as z:
        names = ['assets/index.android.bundle']
        names += sorted(n for n in z.namelist() if re.fullmatch(r'classes(?:[2-9]|[1-9][0-9]+)?\.dex', n))
        for name in names:
            copy_member(z, name, out / name)
    metadata = {'version': version, 'source': str(source.resolve()), 'files': ['base.apk', *names]}
    (out / 'extraction.json').write_text(json.dumps(metadata, indent=2) + '\n')
    return {'out': str(out), **metadata}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source', type=Path)
    p.add_argument('--out', type=Path)
    p.add_argument('--version')
    args = p.parse_args()
    print(json.dumps(extract(args.source, args.out, args.version), indent=2))


if __name__ == '__main__':
    main()
