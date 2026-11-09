"""stdlib self-tests; HERMESC / DISK_BUNDLE enable external integration checks."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
from extract import extract
from find_module import build_index, search
from gen_target import generate
from hbc import HEADER_FIELDS, HbcError, HbcFile, OPCODES, OPERANDS, align4


def seal(data):
    data[-20:] = hashlib.sha1(data[:-20]).digest()
    return data


def sample(*, expanded=False):
    """Hand-built, source-layout fixture with nonzero late header fields."""
    strings = ['global', 'join', 'eval', '', '日本語', '\ud800', 'z' * 256]
    storage, entries, overflow = bytearray(), [], bytearray()
    for text in strings:
        utf16 = not text.isascii()
        raw = text.encode('utf-16-le' if utf16 else 'ascii', errors='surrogatepass')
        length, off = len(raw) // (2 if utf16 else 1), len(storage)
        if length >= 255:
            word = (255 << 24) | ((len(overflow) // 8) << 1) | utf16
            overflow.extend(struct.pack('<II', off, length))
        else:
            word = (length << 24) | (off << 1) | utf16
        entries.append(word)
        storage.extend(raw)
    data = bytearray(128 + 12)
    data.extend(struct.pack('<I', len(strings)))  # One non-identifier run.
    table = len(data)
    data.extend(struct.pack('<7I', *entries))
    data.extend(overflow)
    data.extend(storage)
    data.extend(b'\0' * (align4(len(data)) - len(data)))
    data.extend(struct.pack('<4I', 0, 0, 0, 0))  # CJS and function-source pairs.
    body_offset = len(data)
    ret = next(i for i, op in enumerate(OPCODES) if op['name'] == 'Ret')
    data.extend(bytes([ret, 0]))
    if expanded:
        data.extend(b'\0' * (align4(len(data)) - len(data)))
        info = len(data)
        data.extend(struct.pack('<8I5B', body_offset, 35, 2, 2, 0, 3, 4, 300, 6, 7, 1, 2, 8))
        data.extend(b'\0' * 3)
        data.extend(struct.pack('<4I', 1, 0, 2, 0))
        struct.pack_into('<IIBBBB', data, 128, info & 0xFFFFFF,
                         (info >> 24) << 14, 0, 0, 0, 32)
    else:
        struct.pack_into('<IIBBBB', data, 128, body_offset | (1 << 25) | (2 << 30),
                         2 | (3 << 22) | (4 << 27), 8, 6, 7 | 64 | 128, 4)
    data.extend(b'\0' * (align4(len(data)) - len(data)))
    debug = len(data)
    data.extend(bytes(16 + 20))
    fields = dict.fromkeys(HEADER_FIELDS, 0)
    fields.update(file_length=len(data), function_count=1, string_kind_count=1,
                  string_count=len(strings), overflow_string_count=1,
                  string_storage_size=len(storage), num_string_switch_imms=7,
                  segment_id=9, cjs_module_count=1, function_source_count=1,
                  debug_info_offset=debug)
    struct.pack_into('<QI', data, 0, 0x1F1903C103BC1FC6, 98)
    struct.pack_into('<20I', data, 32, *(fields[k] for k in HEADER_FIELDS))
    data[112] = 3
    return seal(data), table


class HbcTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'sample.hbc'

    def load(self, data, **kwargs):
        self.path.write_bytes(data)
        return HbcFile(self.path, **kwargs)

    def test_header_offsets_and_sections(self):
        h = self.load(sample()[0])
        self.assertEqual(h.header['num_string_switch_imms'], 7)
        self.assertEqual(h.header['segment_id'], 9)
        self.assertEqual(h.header['options'], 3)
        self.assertEqual(h.sections['cjs_modules'][1], 8)
        self.assertEqual(h.sections['function_sources'][1], 8)
        self.assertEqual(sum(h.sections['debug_info']), len(h.data) - 20)
        self.assertTrue(h.footer_valid)

    def test_compact_header(self):
        f = self.load(sample()[0]).functions[0]
        self.assertFalse(f.expanded)
        self.assertEqual((f.param_count, f.loop_depth, f.frame_size), (1, 2, 8))
        self.assertEqual((f.number_regs, f.non_pointer_regs), (3, 4))
        self.assertEqual((f.read_cache, f.write_cache, f.new_object_cache, f.private_name_cache), (6, 7, 1, 1))

    def test_expanded_header_and_exceptions(self):
        f = self.load(sample(expanded=True)[0]).functions[0]
        self.assertTrue(f.expanded)
        self.assertEqual((f.param_count, f.frame_size, f.flags), (35, 300, 8))
        self.assertEqual(f.exceptions, ((0, 2, 0),))
        self.assertEqual((f.number_regs, f.non_pointer_regs), (3, 4))

    def test_strings_and_global_digest(self):
        h = self.load(sample()[0])
        self.assertEqual(h.strings, ['global', 'join', 'eval', '', '日本語', '\ud800', 'z' * 256])
        self.assertEqual(h.global_info()['sha256'], hashlib.sha256(h.body(0)).hexdigest())
        self.assertEqual([i.name for i in h.instructions(0)], ['Ret'])
        self.assertIn('Ret', '\n'.join(h.disassemble(0)))

    def test_generate(self):
        h = self.load(sample()[0])
        text = generate(h, 'test $version')
        for expected in ['JOIN_ID = 1', 'EVAL_ID = 2', 'EMPTY_ID = 3', r'test \$version']:
            self.assertIn(expected, text)
        for version in ['', 'x*/', 'x\n', '日本語']:
            with self.subTest(version=version), self.assertRaises(ValueError):
                generate(h, version)
        h.strings[1] = 'missing'
        with self.assertRaises(ValueError):
            generate(h, 'test')

    def test_reject_bad_header_or_ranges(self):
        original, table = sample()
        mutations = [(0, '<Q', 0), (8, '<I', 97), (32, '<I', 1),
                     (36, '<I', 1), (40, '<I', 0xFFFFFFFF),
                     (44, '<I', 2), (48, '<I', 1),
                     (108, '<I', len(original)),
                     (128, '<I', 0), (table, '<I', 0xFEFFFFFE),
                     (table, '<I', 0xFF000002)]
        for offset, fmt, value in mutations:
            data = bytearray(original)
            struct.pack_into(fmt, data, offset, value)
            with self.subTest(offset=offset, value=value), self.assertRaises(HbcError):
                self.load(seal(data))

    def test_footer_verification_and_truncation(self):
        data = sample()[0]
        data[-1] ^= 1
        with self.assertRaises(HbcError):
            self.load(data)
        h = self.load(data, verify=False)
        self.assertFalse(h.footer_valid)
        with self.assertRaises(ValueError):
            generate(h, 'test')
        for n in [0, 12, 128, len(data) - 1]:
            with self.subTest(n=n), self.assertRaises(HbcError):
                self.load(data[:n])

    def test_bad_expanded_header_and_exception(self):
        data, _ = sample(expanded=True)
        h = self.load(data)
        struct.pack_into('<I', data, h.functions[0].header_offset + 48, 3)
        with self.assertRaises(HbcError):
            self.load(seal(data))
        data, _ = sample(expanded=True)
        struct.pack_into('<I', data, 128, len(data) - 20)
        with self.assertRaises(HbcError):
            self.load(seal(data))

    def test_invalid_instruction(self):
        data, _ = sample()
        h = self.load(data)
        data[h.functions[0].offset] = 255
        h = self.load(seal(data))
        with self.assertRaises(HbcError):
            list(h.instructions(0))

    def test_cli_requires_explicit_version(self):
        self.load(sample()[0])
        run = subprocess.run([sys.executable, str(TOOLS / 'gen_target.py'), str(self.path)], capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertIn('--version is required', run.stderr)

    def test_extract_apk_and_apkm_without_zip_path_traversal(self):
        apk = Path(self.tmp.name) / 'input.apk'
        with zipfile.ZipFile(apk, 'w') as z:
            z.writestr('assets/index.android.bundle', b'fixture')
            z.writestr('classes.dex', b'dex-fixture')
            z.writestr('../escape', b'never extracted')
        for source in [apk, Path(self.tmp.name) / 'input.apkm']:
            if source.suffix == '.apkm':
                with zipfile.ZipFile(source, 'w') as z:
                    z.writestr('../base.apk', apk.read_bytes())
            out = Path(self.tmp.name) / source.suffix[1:]
            metadata = extract(source, out, 'test')
            self.assertEqual(metadata['version'], 'test')
            self.assertEqual((out / 'assets/index.android.bundle').read_bytes(), b'fixture')
            self.assertTrue((out / 'classes.dex').exists())
            self.assertFalse((Path(self.tmp.name) / 'escape').exists())

    def test_extract_default_output_rejects_unsafe_versions_and_symlinks(self):
        root = Path(self.tmp.name)
        apk = root / 'input.apk'
        with zipfile.ZipFile(apk, 'w') as z:
            z.writestr('assets/index.android.bundle', b'fixture')
        sentinel = root / 'base.apk'
        sentinel.write_bytes(b'untouched')
        old_cwd = Path.cwd()
        os.chdir(root)
        try:
            for version in ['', '.', '..', '.. - Stable', ' - Stable']:
                with self.subTest(version=version), self.assertRaises(ValueError):
                    extract(apk, None, version)
            with patch('extract.apk_version', return_value='..'):
                with self.assertRaises(ValueError):
                    extract(apk, None, None)
            outside = root / 'outside'
            outside.mkdir()
            (root / 'work').mkdir()
            (root / 'work' / 'linked').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                extract(apk, None, 'linked')
            self.assertEqual(list(outside.iterdir()), [])
            (root / 'work' / 'linked').unlink()
            (root / 'work').rmdir()
            (root / 'work').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                extract(apk, None, 'normal')
            self.assertEqual(list(outside.iterdir()), [])
            self.assertEqual(sentinel.read_bytes(), b'untouched')
            self.assertEqual(sorted(p.name for p in root.iterdir()),
                             ['base.apk', 'input.apk', 'outside', 'work'])
        finally:
            os.chdir(old_cwd)


@unittest.skipUnless(os.environ.get('HERMES_SOURCE'), 'set HERMES_SOURCE to verify opcode provenance')
class OpcodeSourceTests(unittest.TestCase):
    def test_opcodes98_matches_pinned_hermes_definitions(self):
        source = Path(os.environ['HERMES_SOURCE']) / 'include/hermes/BCGen/HBC/BytecodeList.def'
        text = source.read_text()
        # Ignore comments, directives and macro continuation lines. Expand only
        # this pinned file's three simple jump macros, not arbitrary C++.
        text = re.sub(r'/\*.*?\*/|//[^\n]*', '', text, flags=re.S)
        ops = []
        for line in text.splitlines():
            if not line.startswith(('DEFINE_OPCODE_', 'DEFINE_JUMP_')):
                continue
            match = re.fullmatch(r'DEFINE_OPCODE_\d\(([^)]+)\)', line)
            if match:
                name, *operands = [field.strip() for field in match[1].split(',')]
                ops.append(dict(name=name, operands=operands, ids={}))
            else:
                match = re.fullmatch(r'DEFINE_JUMP_([123])\((\w+)\)', line)
                if match:
                    for suffix, address in [('', 'Addr8'), ('Long', 'Addr32')]:
                        ops.append(dict(name=match[2] + suffix,
                                        operands=[address] + ['Reg8'] * (int(match[1]) - 1), ids={}))
        by_name = {op['name']: op for op in ops}
        for kind, name, number in re.findall(r'^OPERAND_(STRING|FUNCTION|BIGINT)_ID\((\w+), (\d+)\)', text, re.M):
            by_name[name]['ids'][number] = kind.lower()
        # Upstream omits these OPERAND_* annotations, but its comments and
        # interpreter use these operands as IDs. Keep supplements explicit.
        by_name['DefineOwnById']['ids']['4'] = 'string'
        for name in ['CreateBaseClass', 'CreateBaseClassLongIndex',
                     'CreateDerivedClass', 'CreateDerivedClassLongIndex']:
            by_name[name]['ids'][str(len(by_name[name]['operands']))] = 'function'
        table = json.loads((TOOLS / 'opcodes98.json').read_text())
        self.assertEqual(table['source_commit'], '40b4c8d4e22ed2b9af46aba81aec3ca8aa5e169c')
        self.assertEqual(table['opcodes'], ops)


@unittest.skipUnless(os.environ.get('HERMESC'), 'set HERMESC for HBC98 compiler fixtures')
class HermescTests(unittest.TestCase):
    def test_compiler_layouts_and_module_evidence(self):
        compiler = os.environ['HERMESC']
        source = TOOLS / 'tests/fixtures/layout.js'
        with tempfile.TemporaryDirectory() as tmp:
            for flags in [('-O0', '-g0'), ('-O', '-g'), ('-O', '-g', '-fstatic-builtins')]:
                with self.subTest(flags=flags):
                    path = Path(tmp) / 'compiled.hbc'
                    subprocess.run([compiler, *flags, '-emit-binary', str(source), '-out', str(path)], check=True, capture_output=True)
                    h = HbcFile(path)
                    self.assertTrue(h.footer_valid)
                    self.assertIn('日本語', h.strings)
                    self.assertIn('\ud800', h.strings)
                    self.assertIn('😀', h.strings)
                    self.assertIn('a' * 256, h.strings)
                    self.assertGreater(h.header['overflow_string_count'], 0)
                    self.assertTrue(any(f.expanded for f in h.functions))
                    self.assertTrue(any(f.exceptions for f in h.functions))
                    for f in h.functions:
                        instructions = list(h.instructions(f.index))
                        self.assertEqual(sum(1 + OPERANDS[i.opcode].size for i in instructions), f.size)
                    text = generate(h, 'fixture')
                    self.assertIn(f'GLOBAL_OFFSET = {h.functions[0].offset}', text)
                    dump = subprocess.run([compiler, '-dump-bytecode', str(path)], check=True, capture_output=True, text=True).stdout
                    self.assertIn(f'Function count: {len(h.functions)}', dump)
                    self.assertIn(f'String count: {len(h.strings)}', dump)
                    self.assertGreater(h.header['num_string_switch_imms'], 0)
                    modules = h.modules()
                    self.assertEqual(set(modules), {42})
                    self.assertEqual(modules[42]['deps'], [1, 2])
                    stderr = io.StringIO()
                    with contextlib.redirect_stderr(stderr):
                        db = build_index(h, Path(tmp) / 'index.sqlite')
                    self.assertIn('evidence entries containing Unicode surrogates', stderr.getvalue())
                    try:
                        # O0 spills exports to an environment: intentionally not
                        # resolved by the straight-line register-only analysis.
                        kind = 'property' if '-O0' in flags else 'export'
                        hits = search(db, ['hello'], kind=kind, exact=True)
                        self.assertEqual(hits[0]['id'], 42)
                        self.assertTrue(any(e['text'] == 'hello' for e in hits[0]['evidence']))
                    finally:
                        db.close()


@unittest.skipUnless(os.environ.get('DISK_BUNDLE'), 'set DISK_BUNDLE for real Discord integration')
class Discord35217Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.h = HbcFile(os.environ['DISK_BUNDLE'])

    def test_all_instruction_widths_and_id_ranges(self):
        h = self.h
        limits = {'string': len(h.strings), 'function': len(h.functions),
                  'bigint': h.header['bigint_count']}
        count = 0
        for f in h.functions:
            size = 0
            for ins in h.instructions(f.index):
                size += 1 + OPERANDS[ins.opcode].size
                count += 1
                for pos, kind in ins.ids.items():
                    self.assertLess(ins.args[pos], limits[kind], (f.index, ins))
            self.assertEqual(size, f.size, f.index)
        self.assertEqual(count, 8089716)

    def test_pinned_target(self):
        h = self.h
        self.assertEqual((h.header['file_length'], len(h.functions), len(h.strings)), (70404633, 163874, 349546))
        self.assertEqual((h.header['num_string_switch_imms'], h.header['function_source_count'], h.header['debug_info_offset'], h.header['options']), (113, 2709, 59252256, 0))
        g = h.global_info()
        self.assertEqual((g['offset'], g['size'], g['frame_size'], g['header_offset']), (15094404, 644227, 30, 51887520))
        self.assertEqual(g['sha256'], '22fe8eb9f4638caf834404cd6f82a1d5f22780bbfbfbec793e1728a53404c51c')
        self.assertEqual([h.strings[i] for i in (152, 31623, 255)], ['join', 'eval', ''])
        self.assertEqual([h.string_kinds[i] for i in (152, 31623, 255)], [1, 1, 1])
        self.assertEqual(len(h.modules()), 19539)
        text = generate(h, '352.17 - Stable')
        reference = os.environ.get('HBC_TARGET_REFERENCE')
        if reference:
            self.assertEqual(text, Path(reference).read_text())


if __name__ == '__main__':
    unittest.main()
