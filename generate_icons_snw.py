"""
Shadow Nexus Wave — Icon Generator
Renders the SNW brand mark: midnight bg, glowing eclipse ring,
electric-blue lightning bolt, and a flowing neon wave.
Pure Python stdlib only.
"""
import struct, zlib, math, os

# ── Brand palette ─────────────────────────────────────
BG_TOP   = (2,   5,  18, 255)   # near-black midnight
BG_BOT   = (4,  14,  42, 255)   # slightly lighter deep navy
RING_OUT = (0, 174, 239, 255)   # electric cyan outer ring
RING_IN  = (0,  60, 130, 255)   # deep blue inner disc
ECLIPSE  = (1,   3,  12, 255)   # black eclipse body
MOON_HL  = (180, 230, 255, 200) # faint crescent highlight
BOLT_1   = (0,  200, 255, 255)  # bright bolt core
BOLT_2   = (0, 130, 210, 200)   # bolt glow
WAVE_1   = (0,  210, 255, 220)  # wave highlight
WAVE_2   = (0, 100, 200, 140)   # wave body
GLOW_C   = (0, 174, 239,  60)   # ambient halo

def make_png(rgba_bytes, w, h):
    rows = []
    rs = w * 4
    for y in range(h):
        rows.append(b'\x00' + rgba_bytes[y*rs:(y+1)*rs])
    idat = zlib.compress(b''.join(rows), 6)
    def chunk(t, d):
        c = t + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
    ihdr = struct.pack('>II', w, h) + bytes([8, 6, 0, 0, 0])
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

def blend(src, dst):
    sa = src[3] / 255.0
    da = dst[3] / 255.0
    oa = sa + da * (1 - sa)
    if oa == 0: return (0, 0, 0, 0)
    r = int((src[0]*sa + dst[0]*da*(1-sa)) / oa)
    g = int((src[1]*sa + dst[1]*da*(1-sa)) / oa)
    b = int((src[2]*sa + dst[2]*da*(1-sa)) / oa)
    return (r, g, b, int(oa * 255))

def clamp(v, lo=0, hi=255):
    return max(lo, min(hi, int(v)))

def smoothstep(edge0, edge1, x):
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)

