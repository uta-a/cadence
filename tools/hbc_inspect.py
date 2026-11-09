#!/usr/bin/env python3
"""Inspect HBC98 without executing it."""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hbc import HbcFile


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('bundle')
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('header')
    sub.add_parser('global')
    s = sub.add_parser('strings')
    s.add_argument('--grep', default='')
    s = sub.add_parser('string-id')
    s.add_argument('string')
    s = sub.add_parser('func')
    s.add_argument('index', type=int)
    s.add_argument('--disasm', action='store_true')
    s = sub.add_parser('modules')
    s.add_argument('--id', type=int)
    args = p.parse_args()
    h = HbcFile(args.bundle)
    if args.command == 'header':
        result = {**h.header, 'footer_sha1_valid': h.footer_valid, 'sections': h.sections}
    elif args.command == 'global':
        result = h.global_info()
    elif args.command == 'strings':
        pattern = re.compile(args.grep, re.I)
        result = {i: s for i, s in enumerate(h.strings) if pattern.search(s)}
    elif args.command == 'string-id':
        result = [i for i, s in enumerate(h.strings) if s == args.string]
    elif args.command == 'modules':
        modules = h.modules()
        result = {'count': len(modules), 'modules': modules if args.id is None else {args.id: modules[args.id]}}
    else:
        result = asdict(h.functions[args.index])
        if args.disasm:
            print(json.dumps(result, indent=2))
            print('\n'.join(h.disassemble(args.index)))
            return
    print(json.dumps(result, indent=2, ensure_ascii=True))


if __name__ == '__main__':
    main()
