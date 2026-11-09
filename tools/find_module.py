#!/usr/bin/env python3
"""Find Metro factories using a cached, conservative static evidence index."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hbc import HbcFile, writes_register

INDEX_VERSION = 2
DEFAULT_CACHE = Path(__file__).resolve().parents[1] / 'work' / 'module-index.sqlite'


def analyze_function(h: HbcFile, index: int, *, factory: bool = False) -> dict:
    """Track straight-line aliases; unknown values are killed, never executed.

    Export evidence requires the Metro module/exports parameter, an alias, or
    an object explicitly assigned to module.exports. Other writes stay separate.
    This is candidate discovery, not a complete JavaScript abstract interpreter.
    """
    regs, children, evidence, object_writes = {}, set(), [], []
    exported_objects = set()
    exports = ('exports',)
    module = ('module',)
    frame = h.functions[index].frame_size

    def add(kind, text, offset):
        evidence.append((kind, text, index, offset))

    def arguments(ins):
        if ins.name in ('Call1', 'Call2', 'Call3', 'Call4'):
            return [regs.get(r) for r in ins.args[2:]]
        if ins.name in ('Call', 'Construct'):
            return [regs.get(frame - 7 - j) for j in range(ins.args[2])]
        return []

    for ins in h.instructions(index):
        n, a, off = ins.name, ins.args, ins.offset
        value = None
        for pos, kind in ins.ids.items():
            if kind == 'string':
                sid = a[pos]
                if not 0 <= sid < len(h.strings):
                    raise ValueError(f'Invalid string ID {sid} in function {index} at {off}')
                text = h.strings[sid]
                add('literal' if n.startswith('LoadConstString') else 'property', text, off)
        if n.startswith(('CreateClosure', 'CreateGenerator', 'CreateBaseClass', 'CreateDerivedClass')):
            children.add(a[-1])
            value = ('function', a[-1])
        elif n.startswith('LoadParam') and factory:
            value = {5: module, 6: exports}.get(a[1])
        elif n in ('Mov', 'MovLong'):
            value = regs.get(a[1])
        elif n.startswith('LoadConstString'):
            value = ('string', h.strings[a[1]])
        elif n == 'GetGlobalObject':
            value = ('global',)
        elif n.startswith(('GetById', 'TryGetById')):
            source, prop = regs.get(a[1]), h.strings[a[-1]]
            if source == module and prop == 'exports':
                value = exports
            elif source == ('global',) and prop == 'Object':
                value = ('Object',)
            elif source == ('Object',) and prop == 'defineProperty':
                value = ('defineProperty',)
        elif n.startswith(('NewObject', 'NewArray')):
            value = ('object', index, off)
            if n.startswith('NewObjectWithBuffer'):
                shape_index, value_offset = a[-2:]
                shape, = h.unpack('<I', h.sections['object_shapes'][0] + shape_index * 8)
                count, = h.unpack('<I', h.sections['object_shapes'][0] + shape_index * 8 + 4)
                keys = h.literals('object_keys', shape, count)
                for key in keys:
                    if isinstance(key, tuple) and key[0] == 'string':
                        text = h.strings[key[1]]
                        add('write', text, off)
                        object_writes.append((value, text, off))
                for lit in h.literals('literal_values', value_offset, count):
                    if isinstance(lit, tuple) and lit[0] == 'string':
                        add('literal', h.strings[lit[1]], off)
        if n in ('DefineOwnByVal', 'DefineOwnGetterSetterByVal', 'PutOwnGetterSetterByVal'):
            key_register = a[1] if 'GetterSetter' in n else a[2]
            key = regs.get(key_register)
            if key and key[0] == 'string':
                add('write', key[1], off)
                object_writes.append((regs.get(a[0]), key[1], off))
                if regs.get(a[0]) == exports:
                    add('export', key[1], off)
        if n.startswith(('PutById', 'PutNewOwn', 'TryPutById', 'DefineOwnById')) and 'ById' in n:
            obj, source, prop = regs.get(a[0]), regs.get(a[1]), h.strings[a[-1]]
            add('write', prop, off)
            object_writes.append((obj, prop, off))
            if obj == exports:
                add('export', prop, off)
            elif obj == module and prop == 'exports' and source is not None:
                exported_objects.add(source)
                add('export', 'exports', off)
        if n.startswith('Call') and len(a) > 1 and regs.get(a[1]) == ('defineProperty',):
            args = arguments(ins)
            if len(args) >= 3 and args[1] == exports and args[2] and args[2][0] == 'string':
                add('export', args[2][1], off)
        if writes_register(ins):
            regs[a[0]] = value
    for obj, prop, off in object_writes:
        if obj in exported_objects:
            add('export', prop, off)
    return {'children': sorted(children), 'evidence': evidence}


def build_index(h: HbcFile, cache: Path = DEFAULT_CACHE) -> sqlite3.Connection:
    digest = hashlib.sha256(h.data).hexdigest()
    cache.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(cache)
    db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)')
    metadata = dict(db.execute('SELECT key, value FROM metadata'))
    if metadata == {'sha256': digest, 'schema': str(INDEX_VERSION)}:
        return db
    print('Building static module index (no bundle code is executed)...', file=sys.stderr)
    db.executescript('DROP TABLE IF EXISTS modules; DROP TABLE IF EXISTS evidence; '
                     'CREATE TABLE modules (id INTEGER PRIMARY KEY, factory INTEGER, functions TEXT); '
                     'CREATE TABLE evidence (module INTEGER, kind TEXT, text TEXT, function INTEGER, offset INTEGER); '
                     'DELETE FROM metadata;')
    modules = h.modules()
    factory_ids = {m['factory'] for m in modules.values()}
    analyses = [analyze_function(h, i, factory=i in factory_ids) for i in range(len(h.functions))]
    skipped_surrogate_evidence = 0
    for mid, m in modules.items():
        pending, visited, rows = [m['factory']], set(), set()
        while pending:
            f = pending.pop()
            if f in visited:
                continue
            visited.add(f)
            analysis = analyses[f]
            pending.extend(analysis['children'])
            for kind, text, function, offset in analysis['evidence']:
                if any('\ud800' <= char <= '\udfff' for char in text):
                    skipped_surrogate_evidence += 1
                    continue
                rows.add((mid, kind, text, function, offset))
        db.execute('INSERT INTO modules VALUES (?, ?, ?)', (mid, m['factory'], json.dumps(sorted(visited))))
        # Distinct source locations remain available for independent verification.
        db.executemany('INSERT INTO evidence VALUES (?, ?, ?, ?, ?)', sorted(rows))
    if skipped_surrogate_evidence:
        print(f'Warning: skipped {skipped_surrogate_evidence} evidence entries containing '
              'Unicode surrogates (SQLite TEXT cannot encode them).', file=sys.stderr)
    db.execute('CREATE INDEX evidence_text ON evidence(text, kind)')
    db.execute('CREATE INDEX evidence_module ON evidence(module, kind)')
    db.executemany('INSERT INTO metadata VALUES (?, ?)', [('sha256', digest), ('schema', str(INDEX_VERSION))])
    db.commit()
    return db


def search(db, terms, *, kind='any', exact=False, limit=20):
    results = {}
    kinds = {'string': ['literal'], 'export': ['export'], 'property': ['property', 'write'],
             'name': ['literal', 'write'], 'any': ['literal', 'export', 'write', 'property']}[kind]
    for term in terms:
        sql = ('SELECT module,kind,text,function,offset FROM evidence WHERE kind IN ('
               + ','.join('?' for _ in kinds) + ') AND text ' + ('= ?' if exact else 'LIKE ? ESCAPE \'\\\''))
        escaped = term.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        sql += ' ORDER BY module,kind,text,function,offset'
        for mid, k, text, f, off in db.execute(sql, [*kinds, term if exact else '%' + escaped + '%']):
            r = results.setdefault(mid, {'id': mid, 'score': 0, 'matched': {}, 'evidence': []})
            weight = {'export': 6, 'write': 3, 'literal': 2, 'property': 1}[k]
            previous = r['matched'].get(term, 0)
            r['score'] += max(weight - previous, 0)
            r['matched'][term] = max(previous, weight)
            if len(r['evidence']) < 30:
                r['evidence'].append(dict(kind=k, text=text, function=f, offset=off))
    output = []
    for r in results.values():
        r['matched'] = sorted(r['matched'])
        r['confidence'] = 'high' if r['score'] >= 6 else 'medium' if r['score'] >= 3 else 'low'
        r['verified'] = False  # Ranking is static evidence, not runtime shape verification.
        r['factory'] = db.execute('SELECT factory FROM modules WHERE id=?', (r['id'],)).fetchone()[0]
        output.append(r)
    return sorted(output, key=lambda r: (-len(r['matched']), -r['score'], r['id']))[:limit]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('bundle')
    p.add_argument('terms', nargs='+')
    p.add_argument('--kind', choices=['any', 'string', 'export', 'property', 'name'], default='any')
    p.add_argument('--exact', action='store_true')
    p.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    p.add_argument('--limit', type=int, default=20)
    args = p.parse_args()
    h = HbcFile(args.bundle)
    with build_index(h, args.cache) as db:
        print(json.dumps(search(db, args.terms, kind=args.kind, exact=args.exact, limit=args.limit), indent=2))


if __name__ == '__main__':
    main()
