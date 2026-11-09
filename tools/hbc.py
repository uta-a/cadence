"""Read-only HBC98 analysis. Format source: see README.md (Hermes, MIT).

No bytecode is executed. All offsets and lengths are checked against the file.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import struct

MAGIC = 0x1F1903C103BC1FC6
HEADER_FIELDS = (
    'file_length global_code_index function_count string_kind_count identifier_count '
    'string_count overflow_string_count string_storage_size bigint_count bigint_storage_size '
    'regexp_count regexp_storage_size literal_value_buffer_size obj_key_buffer_size '
    'obj_shape_table_count num_string_switch_imms segment_id cjs_module_count function_source_count debug_info_offset'
).split()
OPCODES = json.loads(Path(__file__).with_name('opcodes98.json').read_text())['opcodes']
FORMATS = dict(Reg8='B', Reg32='I', UInt8='B', UInt16='H', UInt32='I',
               Addr8='b', Addr32='i', Imm32='i', Double='d')
OPERANDS = [struct.Struct('<' + ''.join(FORMATS[t] for t in op['operands'])) for op in OPCODES]


class HbcError(ValueError):
    """Malformed or unsupported bytecode."""


def align4(n: int) -> int:
    return (n + 3) & ~3


@dataclass(frozen=True)
class Function:
    index: int
    offset: int
    size: int
    param_count: int
    name_id: int
    frame_size: int
    read_cache: int
    write_cache: int
    flags: int
    loop_depth: int
    number_regs: int
    non_pointer_regs: int
    new_object_cache: int
    private_name_cache: int
    expanded: bool
    header_offset: int
    exceptions: tuple[tuple[int, int, int], ...]


@dataclass(frozen=True)
class Instruction:
    offset: int
    opcode: int
    args: tuple

    @property
    def name(self) -> str:
        return OPCODES[self.opcode]['name']

    @property
    def ids(self) -> dict[int, str]:
        return {int(k) - 1: v for k, v in OPCODES[self.opcode]['ids'].items()}


class HbcFile:
    def __init__(self, path: str | Path, *, verify: bool = True):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        self.check(0, 128)
        magic, version = self.unpack('<QI', 0)
        if magic != MAGIC or version != 98:
            raise HbcError(f'Expected execution-form HBC98, got magic={magic:#x}, version={version}')
        self.header = dict(zip(HEADER_FIELDS, self.unpack('<20I', 32)))
        self.header.update(version=version, source_hash=self.data[12:32].hex(), options=self.data[112])
        if self.header['file_length'] != len(self.data):
            raise HbcError('File length does not match header')
        self.footer_valid = hashlib.sha1(self.data[:-20]).digest() == self.data[-20:]
        if verify and not self.footer_valid:
            raise HbcError('SHA-1 footer mismatch')
        self.sections: dict[str, tuple[int, int]] = {}
        p = 128
        h = self.header
        for name, size in (
            ('functions', h['function_count'] * 12), ('string_kinds', h['string_kind_count'] * 4),
            ('identifier_hashes', h['identifier_count'] * 4), ('strings', h['string_count'] * 4),
            ('overflow_strings', h['overflow_string_count'] * 8), ('string_storage', h['string_storage_size']),
            ('literal_values', h['literal_value_buffer_size']), ('object_keys', h['obj_key_buffer_size']),
            ('object_shapes', h['obj_shape_table_count'] * 8), ('bigints', h['bigint_count'] * 8),
            ('bigint_storage', h['bigint_storage_size']), ('regexps', h['regexp_count'] * 8),
            ('regexp_storage', h['regexp_storage_size']), ('cjs_modules', h['cjs_module_count'] * 8),
            ('function_sources', h['function_source_count'] * 8),
        ):
            p = align4(p)
            self.check(p, size)
            self.sections[name] = (p, size)
            p += size
        self.tables_end = p
        debug = h['debug_info_offset']
        if debug < p:
            raise HbcError('Debug info overlaps file tables')
        filenames, storage, regions, data_size = self.unpack('<4I', debug)
        debug_size = 16 + filenames * 8 + storage + regions * 12 + data_size
        self.check(debug, debug_size)
        self.sections['debug_info'] = (debug, debug_size)
        self.functions = [self._function(i) for i in range(h['function_count'])]
        if not 0 <= h['global_code_index'] < len(self.functions):
            raise HbcError('Global function index out of range')
        self.string_kinds = self._string_kinds()
        self.strings = self._strings()
        self._modules = None

    def check(self, offset: int, size: int) -> None:
        if offset < 0 or size < 0 or offset + size > len(self.data) - 20:
            raise HbcError(f'Out of bounds: offset={offset}, size={size}')

    def unpack(self, fmt: str, offset: int) -> tuple:
        self.check(offset, struct.calcsize(fmt))
        return struct.unpack_from(fmt, self.data, offset)

    def _function(self, index: int) -> Function:
        p = 128 + index * 12
        a, b, frame, read, write, flags = self.unpack('<IIBBBB', p)
        offset, params, size, name = a & 0x1FFFFFF, (a >> 25) & 31, b & 0x3FFF, (b >> 14) & 255
        loop, numbers, nonptrs = a >> 30, (b >> 22) & 31, b >> 27
        newobj, private, write = (write >> 6) & 1, write >> 7, write & 63
        expanded = bool(flags & 32)
        exceptions = ()
        if expanded:
            p = offset | (name << 24)
            self.check(p, 40)
            if p < self.tables_end or p % 4:
                raise HbcError(f'Invalid expanded header in function {index}')
            offset, params, loop, size, name, numbers, nonptrs, frame, read, write, newobj, private, flags = self.unpack('<8I5B', p)
            if flags & 8:
                ep = align4(p + 37)
                count, = self.unpack('<I', ep)
                self.check(ep + 4, count * 12)
                exceptions = tuple(self.unpack('<III', ep + 4 + i * 12) for i in range(count))
                if any(not (s <= e <= size and t < size) for s, e, t in exceptions):
                    raise HbcError(f'Invalid exception range in function {index}')
        self.check(offset, size)
        if offset < self.tables_end:
            raise HbcError(f'Function {index} body overlaps file tables')
        if name >= self.header['string_count']:
            raise HbcError(f'Invalid function name ID in function {index}')
        return Function(index, offset, size, params, name, frame, read, write, flags,
                        loop, numbers, nonptrs, newobj, private, expanded, p, exceptions)

    def _string_kinds(self) -> list[int]:
        kinds = []
        base, size = self.sections['string_kinds']
        for p in range(base, base + size, 4):
            word, = self.unpack('<I', p)
            count = word & 0x7FFFFFFF
            if not count or len(kinds) + count > self.header['string_count']:
                raise HbcError('Invalid string kind run')
            kinds.extend([word >> 31] * count)
        if len(kinds) != self.header['string_count'] or sum(kinds) != self.header['identifier_count']:
            raise HbcError('String kind counts disagree with header')
        return kinds

    def _strings(self) -> list[str]:
        table = self.sections['strings'][0]
        overflow = self.sections['overflow_strings'][0]
        storage, storage_size = self.sections['string_storage']
        result = []
        for i in range(self.header['string_count']):
            word, = self.unpack('<I', table + i * 4)
            utf16, off, length = word & 1, (word >> 1) & 0x7FFFFF, word >> 24
            if length == 255:
                if off >= self.header['overflow_string_count']:
                    raise HbcError('Invalid overflow string index')
                off, length = self.unpack('<II', overflow + off * 8)
            n = length * (2 if utf16 else 1)
            if off + n > storage_size:
                raise HbcError(f'String {i} outside storage')
            raw = self.data[storage + off:storage + off + n]
            try:
                result.append(raw.decode('utf-16-le' if utf16 else 'ascii', errors='surrogatepass'))
            except UnicodeError as exc:
                raise HbcError(f'Invalid string encoding at ID {i}') from exc
        return result

    def body(self, index: int) -> bytes:
        f = self.functions[index]
        return self.data[f.offset:f.offset + f.size]

    def instructions(self, index: int):
        f = self.functions[index]
        p, end = 0, f.size
        # Header size covers opcodes only; switch tables follow the body.
        while p < end:
            code = self.data[f.offset + p]
            if code >= len(OPCODES):
                raise HbcError(f'Unknown opcode {code} in function {index} at {p}')
            fmt = OPERANDS[code]
            if p + 1 + fmt.size > end:
                raise HbcError(f'Truncated instruction in function {index} at {p}')
            args = fmt.unpack_from(self.data, f.offset + p + 1)
            ins = Instruction(p, code, args)
            yield ins
            p += 1 + fmt.size

    def disassemble(self, index: int):
        for ins in self.instructions(index):
            rendered = []
            for i, (kind, value) in enumerate(zip(OPCODES[ins.opcode]['operands'], ins.args)):
                if ins.ids.get(i) == 'string':
                    rendered.append(f'{value} {json.dumps(self.strings[value], ensure_ascii=True)}')
                elif kind.startswith('Reg'):
                    rendered.append(f'r{value}')
                elif kind.startswith('Addr'):
                    rendered.append(f'{value:+} (->{ins.offset + value})')
                else:
                    rendered.append(str(value))
            yield f'{ins.offset:7d}  {ins.name:28s} ' + ', '.join(rendered)

    def global_info(self) -> dict:
        f = self.functions[self.header['global_code_index']]
        return {**asdict(f), 'sha256': hashlib.sha256(self.body(f.index)).hexdigest()}

    def literals(self, section: str, offset: int, count: int) -> list:
        base, size = self.sections[section]
        end, p, result = base + size, base + offset, []
        formats = {3: 'd', 4: 'I', 5: 'H', 7: 'i'}
        while len(result) < count:
            if not base <= p < end:
                raise HbcError('Literal buffer overrun')
            tag = self.data[p]
            p += 1
            n = tag & 15
            if tag & 128:
                if p >= end:
                    raise HbcError('Truncated literal tag')
                n = (n << 8) | self.data[p]
                p += 1
            if n == 0:
                raise HbcError('Invalid literal run length')
            n = min(n, count - len(result))
            kind = (tag >> 4) & 7
            for _ in range(n):
                if kind in formats:
                    fmt = formats[kind]
                    if p + struct.calcsize(fmt) > end:
                        raise HbcError('Truncated literal value')
                    v, = self.unpack('<' + fmt, p)
                    p += struct.calcsize(fmt)
                    result.append(('string', v) if kind in (4, 5) else v)
                else:
                    result.append(('undefined',) if kind == 6 else (None, True, False)[kind])
        return result

    def modules(self) -> dict[int, dict]:
        if self._modules is not None:
            return self._modules
        regs, result = {}, {}
        frame = self.functions[self.header['global_code_index']].frame_size
        for ins in self.instructions(self.header['global_code_index']):
            n, a = ins.name, ins.args
            value = None
            if n == 'GetGlobalObject':
                value = ('global',)
            elif n.startswith(('GetById', 'TryGetById')):
                if regs.get(a[1]) == ('global',) and self.strings[a[-1]] == '__d':
                    value = ('define',)
            elif n.startswith('CreateClosure'):
                value = ('function', a[2])
            elif n.startswith(('LoadConstUInt8', 'LoadConstInt', 'LoadConstDouble')):
                value = ('number', a[1])
            elif n == 'LoadConstZero':
                value = ('number', 0)
            elif n.startswith('NewArrayWithBuffer'):
                value = ('deps', self.literals('literal_values', a[3], a[2]))
            elif n == 'NewArray':
                value = ('deps', [])
            elif n in ('Mov', 'MovLong'):
                value = regs.get(a[1])
            if n.startswith('Call') and regs.get(a[1]) == ('define',):
                if n in ('Call4',):
                    factory, mid, deps = (regs.get(r) for r in a[3:6])
                elif n == 'Call':
                    # Call argument 0 (this) starts at frameSize - 7.
                    factory, mid, deps = (regs.get(frame - 8 - j) for j in range(3))
                else:
                    raise HbcError(f'Unsupported __d call {n} at {ins.offset}')
                if not (factory and factory[0] == 'function' and mid and mid[0] == 'number'
                        and deps and deps[0] == 'deps' and int(mid[1]) == mid[1]):
                    raise HbcError(f'Unresolved __d registration at {ins.offset}: {factory}, {mid}, {deps}')
                module_id = int(mid[1])
                if module_id in result:
                    raise HbcError(f'Duplicate module ID {module_id}')
                result[module_id] = dict(factory=factory[1], deps=deps[1], offset=ins.offset)
            if writes_register(ins):
                regs[a[0]] = value
        self._modules = result
        return result


def writes_register(ins: Instruction) -> bool:
    """Whether operand zero receives a result (stores and branches do not)."""
    n = ins.name
    return bool(ins.args and OPCODES[ins.opcode]['operands'][0].startswith('Reg')
                and not n.startswith(('Put', 'TryPut', 'DefineOwn', 'Store', 'Ret', 'Throw', 'J',
                                      'Switch', 'UIntSwitch', 'StringSwitch', 'IteratorClose', 'TypedStore')))