def render(S=64):
    cx = cy = S / 2.0
    buf = bytearray(S * S * 4)

    # ── Background gradient (top-to-bottom) ──────────────
    for y in range(S):
        t = y / (S - 1)
        r = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
        g = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
        b = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)
        for x in range(S):
            i = (y * S + x) * 4
            buf[i:i+4] = [r, g, b, 255]

    # ── Ambient background halo ───────────────────────────
    for y in range(S):
        for x in range(S):
            px, py = x + 0.5, y + 0.5
            dx, dy = px - cx, py - cy
            d = math.sqrt(dx*dx + dy*dy)
            aa = smoothstep(S * 0.55, S * 0.05, d)
            if aa > 0:
                i = (y * S + x) * 4
                col = (buf[i], buf[i+1], buf[i+2], buf[i+3])
                col = blend((GLOW_C[0], GLOW_C[1], GLOW_C[2], int(GLOW_C[3] * aa)), col)
                buf[i:i+4] = col

    # ── Eclipse: outer glow ring ──────────────────────────
    RING_R  = S * 0.40   # outer radius
    RING_T  = S * 0.05   # ring thickness
    CORE_R  = RING_R - RING_T

    for y in range(S):
        for x in range(S):
            px, py = x + 0.5, y + 0.5
            dx, dy = px - cx, py - cy
            d = math.sqrt(dx*dx + dy*dy)
            i = (y * S + x) * 4
            col = (buf[i], buf[i+1], buf[i+2], buf[i+3])

            # outer glow halo
            halo_aa = smoothstep(RING_R + S*0.10, RING_R - S*0.01, d)
            if halo_aa > 0:
                col = blend((RING_OUT[0], RING_OUT[1], RING_OUT[2],
                             int(60 * halo_aa)), col)

            # ring band (anti-aliased)
            if d <= RING_R + 1.5:
                outer_aa = smoothstep(RING_R + 1.5, RING_R - 0.5, d)
                inner_aa = smoothstep(CORE_R - 1.5, CORE_R + 0.5, d)
                ring_aa  = outer_aa * inner_aa
                if ring_aa > 0:
                    col = blend((RING_OUT[0], RING_OUT[1], RING_OUT[2],
                                 int(RING_OUT[3] * ring_aa)), col)

            # eclipse dark disc fill
            if d <= CORE_R + 0.5:
                fill_aa = smoothstep(CORE_R + 0.5, CORE_R - 0.5, d)
                col = blend((ECLIPSE[0], ECLIPSE[1], ECLIPSE[2],
                             int(255 * fill_aa)), col)

            # crescent moon highlight (top-right arc)
            cres_cx = cx + CORE_R * 0.30
            cres_cy = cy - CORE_R * 0.20
            cres_r  = CORE_R * 0.75
            cd = math.sqrt((px - cres_cx)**2 + (py - cres_cy)**2)
            if d <= CORE_R - 0.5:
                mask_in  = smoothstep(cres_r + 1.0, cres_r - 1.0, cd)
                mask_out = smoothstep(CORE_R - 1.0, CORE_R - 3.0, d)
                cres_aa  = mask_out * (1.0 - mask_in) * 0.55
                if cres_aa > 0:
                    col = blend((MOON_HL[0], MOON_HL[1], MOON_HL[2],
                                 int(MOON_HL[3] * cres_aa)), col)

            buf[i:i+4] = col

    # ── Lightning bolt (center, slightly left) ────────────
    # Bolt path: a zigzag from top to bottom of the eclipse disc
    # Defined as a series of line segments; we rasterize by distance-to-segment
    bolt_cx = cx - S * 0.04
    bolt_scale = CORE_R * 0.78

    bolt_pts = [
        (bolt_cx - bolt_scale*0.08, cy - bolt_scale*0.92),
        (bolt_cx + bolt_scale*0.18, cy - bolt_scale*0.08),
        (bolt_cx - bolt_scale*0.04, cy + bolt_scale*0.08),
        (bolt_cx + bolt_scale*0.20, cy + bolt_scale*0.92),
    ]

    def seg_dist(px, py, ax, ay, bx, by):
        abx, aby = bx - ax, by - ay
        l2 = abx*abx + aby*aby
        if l2 == 0: return math.sqrt((px-ax)**2 + (py-ay)**2)
        t = max(0, min(1, ((px-ax)*abx + (py-ay)*aby) / l2))
        projx, projy = ax + t*abx, ay + t*aby
        return math.sqrt((px-projx)**2 + (py-projy)**2)

    BOLT_W_CORE = max(1.0, S * 0.028)
    BOLT_W_GLOW = max(2.0, S * 0.065)

    for y in range(S):
        for x in range(S):
            px, py = x + 0.5, y + 0.5
            # only inside the eclipse disc
            dx, dy = px - cx, py - cy
            d_center = math.sqrt(dx*dx + dy*dy)
            if d_center > CORE_R + 1: continue

            min_d = float('inf')
            for k in range(len(bolt_pts) - 1):
                ax, ay = bolt_pts[k]
                bx, by = bolt_pts[k+1]
                sd = seg_dist(px, py, ax, ay, bx, by)
                if sd < min_d: min_d = sd

            i = (y * S + x) * 4
            col = (buf[i], buf[i+1], buf[i+2], buf[i+3])

            # glow
            glow_aa = smoothstep(BOLT_W_GLOW, 0, min_d) * 0.7
            if glow_aa > 0:
                col = blend((BOLT_2[0], BOLT_2[1], BOLT_2[2],
                             int(BOLT_2[3] * glow_aa)), col)
            # core
            core_aa = smoothstep(BOLT_W_CORE, 0, min_d)
            if core_aa > 0:
                col = blend((BOLT_1[0], BOLT_1[1], BOLT_1[2],
                             int(BOLT_1[3] * core_aa)), col)

            buf[i:i+4] = col

    # ── Neon wave (passes UNDER the eclipse, exits right) ─
    # Wave: sinusoidal path crossing horizontally, clipped to lower region
    WAVE_W_CORE = max(0.8, S * 0.025)
    WAVE_W_GLOW = max(1.5, S * 0.060)

    WAVE_AMP  = S * 0.065
    WAVE_FREQ = 2.0 * math.pi / (S * 0.75)
    WAVE_Y0   = cy + S * 0.14   # vertical center of wave

    def wave_y(px_):
        return WAVE_Y0 + WAVE_AMP * math.sin(WAVE_FREQ * (px_ - S * 0.05) + math.pi * 0.3)

    for y in range(S):
        for x in range(S):
            px, py = x + 0.5, y + 0.5

            # distance to wave curve (sampled at nearest horizontal neighbour)
            wy = wave_y(px)
            dist_wave = abs(py - wy)

            i = (y * S + x) * 4
            col = (buf[i], buf[i+1], buf[i+2], buf[i+3])

            # only draw the wave in the lower portion of the frame
            if py < WAVE_Y0 - WAVE_AMP * 2.5: continue

            # fade at edges
            edge_fade = smoothstep(0, S*0.06, px) * smoothstep(S, S*0.94, px)
            if edge_fade <= 0: continue

            # glow
            glow_aa = smoothstep(WAVE_W_GLOW, 0, dist_wave) * 0.75 * edge_fade
            if glow_aa > 0:
                col = blend((WAVE_2[0], WAVE_2[1], WAVE_2[2],
                             int(WAVE_2[3] * glow_aa)), col)
            # core
            core_aa = smoothstep(WAVE_W_CORE, 0, dist_wave) * edge_fade
            if core_aa > 0:
                col = blend((WAVE_1[0], WAVE_1[1], WAVE_1[2],
                             int(WAVE_1[3] * core_aa)), col)

            buf[i:i+4] = col

    return bytes(buf), S

