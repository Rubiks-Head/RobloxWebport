#!/usr/bin/env python3
"""Background asset post-processor for the CDN cache.

Node calls:  python preprocess.py <src.bin> <dst> [--lod <frac>] [--png]

Produces derived variants next to cached assets:
  --lod 0.25   -> decimated low-poly mesh (roblox mesh v1/v2 binary)
  --png        -> lossless PNG repack (zlib-9 recompress of the IDAT
                  stream — smaller bytes, identical pixels, no decoder
                  needed)

The engine already supports mesh LOD (DFFlagSupportMeshLOD) and picks the
tier by distance/fidelity — these variants just make the low tier small
enough to land instantly. Serving policy lives in index.js (RBX_LOWMESH).
"""
import struct, sys, zlib


# ---------- roblox mesh -----------------------------------------------------
def parse_mesh(buf):
    """Return (version, header_bytes, verts ndarray, faces ndarray) or None."""
    if not buf.startswith(b'version '):
        return None
    nl = buf.find(b'\n')
    ver = buf[8:nl].strip().decode('ascii', 'replace')
    off = nl + 1
    if ver == '1.00' or ver == '1.01':
        # ascii: "num_faces\n" then face*3 vertex tuples "[x,y,z][nx,ny,nz][u,v,w]"
        import re
        body = buf[off:]
        eol = body.find(b'\n')
        nfaces = int(body[:eol])
        raw = re.findall(rb'\[([-\d.eE]+),([-\d.eE]+),([-\d.eE]+)\]', body)
        vals = [float(x) for grp in raw for x in grp]
        import numpy as np
        a = np.array(vals, dtype=np.float32).reshape(-1, 9)
        verts = np.zeros((len(a) // 3 * 3, 8), np.float32)  # pos+norm+uv(w dropped)
        verts[:, :3] = a[:, 0:3]; verts[:, 3:6] = a[:, 3:6]
        verts[:, 6] = a[:, 6]; verts[:, 7] = a[:, 7]
        n = len(verts)
        faces = np.arange(n, dtype=np.uint32).reshape(-1, 3)
        return (ver, b'', verts, faces)
    if ver in ('2.00', '3.00', '3.01', '4.00', '4.01', '5.00'):
        hs, vs, fs = struct.unpack_from('<HBB', buf, off)
        nv, nf = struct.unpack_from('<II', buf, off + 4)
        hdr = buf[:off + hs]
        vbase = off + hs
        import numpy as np
        verts = np.frombuffer(buf[vbase:vbase + nv * vs], dtype=np.uint8).reshape(nv, vs)
        faces = np.frombuffer(buf[vbase + nv * vs:vbase + nv * vs + nf * fs],
                              dtype=np.uint8).reshape(nf, fs)
        return (ver, hdr, verts, faces)
    return None


def decimate_mesh(buf, frac):
    """Vertex-grid-cluster decimation. Returns new mesh bytes or None.

    Works on v2.00's fixed 36-byte vertex (pos3, norm3, uv2 + spare, rgba)
    layout — verts are snapped to a spatial grid and merged, degenerate
    faces dropped. frac is the fraction of vertices to keep (grid size is
    solved from the bounding box)."""
    p = parse_mesh(buf)
    if not p:
        return None
    ver, hdr, verts, faces = p
    if ver != '2.00':
        return None
    import numpy as np
    vs = verts.shape[1]
    pos = verts[:, :12].copy().view('<f4').reshape(-1, 3)
    lo, hi = pos.min(0), pos.max(0)
    span = np.maximum(hi - lo, 1e-6)
    n = len(verts)
    want = max(8, int(n * frac))
    # grid resolution: cells^3 ~ want over the bbox volume
    g = max(1, int(round((want * np.prod(1.0 / span) ** -1) ** (1 / 3)) or 1))
    g = max(1, int(round(want ** (1 / 3))))
    cell = span / g
    key = np.floor((pos - lo) / np.maximum(cell, 1e-9)).astype(np.int64)
    key = key[:, 0] * 73856093 ^ key[:, 1] * 19349663 ^ key[:, 2] * 83492791
    _, first, inv = np.unique(key, return_index=True, return_inverse=True)
    keep = verts[first]                       # representative verts
    idx = faces.reshape(-1).view('<u4')          # nf*fs/4 u32 indices
    nf_faces = inv[idx].reshape(-1, 3)
    a, b, c = nf_faces[:, 0], nf_faces[:, 1], nf_faces[:, 2]
    ok = (a != b) & (b != c) & (a != c)
    nf_faces = nf_faces[ok].astype('<u4')
    out = bytearray()
    out += b'version 2.00\n'
    out += struct.pack('<HBB', 12, vs, 12)
    out += struct.pack('<II', len(keep), len(nf_faces))
    out += keep.tobytes()
    out += nf_faces.tobytes()
    return bytes(out)


# ---------- png lossless repack ---------------------------------------------
def png_repack(buf):
    if not buf.startswith(b'\x89PNG\r\n\x1a\n'):
        return None
    out = bytearray(buf[:8])
    pos = 8
    idat = bytearray()
    chunks = []
    while pos + 8 <= len(buf):
        ln, typ = struct.unpack_from('>I4s', buf, pos)
        data = buf[pos + 8:pos + 8 + ln]
        if typ == b'IDAT':
            idat += data
        else:
            chunks.append((typ, data))
        pos += 12 + ln
        if typ == b'IEND':
            break
    try:
        raw = zlib.decompress(bytes(idat))
    except Exception:
        return None
    repacked = zlib.compress(raw, 9)
    for typ, data in chunks:
        if typ == b'IEND':
            break
        out += struct.pack('>I', len(data)) + typ + data
        out += struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
    out += struct.pack('>I', len(repacked)) + b'IDAT' + repacked
    out += struct.pack('>I', zlib.crc32(b'IDAT' + repacked) & 0xffffffff)
    out += struct.pack('>I', 0) + b'IEND' + struct.pack('>I', zlib.crc32(b'IEND') & 0xffffffff)
    return bytes(out) if len(out) < len(buf) else None


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    buf = open(src, 'rb').read()
    res = None
    if '--lod' in sys.argv:
        frac = float(sys.argv[sys.argv.index('--lod') + 1])
        res = decimate_mesh(buf, frac)
    elif '--png' in sys.argv:
        res = png_repack(buf)
    if res is None:
        sys.exit(2)
    open(dst, 'wb').write(res)
    print(f'{len(buf)} -> {len(res)} bytes')
