#!/usr/bin/env python3
"""reloc_highmem.py — relocate the fixed high-address region (socket ABI,
gate mailbox, canary/TLS block, stack top) down by SHIFT bytes so the module
instantiates on a smaller heap.

The binary pins ~2KB of active data + the ABI/gate blocks + the stack top at
0x7ff00000-0x7ff90000. This walks the code section instruction-by-instruction,
rewrites every i32/i64.const and memarg offset pointing into that window, then
rewrites the data-segment offsets and the stack-pointer global init.

Usage: reloc_highmem.py <in.wasm> <out.wasm> [shift_hex=0x40000000] [--window a,b)
"""
import sys, struct

WIN_LO, WIN_HI = 0x7ff00000, 0x7ff60000   # default patch window (masks >=0x7ffe0000 excluded)

def uleb(b, p):
    r = 0; s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s
        if not (x & 0x80): return r, p
        s += 7
        if s > 70: raise ValueError("uleb overflow")

def sleb(b, p):
    r = 0; s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s; s += 7
        if not (x & 0x80):
            if x & 0x40: r -= (1 << s)
            return r, p

def enc_sleb_pad(v, width):
    """Encode non-negative v as sleb128 padded to exactly `width` bytes."""
    out = bytearray()
    while True:
        b7 = v & 0x7f; v >>= 7
        if v == 0 and not (b7 & 0x40):
            out.append(b7); break
        out.append(b7 | 0x80)
    while len(out) < width:
        out[-1] |= 0x80
        out.append(0x00)
    assert len(out) == width, (v, width, out)
    return bytes(out)

# ---- instruction immediate table -------------------------------------------
# returns list of immediates consumed: ('uleb',) ('sleb',) ('memarg',) ('bytes',n)
# ('blocktype',) ('brtable',) ('veculeb',) ('valtype_vec',) ('lane',n) etc.
def skip_blocktype(b, p):
    x = b[p]
    if x == 0x40 or (x & 0x80) == 0 or x in range(0x60, 0x80):
        return p + 1            # empty or valtype (single byte)
    _, p2 = sleb(b, p)          # positive typeidx encoded as sleb33
    return p2

VALTYPE_BYTES = set(range(0x60, 0x80)) | {0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f, 0x6e, 0x6d, 0x6c, 0x6b}