def scale_bilinear(src_buf, src_w, src_h, dst_w, dst_h):
    out = bytearray(dst_w * dst_h * 4)
    for y in range(dst_h):
        fy = (y + 0.5) * src_h / dst_h - 0.5
        y0 = max(0, int(fy)); y1 = min(src_h - 1, y0 + 1); ty = fy - y0
        for x in range(dst_w):
            fx = (x + 0.5) * src_w / dst_w - 0.5
            x0 = max(0, int(fx)); x1 = min(src_w - 1, x0 + 1); tx = fx - x0
            def px(r, c):
                i = (r * src_w + c) * 4; return src_buf[i:i+4]
            def lerp(a, b, t): return [int(a[j]+(b[j]-a[j])*t) for j in range(4)]
            top = lerp(px(y0,x0), px(y0,x1), tx)
            bot = lerp(px(y1,x0), px(y1,x1), tx)
            res = lerp(top, bot, ty)
            di = (y * dst_w + x) * 4; out[di:di+4] = res
    return bytes(out)

def scale_nearest(src_buf, src_w, src_h, dst_w, dst_h):
    out = bytearray(dst_w * dst_h * 4)
    for y in range(dst_h):
        sy = int(y * src_h / dst_h)
        for x in range(dst_w):
            sx = int(x * src_w / dst_w)
            si = (sy * src_w + sx) * 4; di = (y * dst_w + x) * 4
            out[di:di+4] = src_buf[si:si+4]
    return bytes(out)

def make_ico(png16, png32):
    num = 2
    header = struct.pack('<HHH', 0, 1, num)
    data_offset = 6 + num * 16
    entries = b''
    images = [png16, png32]
    sizes  = [16, 32]
    off = data_offset
    for i, s in enumerate(sizes):
        entries += struct.pack('<BBBBHHII', s, s, 0, 0, 1, 32, len(images[i]), off)
        off += len(images[i])
    return header + entries + b''.join(images)

def main():
    out_dir = os.path.dirname(os.path.abspath(__file__))
    print("Shadow Nexus Wave — generating icons...")

    # render at 256 for high-quality downscaling
    src_buf, src_s = render(256)
    print(f"  ✓  Base {src_s}x{src_s} rendered")

    specs = [
        ('favicon-16x16.png',    16,  'nearest'),
        ('favicon-32x32.png',    32,  'bilinear'),
        ('apple-touch-icon.png', 180, 'bilinear'),
        ('icon-192.png',         192, 'bilinear'),
        ('icon-192-maskable.png',192, 'bilinear'),
        ('icon-512.png',         512, 'bilinear'),
        ('icon-512-maskable.png',512, 'bilinear'),
    ]

    pngs = {}
    for filename, size, method in specs:
        if method == 'nearest':
            scaled = scale_nearest(src_buf, src_s, src_s, size, size)
        else:
            scaled = scale_bilinear(src_buf, src_s, src_s, size, size)
        data = make_png(scaled, size, size)
        path = os.path.join(out_dir, filename)
        with open(path, 'wb') as f:
            f.write(data)
        pngs[size] = data
        print(f"  ✓  {filename}  ({size}x{size}, {len(data):,} bytes)")

    ico = make_ico(pngs[16], pngs[32])
    with open(os.path.join(out_dir, 'favicon.ico'), 'wb') as f:
        f.write(ico)
    print(f"  ✓  favicon.ico  ({len(ico):,} bytes)")

    print("\nAll Shadow Nexus Wave icons generated! 🌑⚡🌊")

if __name__ == '__main__':
    main()
