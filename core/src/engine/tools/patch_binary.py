#!/usr/bin/env python3
# Direct binary patcher: splice patched function bodies into WebClient wasm.
# Usage: patch_binary.py <in.wasm> <out.wasm> <patched_wat_dir_search>
# Each patched func is compiled standalone (fast) and its body replaces the
# real body at the same func index. Only call-site bytes may differ.
import re, struct, subprocess, sys, os, tempfile, glob

W2W = r"C:\Users\jg082\Downloads\blong\wabt-1.0.42\bin\wat2wasm.exe"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def leb(data, off):
    v = 0; s = 0
    while True:
        b = data[off]; off += 1
        v |= (b & 0x7f) << s
        if not b & 0x80: return v, off
        s += 7

def uleb(v):
    out = bytearray()
    while True:
        b = v & 0x7f; v >>= 7
        if v: out.append(b | 0x80)
        else: out.append(b); break
    return bytes(out)

def sections(data):
    off = 8; out = []
    while off < len(data):
        sid = data[off]; off += 1
        size, off2 = leb(data, off)
        out.append((sid, off2, size, off, off2 - off))
        off = off2 + size
    return out

def func_import_count(data):
    for sid, body, size, _, _ in sections(data):
        if sid != 2: continue
        n, off = leb(data, body); cnt = 0
        for _ in range(n):
            l, off = leb(data, off); off += l   # module
            l, off = leb(data, off); off += l   # name
            k = data[off]; off += 1
            if k == 0:
                _, off = leb(data, off); cnt += 1
            elif k == 1:
                off += 1
                f = data[off]; off += 1
                if f & 1: _, off = leb(data, off)
                if f & 2: _, off = leb(data, off)
            elif k == 2:
                f = data[off]; off += 1
                _, off = leb(data, off)
                if f & 1: _, off = leb(data, off)
            elif k == 3:
                off += 2
            elif k == 4:
                _, off = leb(data, off)
        return cnt
    return 0

def bodies(data):
    for sid, body, size, _, _ in sections(data):
        if sid != 10: continue
        n, off = leb(data, body)
        out = []
        for _ in range(n):
            blen, o2 = leb(data, off)
            out.append((o2, blen))
            off = o2 + blen
        return out
    return []

def compile_body(wat_src, tmpdir):
    types = open(os.path.join(ROOT, 'sec_type.wat')).read()
    mod = os.path.join(tmpdir, 'm.wat')
    with open(mod, 'w') as f:
        f.write('(module\n' + types + wat_src + ')\n')
    out = mod.replace('.wat', '.wasm')
    r = subprocess.run([W2W, '--enable-threads', '--enable-function-references',
                        '--enable-gc', '--enable-custom-page-sizes',
                        '--enable-wide-arithmetic', '--no-check',
                        '-o', out, mod], capture_output=True, text=True)
    if r.returncode != 0:
        print('wat2wasm failed:', r.stderr[:2000]); sys.exit(1)
    d = open(out, 'rb').read()
    bs = bodies(d)
    assert len(bs) == 1
    o, l = bs[0]
    return d[o:o+l]

def main():
    src_wasm, dst_wasm = sys.argv[1], sys.argv[2]
    targets = [int(x) for x in sys.argv[3:]]
    data = bytearray(open(src_wasm, 'rb').read())
    ni = func_import_count(data)
    bs = bodies(data)
    print(f'func imports={ni} bodies={len(bs)}')
    tmp = tempfile.mkdtemp()
    for fn in targets:
        # find patched fN.wat under src/
        hits = sorted(glob.glob(os.path.join(ROOT, 'src', '*', f'f{fn}.wat')))
        if not hits: print(f'f{fn}.wat NOT FOUND'); sys.exit(1)
        wat = open(hits[0]).read()
        pbody = compile_body(wat, tmp)
        bi = fn - ni
        o, l = bs[bi]
        real = bytes(data[o:o+l])
        if len(real) != len(pbody):
            print(f'f{fn}: len mismatch real={len(real)} patched={len(pbody)}'); sys.exit(1)
        diffs = [i for i in range(l) if real[i] != pbody[i]]
        # group into regions
        regions = []
        for i in diffs:
            if regions and i - regions[-1][-1] <= 1: regions[-1].append(i)
            else: regions.append([i])
        ncalls = 0
        for rg in regions:
            if real[rg[0]] != 0x10 or any(pbody[i] not in (0x1a, 0x01) for i in rg):
                # not a call->drop/nop change: decomp artifact (e.g. local
                # types). Only call-site regions get spliced.
                print(f'  f{fn}: skipping non-call diff @{rg[0]} real={real[rg[0]]:02x}')
                continue
            for i in rg: data[o+i] = pbody[i]
            ncalls += 1
        print(f'f{fn}@{o}: body={l}B patched-calls={ncalls} total-diffs={len(regions)}')
    open(dst_wasm, 'wb').write(data)
    print('wrote', dst_wasm, len(data))

main()