def walk_body(b, start, end, sites, extras):
    """Decode instructions; record (pos, width, value) for high consts/memarg offsets."""
    p = start
    while p < end:
        op_pos = p
        op = b[p]; p += 1
        if op == 0x0b:
            continue                          # end (nested or final)
        if op in (0x02, 0x03, 0x04, 0x06):
            p = skip_blocktype(b, p)
        elif op == 0x1f:                       # try_table: blocktype + vec(catch)
            p = skip_blocktype(b, p)
            n, p = uleb(b, p)
            for _ in range(n):
                kind = b[p]; p += 1
                if kind in (0, 1): _, p = uleb(b, p)   # tag idx
                _, p = uleb(b, p)                       # label
        elif op == 0x07 or op == 0x08 or op == 0x09:    # catch/throw/rethrow (tag)
            _, p = uleb(b, p)
        elif op == 0x0a:                                 # br_on_exn (legacy EH)
            _, p = uleb(b, p); _, p = uleb(b, p)
        elif op == 0x18:                                 # delegate
            _, p = uleb(b, p)
        elif op == 0x19:                                 # catch_all
            pass
        elif op in (0x0c, 0x0d, 0x10, 0x12, 0x14, 0x15, 0xd2, 0xd6, 0xd7):
            _, p = uleb(b, p)
        elif op in (0x11, 0x13):
            _, p = uleb(b, p); _, p = uleb(b, p)
        elif op == 0x0e:                       # br_table
            n, p = uleb(b, p)
            for _ in range(n + 1): _, p = uleb(b, p)
        elif op == 0x1c:                       # select_t
            n, p = uleb(b, p); p += n
        elif 0x20 <= op <= 0x26:
            _, p = uleb(b, p)
        elif 0x28 <= op <= 0x3e:               # loads/stores: memarg
            _, p = uleb(b, p)
            sp = p; off, p = uleb(b, p)
            if WIN_LO <= off < WIN_HI:
                sites.append((sp, p - sp, off, 'memarg'))
        elif op in (0x3f, 0x40):
            _, p = uleb(b, p)
        elif op in (0x41, 0x42):               # i32/i64.const
            sp = p; v, p = sleb(b, p)
            if WIN_LO <= v < WIN_HI:
                sites.append((sp, p - sp, v, 'const'))
        elif op == 0x43: p += 4
        elif op == 0x44: p += 8
        elif 0x45 <= op <= 0xc4 or op in (0x00, 0x01, 0x05, 0x0f, 0x1a, 0x1b, 0xd1, 0xd3, 0xd4, 0xd5):
            pass
        elif op == 0xd0:
            _, p = sleb(b, p)                  # ref.null heaptype
        elif op == 0xfc:
            sub, p = uleb(b, p)
            if sub in (8,):  _, p = uleb(b, p); _, p = uleb(b, p)   # memory.init seg+mem
            elif sub in (9, 13): _, p = uleb(b, p)
            elif sub == 10:  _, p = uleb(b, p); _, p = uleb(b, p)
            elif sub == 11:  _, p = uleb(b, p)
            elif sub in (12, 14): _, p = uleb(b, p); _, p = uleb(b, p)
            elif sub in (15, 16, 17): _, p = uleb(b, p)
            elif sub <= 7: pass                # trunc_sat
            else: raise ValueError(f"fc subop {sub}")
        elif op == 0xfd:                        # simd
            sub, p = uleb(b, p)
            if sub == 12 or sub == 13: p += 16              # v128.const / shuffle
            elif 84 <= sub <= 91:                            # load/store lane
                _, p = uleb(b, p); _, p = uleb(b, p); p += 1
            elif sub in range(21, 41) or sub in (92, 93):    # lane ops
                p += 1
            elif sub < 21 or sub in (0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b):
                _, p = uleb(b, p); _, p = uleb(b, p)         # memarg loads/stores
            # else: plain simd op, no immediates
        elif op == 0xfe:                        # atomics
            sub, p = uleb(b, p)
            if sub == 0x03: p += 1                          # fence
            else: _, p = uleb(b, p); _, p = uleb(b, p)      # memarg
        elif op == 0xe0:
            pass                                            # suspend (jspi)
        elif op == 0xe1 or op == 0xe3:                      # resume / resume_throw
            n, p = uleb(b, p)
            for _ in range(n): _, p = uleb(b, p); _, p = uleb(b, p)
        elif op == 0xe2:
            _, p = uleb(b, p)                               # switch tag
        elif op == 0xfb:                                    # GC — bail, none expected
            raise ValueError("gc opcode")
        else:
            raise ValueError(f"unknown op 0x{op:02x} @0x{op_pos:x}")
    return p == end

def init_expr_patches(b, p, patches):
    op = b[p]; p += 1
    if op in (0x41, 0x42):
        sp = p; v, p = sleb(b, p)
        if isinstance(v, int) and WIN_LO <= v < WIN_HI:
            patches.append((sp, p - sp, v))
    elif op == 0x23:
        _, p = uleb(b, p)
    elif op == 0x43: p += 4
    elif op == 0x44: p += 8
    assert b[p] == 0x0b
    return p + 1

