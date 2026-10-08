#!/usr/bin/env python3
"""Add an LC_LOAD_DYLIB load command to a (fat) Mach-O executable.

    add-load-command.py <binary> <dylib install path, e.g. @executable_path/libpvwindow.dylib>

Used by scripts/build.sh to link libpvwindow.dylib into PassVault's
Neutralino shell. The command is written into the free space between the
existing load commands and the first section, in every architecture slice; it
refuses (exit 1) if there is not enough space, the binary is still signed,
or the command is already present. Re-sign the binary afterwards.
"""
import struct
import sys

MH_MAGIC_64 = 0xFEEDFACF
FAT_MAGIC = 0xCAFEBABE
LC_LOAD_DYLIB = 0xC
LC_SEGMENT_64 = 0x19
LC_CODE_SIGNATURE = 0x1D


def patch_slice(buf: bytearray, off: int, path: bytes) -> None:
    magic, cputype, _sub, _ft, ncmds, sizeofcmds, _flags, _res = struct.unpack_from("<IiiIIIII", buf, off)
    if magic != MH_MAGIC_64:
        raise SystemExit("not a 64-bit Mach-O slice")
    header = 32
    p = off + header
    first_section = None
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", buf, p)
        if cmd == LC_CODE_SIGNATURE:
            raise SystemExit("remove the code signature first (codesign --remove-signature)")
        if cmd == LC_LOAD_DYLIB:
            name_off = struct.unpack_from("<I", buf, p + 8)[0]
            name = bytes(buf[p + name_off : p + cmdsize]).split(b"\0", 1)[0]
            if name == path:
                raise SystemExit("already linked")
        if cmd == LC_SEGMENT_64:
            nsects = struct.unpack_from("<I", buf, p + 64)[0]
            for i in range(nsects):
                s = p + 72 + i * 80
                sect_off = struct.unpack_from("<I", buf, s + 48)[0]
                if sect_off and (first_section is None or sect_off < first_section):
                    first_section = sect_off
        p += cmdsize
    name = path + b"\0"
    size = (24 + len(name) + 7) & ~7
    end = header + sizeofcmds
    if first_section is None or end + size > first_section:
        raise SystemExit(f"not enough room for the load command (cputype {cputype})")
    if any(buf[off + end : off + end + size]):
        raise SystemExit("load command area is not empty")
    cmd = struct.pack("<IIIIII", LC_LOAD_DYLIB, size, 24, 2, 0x10000, 0x10000) + name
    cmd += b"\0" * (size - len(cmd))
    buf[off + end : off + end + size] = cmd
    struct.pack_into("<II", buf, off + 16, ncmds + 1, sizeofcmds + size)


def main() -> None:
    binary, dylib = sys.argv[1], sys.argv[2].encode()
    buf = bytearray(open(binary, "rb").read())
    if struct.unpack_from(">I", buf, 0)[0] == FAT_MAGIC:
        (nfat,) = struct.unpack_from(">I", buf, 4)
        for i in range(nfat):
            _cpu, _sub, offset, _size, _align = struct.unpack_from(">iiIII", buf, 8 + i * 20)
            patch_slice(buf, offset, dylib)
    else:
        patch_slice(buf, 0, dylib)
    open(binary, "wb").write(bytes(buf))
    print(f"linked {dylib.decode()} into {binary}")


if __name__ == "__main__":
    main()
