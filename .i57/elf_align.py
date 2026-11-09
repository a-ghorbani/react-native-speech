"""Set p_align of every PT_LOAD in an ELF64 LE file: elf_align.py <so> <align>; prints before/after."""
import struct, sys
path, align = sys.argv[1], int(sys.argv[2], 0)
b = bytearray(open(path, 'rb').read())
assert b[:4] == b'\x7fELF' and b[4] == 2 and b[5] == 1
phoff, = struct.unpack_from('<Q', b, 0x20)
phentsize, phnum = struct.unpack_from('<HH', b, 0x36)
for i in range(phnum):
    o = phoff + i * phentsize
    if struct.unpack_from('<I', b, o)[0] == 1:
        old, = struct.unpack_from('<Q', b, o + 0x30)
        struct.pack_into('<Q', b, o + 0x30, align)
        print(f'LOAD[{i}] p_align {old:#x} -> {align:#x}')
open(path, 'wb').write(b)