def main():
    inp, outp = sys.argv[1], sys.argv[2]
    shift = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0x40000000
    global WIN_LO, WIN_HI
    if len(sys.argv) > 4 and sys.argv[4] == '--window':
        WIN_LO, WIN_HI = (int(x, 0) for x in sys.argv[5].split(','))
    data = bytearray(open(inp, 'rb').read())
    assert data[:4] == b'\x00asm'

    # section boundaries
    secs = {}
    pos = 8
    while pos < len(data):
        sid = data[pos]; pos += 1
        sz, pos = uleb(data, pos)
        secs[sid] = (pos, sz)
        pos += sz

    patches = []        # (pos, width, oldval)
    unhandled = []
    unver = []          # (funcidx, pos, val) — sites from desynced functions
    ambiguous = []      # sites in [0x7ff60000,0x80000000) for manual review

    # --- code section: walk every function body
    cstart, csz = secs[10]
    p = cstart
    nfuncs, p = uleb(data, p)
    for fi in range(nfuncs):
        bsz, p = uleb(data, p)
        bend = p + bsz
        # locals
        lp = p
        nl, lp = uleb(data, lp)
        for _ in range(nl):
            _, lp = uleb(data, lp); lp += 1
        sites = []
        try:
            ok = walk_body(data, lp, bend, sites, None)
        except Exception as e:
            ok = False
            unhandled.append((fi, str(e)))
        if not ok:
            unhandled.append((fi, 'desync'))
            # still record dumb-scan candidates so we know what's at stake
            j = lp
            while True:
                j = data.find(b'\x41', j, bend)
                if j < 0: break
                v, e = sleb(data, j + 1)
                if WIN_LO <= v < WIN_HI:
                    sites.append((j + 1, e - (j + 1), v, 'UNVERIFIED'))
                j += 1
        for s in sites:
            if not ok:
                unver.append((fi, s[0], s[2]))   # report-only, never patched
            else:
                patches.append((s[0], s[1], s[2]))
        p = bend
    print(f"functions: {nfuncs}, unhandled: {len(unhandled)}")
    for f in unhandled[:20]: print("  unhandled", f)

    # also dumb-scan the whole code section for ambiguous >=0x7ff60000 values
    amb = {}
    j = cstart
    while True:
        j = data.find(b'\x41', j, secs[10][0] + secs[10][1])
        if j < 0: break
        v, _ = sleb(data, j + 1)
        if 0x7ff60000 <= v < 0x80000000:
            amb[v] = amb.get(v, 0) + 1
        j += 1
    print("ambiguous >=0x7ff60000 consts (NOT patched):", sum(amb.values()))
    for v, c in sorted(amb.items()):
        if v < 0x7ffe0000: print(f"   0x{v:08x} x{c}   <-- review me")

    # --- globals: patch init exprs (stack pointer)
    gpos, gsz = secs[6]
    p = gpos; n, p = uleb(data, p)
    for i in range(n):
        p += 2
        e0 = p
        p = init_expr_patches(data, p, patches)
    # --- data segments: patch active-segment offsets
    dpos, dsz = secs[11]
    p = dpos; n, p = uleb(data, p)
    for i in range(n):
        kind, p = uleb(data, p)
        if kind in (0, 2):
            if kind == 2: _, p = uleb(data, p)
            sp = p
            p = init_expr_patches(data, p, patches)
            ln, p = uleb(data, p); p += ln
        else:
            ln, p = uleb(data, p); p += ln

    print(f"patch sites: {len(patches)} ({len(unver)} unverified)")
    for fi, sp, v in unver[:30]:
        print(f"   UNVERIFIED f{fi} @0x{sp:x} val=0x{v:08x}")
    from collections import Counter
    byval = Counter(v for _, _, v in patches)
    for v, c in sorted(byval.items()):
        print(f"   0x{v:08x} -> 0x{v - shift:08x}  x{c}")
    for sp, w, v in patches:
        nv = v - shift
        assert nv >= 0, f"negative after shift at 0x{sp:x}"
        data[sp:sp + w] = enc_sleb_pad(nv, w)
    open(outp, 'wb').write(data)
    print(f"wrote {outp} ({len(data)/1048576:.1f}MB), shift=-0x{shift:x}")

if __name__ == '__main__':
    main()
