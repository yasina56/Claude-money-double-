#!/usr/bin/env python3
"""Hydraulic press vs. 1 ball: every crushed ball splits into MORE, SMALLER balls.

A 2D physics simulation rendered to a vertical 1080x1920 / 60 fps MP4 with
synthesized pop sounds. Each generation splits into one more ball than the
last (x2, x3, x4, x5, x6, x7) and every new generation is smaller.

    pip install numpy pillow scipy      # plus ffmpeg on PATH
    python3 ball_split/split_press.py -o split_press.mp4

Options: --seed, --fps, --max-seconds, --workers, --preview (half resolution, quick).
"""
import argparse
import math
import os
import subprocess
import sys
import tempfile
import time
import wave
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy.spatial import cKDTree

# ---------------------------------------------------------------- layout ---
W, H = 1080, 1920
GL, GR = 70, 1010          # glass inner walls (x)
GT, GB = 440, 1480         # glass ceiling / floor (y)
CX = (GL + GR) // 2
PAD_HW = 280               # half width of the press pad
TOP_HW = 78                # half width of the trapezoid top
HEAD_H = 150               # pad bottom -> trapezoid top
STRIPE_H = 34              # hazard stripe on the pad bottom
ROD_HW = 22
REST_Y = 760               # pad bottom when the press is up
LOW_Y = GB - 1             # pad bottom at full stroke

# ------------------------------------------------------------ generations ---
RADII = [70, 46, 30, 19.5, 12.5, 7.8, 4.8]   # ball radius per generation
SPLIT = [2, 3, 4, 5, 6, 7]               # children per crushed ball of gen g
MAXG = len(RADII) - 1
COLORS = ["#34d6e8", "#3b8dff", "#6a5cff", "#a45cff", "#e45cd6", "#ff5c8a", "#ffb43b"]

# --------------------------------------------------------------- physics ---
GRAV = 2600.0
SUB = 6
E_BALL = 0.25
E_WALL = 0.75
E_FLOOR = 0.55
E_PAD = 0.25
IMMUNE = 0.30              # seconds a newborn ball can't be crushed
CENTERING = 260.0          # gentle pull toward the press for balls on the floor
VMAX = 1900.0
DRAG = 0.8                 # 1/s air drag, keeps big bursts from spraying forever


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def head_poly(pb):
    """Convex outline of the press head for a given pad-bottom y."""
    top = pb - HEAD_H
    sh = pb - STRIPE_H
    return np.array([
        [CX - TOP_HW, top], [CX + TOP_HW, top],
        [CX + PAD_HW, sh], [CX + PAD_HW, pb],
        [CX - PAD_HW, pb], [CX - PAD_HW, sh],
    ], dtype=np.float64)


def rod_poly(pb):
    top = GT - 10
    bot = pb - HEAD_H + 2
    return np.array([[CX - ROD_HW, top], [CX + ROD_HW, top],
                     [CX + ROD_HW, bot], [CX - ROD_HW, bot]], dtype=np.float64)


def collide_poly(pos, vel, rad, poly, pvy, e=E_PAD):
    """Push circles out of a convex polygon moving vertically at pvy.

    Returns (indices in contact, contact normals, penetration before push).
    """
    mn, mx = poly.min(0), poly.max(0)
    cand = np.nonzero((pos[:, 0] + rad > mn[0]) & (pos[:, 0] - rad < mx[0]) &
                      (pos[:, 1] + rad > mn[1]) & (pos[:, 1] - rad < mx[1]))[0]
    if len(cand) == 0:
        return cand, np.zeros((0, 2)), np.zeros(0)
    p, r = pos[cand], rad[cand]
    a = poly
    b = np.roll(poly, -1, 0)
    ed = b - a
    L = np.linalg.norm(ed, axis=1)
    t_ = ed / L[:, None]
    n = np.stack([t_[:, 1], -t_[:, 0]], 1)
    c = poly.mean(0)
    n *= np.sign(((a - c) * n).sum(1))[:, None]
    rel = p[:, None, :] - a[None]
    s = (rel * n[None]).sum(2)                       # signed distance per edge
    inside = (s <= 0).all(1)
    tt = np.clip((rel * t_[None]).sum(2), 0, L[None])
    q = a[None] + tt[..., None] * t_[None]
    dv = p[:, None, :] - q
    d = np.linalg.norm(dv, axis=2)
    ar = np.arange(len(cand))
    j = d.argmin(1)
    dmin = d[ar, j]
    nout = dv[ar, j] / np.maximum(dmin, 1e-9)[:, None]
    js = s.argmax(1)
    nin = n[js]
    normal = np.where(inside[:, None], nin, nout)
    pen = np.where(inside, r - s[ar, js], r - dmin)
    hit = pen > 0
    idx = cand[hit]
    normal, pen = normal[hit], pen[hit]
    if len(idx) == 0:
        return idx, normal, pen
    pos[idx] += normal * pen[:, None]
    pv = np.array([0.0, pvy])
    vrel = vel[idx] - pv
    vn = (vrel * normal).sum(1)
    neg = vn < 0
    vel[idx[neg]] -= ((1 + e) * vn[neg])[:, None] * normal[neg]
    return idx, normal, pen


class Press:
    """down (ease-in slam) -> hold -> up (smooth) -> wait, repeated."""

    def __init__(self, rng, first_slam):
        self.rng = rng
        self.y = REST_Y
        self.phase = "wait"
        self.t = 0.0
        self.dur = first_slam
        self.slams = 0
        self.stopped = False

    def step(self, dt):
        """Advance; returns (pad_y, pad_vy, slam_landed)."""
        y0 = self.y
        landed = False
        self.t += dt
        if self.phase == "wait":
            if self.t >= self.dur and not self.stopped:
                self.phase, self.t, self.dur = "down", 0.0, 0.30
        elif self.phase == "down":
            u = min(self.t / self.dur, 1.0)
            self.y = REST_Y + (LOW_Y - REST_Y) * u * u
            if u >= 1.0:
                self.phase, self.t, self.dur = "hold", 0.0, 0.12
                landed = True
                self.slams += 1
        elif self.phase == "hold":
            if self.t >= self.dur:
                self.phase, self.t, self.dur = "up", 0.0, 0.62
        elif self.phase == "up":
            u = min(self.t / self.dur, 1.0)
            s = u * u * (3 - 2 * u)
            self.y = LOW_Y + (REST_Y - LOW_Y) * s
            if u >= 1.0:
                self.phase, self.t = "wait", 0.0
                self.dur = 0.95 if self.slams < 3 else self.rng.uniform(0.45, 0.7)
        return self.y, (self.y - y0) / dt, landed


def simulate(fps, max_seconds, seed):
    rng = np.random.default_rng(seed)
    dt = 1.0 / fps / SUB
    pos = np.array([[CX + 6.0, GT + 200.0]])
    vel = np.array([[0.0, 0.0]])
    gen = np.array([0], dtype=np.int8)
    born = np.array([-10.0])
    press = Press(rng, first_slam=1.6)

    frames = []
    crushes = []        # (time, x, y, gen)
    slams = []          # time
    end_frame = None
    f = 0
    tnow = 0.0
    while True:
        for _ in range(SUB):
            tnow += dt
            pb, pvy, landed = press.step(dt)
            if landed:
                slams.append(tnow)
            rad = np.array(RADII, dtype=np.float64)[gen]

            # integrate
            vel[:, 1] += GRAV * dt
            vel *= 1.0 - DRAG * dt
            on_floor = pos[:, 1] > GB - rad * 2.2
            vel[on_floor, 0] -= np.sign(pos[on_floor, 0] - CX) * CENTERING * dt
            sp = np.linalg.norm(vel, axis=1)
            fast = sp > VMAX
            vel[fast] *= (VMAX / sp[fast])[:, None]
            pos += vel * dt

            # ball-ball
            if len(pos) > 1:
                tree = cKDTree(pos)
                pairs = tree.query_pairs(2 * rad.max(), output_type="ndarray")
                if len(pairs):
                    i, j = pairs[:, 0], pairs[:, 1]
                    d = pos[j] - pos[i]
                    dist = np.linalg.norm(d, axis=1)
                    ov = rad[i] + rad[j] - dist
                    m = ov > 0
                    i, j, d, dist, ov = i[m], j[m], d[m], dist[m], ov[m]
                    if len(i):
                        n = d / np.maximum(dist, 1e-6)[:, None]
                        mi, mj = rad[i] ** 2, rad[j] ** 2
                        corr = ov * 0.8
                        np.add.at(pos, i, -n * (corr * mj / (mi + mj))[:, None])
                        np.add.at(pos, j, n * (corr * mi / (mi + mj))[:, None])
                        rv = ((vel[j] - vel[i]) * n).sum(1)
                        a = rv < 0
                        J = -(1 + E_BALL) * rv[a] / (1 / mi[a] + 1 / mj[a])
                        np.add.at(vel, i[a], -n[a] * (J / mi[a])[:, None])
                        np.add.at(vel, j[a], n[a] * (J / mj[a])[:, None])

            # glass
            lo = pos[:, 0] < GL + rad
            pos[lo, 0] = GL + rad[lo]
            vel[lo, 0] = np.abs(vel[lo, 0]) * E_WALL
            hi = pos[:, 0] > GR - rad
            pos[hi, 0] = GR - rad[hi]
            vel[hi, 0] = -np.abs(vel[hi, 0]) * E_WALL
            ce = pos[:, 1] < GT + rad
            pos[ce, 1] = GT + rad[ce]
            vel[ce, 1] = np.abs(vel[ce, 1]) * E_WALL
            fl = pos[:, 1] > GB - rad
            pos[fl, 1] = GB - rad[fl]
            vel[fl, 1] = np.where(vel[fl, 1] > 0, -vel[fl, 1] * E_FLOOR, vel[fl, 1])
            vel[fl, 0] *= 0.9985

            # press
            collide_poly(pos, vel, rad, rod_poly(pb), pvy)
            idx, nrm, pen = collide_poly(pos, vel, rad, head_poly(pb), pvy)
            if len(idx):
                under = nrm[:, 1] > 0.6
                age = tnow - born[idx]
                crushable = (gen[idx] < MAXG) & (age > IMMUNE)
                gap = GB - pb
                crush = under & crushable & (pvy > 50) & ((pen > 0.45 * rad[idx]) | (gap < 2 * rad[idx] * 0.92))
                # anything else stuck under the pad with no room squeezes out sideways
                squeeze = under & ~crush & (gap < 2 * rad[idx] * 0.92)
                for k in idx[squeeze]:
                    side = -1 if pos[k, 0] < CX else 1
                    pos[k, 0] = CX + side * (PAD_HW + rad[k] + 1)
                    pos[k, 1] = min(pos[k, 1], GB - rad[k])
                    vel[k] = [side * rng.uniform(500, 900), -rng.uniform(0, 300)]
                cidx = idx[crush]
                if len(cidx):
                    new_p, new_v, new_g = [], [], []
                    for k in cidx:
                        g = int(gen[k])
                        x, y = pos[k]
                        crushes.append((tnow, x, y, g))
                        nr = RADII[g + 1]
                        nk = SPLIT[g]
                        room = (GB - pb) > 2 * nr + 2
                        for c in range(nk):
                            side = -1 if (c % 2 == 0) ^ (x > CX) else 1
                            if room:
                                cx_ = x + side * rng.uniform(0, rad[k])
                                cy_ = min(pb + nr + 1 + rng.uniform(0, rad[k]), GB - nr)
                                vx = side * rng.uniform(500, 1300)
                                vy = rng.uniform(-200, 600)
                            else:
                                cx_ = CX + side * (PAD_HW + nr + 1 + rng.uniform(0, 3 * nr))
                                cy_ = GB - nr - rng.uniform(0, 4 * nr)
                                vx = side * rng.uniform(450, 1100)
                                vy = -rng.uniform(200, 900) * (1.0 - 0.1 * g)
                            new_p.append((cx_, cy_))
                            new_v.append((vx, vy))
                            new_g.append(g + 1)
                    keep = np.ones(len(pos), bool)
                    keep[cidx] = False
                    pos = np.concatenate([pos[keep], np.array(new_p)])
                    vel = np.concatenate([vel[keep], np.array(new_v)])
                    gen = np.concatenate([gen[keep], np.array(new_g, dtype=np.int8)])
                    born = np.concatenate([born[keep], np.full(len(new_p), tnow)])

        frames.append((pos.astype(np.float32).copy(), gen.copy(), float(press.y)))
        f += 1
        if end_frame is None:
            done = not (gen < MAXG).any() or tnow > max_seconds
            if done:
                press.stopped = True
                if press.phase == "wait":
                    end_frame = f + int(4.5 * fps)
        elif f >= end_frame:
            break
        if f % fps == 0:
            print(f"  sim t={tnow:5.1f}s  balls={len(pos):5d}  max gen={gen.max()}", flush=True)
    return frames, crushes, slams, (end_frame - int(4.5 * fps))


# ------------------------------------------------------------- rendering ---
FONT_XB = "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf"
FONT_B = "/usr/share/fonts/opentype/inter/Inter-Bold.otf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)


def sphere_sprite(r, color, ss=4):
    """Shaded glossy sphere, RGBA, size about 2r+2."""
    R = r * ss
    n = int(math.ceil(2 * R + 2 * ss))
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64) + 0.5
    c = n / 2
    dx, dy = (xx - c) / R, (yy - c) / R
    d2 = dx * dx + dy * dy
    inside = d2 <= 1
    z = np.sqrt(np.clip(1 - d2, 0, 1))
    lx, ly, lz = -0.45, -0.55, 0.70
    diff = np.clip(dx * lx + dy * ly + z * lz, 0, 1)
    base = np.array(hexrgb(color), np.float64) / 255
    col = base[None, None, :] * (0.28 + 0.85 * diff[..., None])
    hx, hy = dx + 0.38, dy + 0.42
    spec = np.exp(-(hx * hx + hy * hy) / 0.035)
    col += spec[..., None] * 0.85
    rim = np.clip((np.sqrt(d2) - 0.75) / 0.25, 0, 1) * (dy > 0)
    col += rim[..., None] * base[None, None, :] * 0.35
    alpha = np.clip((1 - np.sqrt(d2)) * R, 0, 1)
    rgba = np.dstack([np.clip(col, 0, 1) * 255, alpha * 255]).astype(np.uint8)
    img = Image.fromarray(rgba, "RGBA")
    size = max(3, int(round(n / ss)))
    return img.resize((size, size), Image.LANCZOS)


def hazard(w, h, stripe=26):
    img = Image.new("RGBA", (w, h), (24, 24, 28, 255))
    d = ImageDraw.Draw(img)
    for x in range(-h, w + h, stripe * 2):
        d.polygon([(x, h), (x + stripe, h), (x + stripe + h, 0), (x + h, 0)], fill=(255, 196, 30, 255))
    return img


def metal_gradient(w, h, horizontal):
    t = np.linspace(0, 1, w if horizontal else h)
    v = 120 + 110 * np.sin(np.pi * np.clip(t * 1.1 - 0.05, 0, 1)) ** 0.7
    v = v - 40 * t
    arr = np.clip(v, 0, 255).astype(np.uint8)
    if horizontal:
        a = np.tile(arr[None, :], (h, 1))
    else:
        a = np.tile(arr[:, None], (1, w))
    rgb = np.dstack([a * 0.92, a * 0.95, a * 1.0]).clip(0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, np.full((h, w), 255, np.uint8)]), "RGBA")


def build_static():
    bg = np.zeros((H, W, 3), np.float64)
    t = np.linspace(0, 1, H)[:, None]
    top, bot = np.array([26, 22, 70]), np.array([10, 16, 38])
    bg[:] = (top * (1 - t) + bot * t)[:, None, :][:, 0][:, None, :]
    img = Image.fromarray(bg.astype(np.uint8), "RGB")
    d = ImageDraw.Draw(img, "RGBA")
    # grid inside glass
    for x in range(GL, GR, 48):
        d.line([(x, GT), (x, GB)], fill=(120, 140, 255, 22), width=1)
    for y in range(GT, GB, 48):
        d.line([(GL, y), (GR, y)], fill=(120, 140, 255, 22), width=1)
    d.rounded_rectangle([GL - 6, GT - 30, GR + 6, GB + 6], radius=26, fill=(110, 140, 255, 14))

    # title
    f1, f2, f3 = font(FONT_XB, 60), font(FONT_XB, 92), font(FONT_XB, 52)

    def ctext(y, s, f, fill):
        tw = d.textlength(s, font=f)
        d.text(((W - tw) / 2 + 3, y + 4), s, font=f, fill=(0, 0, 0, 140))
        d.text(((W - tw) / 2, y), s, font=f, fill=fill)
    ctext(92, "Every crushed ball splits into", f1, (255, 255, 255, 255))
    ctext(168, "MORE balls", f2, (255, 77, 94, 255))
    ctext(290, "...but each one gets SMALLER", f3, (255, 200, 61, 255))

    # hazard bar and HUD label
    img.paste(hazard(W, 18, 22), (0, GB + 34))
    lab = font(FONT_B, 30)
    s = "B A L L S"
    d.text(((W - d.textlength(s, font=lab)) / 2, GB + 76), s, font=lab, fill=(190, 196, 230, 255))

    # press mount (behind glass top edge)
    d.rectangle([CX - 120, GT - 52, CX + 120, GT - 12], fill=(70, 74, 90, 255))
    img.paste(hazard(240, 12, 12), (CX - 120, GT - 64))

    # glass front: outline + reflection streak
    front = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    fd = ImageDraw.Draw(front)
    fd.rounded_rectangle([GL - 6, GT - 30, GR + 6, GB + 6], radius=26,
                         outline=(225, 232, 255, 215), width=6)
    fd.line([(GL - 6, GT - 30), (GR + 6, GT - 30)], fill=(0, 0, 0, 0), width=8)
    streak = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(streak)
    sd.polygon([(GL + 40, GT), (GL + 90, GT), (GL + 30, GB - 40), (GL + 4, GB - 40)], fill=(255, 255, 255, 18))
    front.alpha_composite(streak.filter(ImageFilter.GaussianBlur(6)))

    # press head sprite
    hw = 2 * PAD_HW
    head = Image.new("RGBA", (hw, HEAD_H), (0, 0, 0, 0))
    grad = metal_gradient(hw, HEAD_H - STRIPE_H, horizontal=False)
    mask = Image.new("L", (hw, HEAD_H - STRIPE_H), 0)
    ImageDraw.Draw(mask).polygon([(PAD_HW - TOP_HW, 0), (PAD_HW + TOP_HW, 0),
                                  (hw, HEAD_H - STRIPE_H), (0, HEAD_H - STRIPE_H)], fill=255)
    head.paste(grad, (0, 0), mask)
    hd = ImageDraw.Draw(head)
    hd.rectangle([0, HEAD_H - STRIPE_H - 6, hw, HEAD_H - STRIPE_H], fill=(150, 156, 172, 255))
    head.alpha_composite(hazard(hw, STRIPE_H, 24), (0, HEAD_H - STRIPE_H))
    hd.ellipse([PAD_HW - 7, HEAD_H - STRIPE_H - 22, PAD_HW + 7, HEAD_H - STRIPE_H - 8], fill=(255, 60, 60, 255))
    rod = metal_gradient(2 * ROD_HW, GB, horizontal=True)

    sprites = [sphere_sprite(r, c) for r, c in zip(RADII, COLORS)]
    icon_r = [max(9, r * 0.55) for r in RADII]
    icons = [sphere_sprite(r, c) for r, c in zip(icon_r, COLORS)]
    return dict(bg=img, front=front, head=head, rod=rod, sprites=sprites, icons=icons)


S = None
ARGS = None


def _init(args):
    global S, ARGS
    ARGS = args
    S = build_static()


def render(job):
    pos, gen, pb, hud = job
    img = S["bg"].copy()
    d = ImageDraw.Draw(img, "RGBA")

    # crush flashes (behind balls)
    for (age, x, y, g) in hud["flashes"]:
        a = age / 0.30
        r = RADII[g] * (1.0 + 1.6 * a)
        col = hexrgb(COLORS[g])
        al = int(230 * (1 - a))
        d.ellipse([x - r, y - r, x + r, y + r], outline=col + (al,), width=max(2, int(6 * (1 - a))))

    sprites = S["sprites"]
    order = np.argsort(-gen, kind="stable")          # big balls on top
    for k in order:
        sp = sprites[gen[k]]
        h = sp.size[0] // 2
        img.paste(sp, (int(pos[k, 0]) - h, int(pos[k, 1]) - h), sp)

    # press
    rod_len = int(pb - HEAD_H - (GT - 12)) + 4
    if rod_len > 0:
        img.paste(S["rod"].crop((0, 0, 2 * ROD_HW, rod_len)), (CX - ROD_HW, GT - 12))
    img.paste(S["head"], (CX - PAD_HW, int(round(pb)) - HEAD_H), S["head"])
    img.paste(S["front"], (0, 0), S["front"])

    # counter
    fnum = font(FONT_XB, 128)
    s = f"{hud['count']:,}"
    tw = d.textlength(s, font=fnum)
    d.text(((W - tw) / 2, GB + 104), s, font=fnum, fill=(255, 255, 255, 255))
    if hud["plus"] > 0 and hud["plus_age"] < 1.0:
        a = hud["plus_age"]
        fp = font(FONT_XB, 50)
        al = int(255 * (1 - a) ** 0.6)
        d.text(((W + tw) / 2 + 14, GB + 112 - 30 * a), f"+{hud['plus']:,}", font=fp, fill=(255, 200, 61, al))

    # generation legend: size + split factor per generation
    icons = S["icons"]
    fx = font(FONT_XB, 38)
    widths = [ic.size[0] for ic in icons]
    gapw = 78
    total = sum(widths) + gapw * (len(icons) - 1)
    x = (W - total) / 2
    yc = GB + 320
    reached = hud["maxgen"]
    for g, ic in enumerate(icons):
        icon = ic
        if g > reached:
            icon = ic.copy()
            icon.putalpha(icon.getchannel("A").point(lambda v: v * 0.22))
        img.paste(icon, (int(x), int(yc - ic.size[1] / 2)), icon)
        x += ic.size[0]
        if g < len(SPLIT):
            lbl = f"×{SPLIT[g]}"
            al = 255 if g < reached else 70
            lw = d.textlength(lbl, font=fx)
            d.text((x + (gapw - lw) / 2, yc - 20), lbl, font=fx,
                   fill=(255, 200, 61, al) if g == reached - 1 else (210, 214, 240, al))
            x += gapw

    # ending card
    if hud["end_a"] > 0:
        a = hud["end_a"]
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(ov)
        od.rounded_rectangle([GL + 40, 700, GR - 40, 1120], radius=36, fill=(8, 10, 30, int(215 * a)),
                             outline=(255, 200, 61, int(255 * a)), width=5)
        fa, fb, fc = font(FONT_XB, 64), font(FONT_XB, 120), font(FONT_B, 40)
        for y, s, f, col in [(740, "1 ball became", fa, (255, 255, 255)),
                             (830, f"{hud['count']:,}", fb, (255, 200, 61)),
                             (990, "×2 ×3 ×4 ×5 ×6 ×7", fc, (210, 214, 240))]:
            tw = od.textlength(s, font=f)
            od.text(((W - tw) / 2, y), s, font=f, fill=col + (int(255 * a),))
        img.paste(ov, (0, 0), ov)

    if ARGS.preview:
        img = img.resize((W // 2, H // 2), Image.BILINEAR)
    return img.tobytes()


# ----------------------------------------------------------------- audio ---
def make_audio(path, n_frames, fps, crushes, slams, seed):
    sr = 48000
    rng = np.random.default_rng(seed + 1)
    out = np.zeros(int(n_frames / fps * sr) + sr, np.float64)

    def add(t, sig):
        i = int(t * sr)
        j = min(len(out), i + len(sig))
        out[i:j] += sig[: j - i]

    # thud on every slam
    tt = np.arange(int(0.35 * sr)) / sr
    thud = (np.sin(2 * np.pi * (55 + 60 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 11) * 0.9
            + rng.normal(0, 1, len(tt)) * np.exp(-tt * 60) * 0.25)
    for t in slams:
        add(t, thud)

    # pops: higher pitch for smaller balls; thin out bursts so they don't clip
    bucket = {}
    for (t, x, y, g) in crushes:
        bucket.setdefault(int(t * 50), []).append((t, g))
    for evs in bucket.values():
        if len(evs) > 6:
            pick = rng.choice(len(evs), 6, replace=False)
            evs = [evs[i] for i in pick]
        for (t, g) in evs:
            f0 = 260 * 1.32 ** g * rng.uniform(0.9, 1.1)
            dur = 0.11 - 0.008 * g
            tp = np.arange(int(dur * sr)) / sr
            freq = f0 * (1 + 1.5 * np.exp(-tp * 60))
            ph = 2 * np.pi * np.cumsum(freq) / sr
            sig = np.sin(ph) * np.exp(-tp * (38 + 6 * g)) * 0.45
            sig[:int(0.003 * sr)] += rng.normal(0, 0.35, int(0.003 * sr))
            add(t + rng.uniform(0, 0.01), sig)
    out = np.tanh(out * 1.2) * 0.85
    pcm = (out * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


# ------------------------------------------------------------------ main ---
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--output", default="split_press.mp4")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--max-seconds", type=float, default=40.0)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--preview", action="store_true", help="half resolution")
    ap.add_argument("--still", type=float, nargs="*", help="only write PNG stills at these times (s)")
    args = ap.parse_args()

    t0 = time.time()
    print("Simulating...", flush=True)
    frames, crushes, slams, done_frame = simulate(args.fps, args.max_seconds, args.seed)
    n = len(frames)
    print(f"  {n} frames ({n / args.fps:.1f}s), {len(crushes)} crushes, {len(slams)} slams, "
          f"final count {len(frames[-1][0])}  [{time.time() - t0:.0f}s]", flush=True)

    # per-frame HUD state
    fps = args.fps
    crush_t = np.array([c[0] for c in crushes]) if crushes else np.zeros(0)
    jobs = []
    plus, plus_t, last_count = 0, -9.0, 1
    maxgen = 0
    ci = 0
    for f, (pos, gen, pb) in enumerate(frames):
        t = (f + 1) / fps
        cnt = len(pos)
        if cnt > last_count:
            if t - plus_t > 0.5:
                plus = 0
            plus += cnt - last_count
            plus_t = t
        last_count = cnt
        maxgen = max(maxgen, int(gen.max()))
        lo = np.searchsorted(crush_t, t - 0.30)
        hi = np.searchsorted(crush_t, t)
        fl = [(t - crushes[k][0], crushes[k][1], crushes[k][2], crushes[k][3]) for k in range(lo, hi)]
        if len(fl) > 400:
            fl = fl[-400:]
        end_a = float(np.clip((f - done_frame - fps * 0.6) / (fps * 0.5), 0, 1))
        hud = dict(count=cnt, plus=plus, plus_age=t - plus_t, maxgen=maxgen, flashes=fl, end_a=end_a)
        jobs.append((pos, gen, pb, hud))

    if args.still:
        _init(args)
        for s in args.still:
            k = min(n - 1, int(s * fps))
            img = Image.frombytes("RGB", (W // 2, H // 2) if args.preview else (W, H), render(jobs[k]))
            p = f"{os.path.splitext(args.output)[0]}_{s:05.1f}s.png"
            img.save(p)
            print("wrote", p)
        return

    tmpdir = tempfile.mkdtemp()
    wav = os.path.join(tmpdir, "audio.wav")
    make_audio(wav, n, fps, crushes, slams, args.seed)
    ow, oh = (W // 2, H // 2) if args.preview else (W, H)
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{ow}x{oh}",
           "-r", str(fps), "-i", "-", "-i", wav, "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart",
           args.output]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    print(f"Rendering with {args.workers} workers...", flush=True)
    with Pool(args.workers, initializer=_init, initargs=(args,)) as pool:
        for k, buf in enumerate(pool.imap(render, jobs, chunksize=4)):
            ff.stdin.write(buf)
            if k % (fps * 2) == 0:
                print(f"  frame {k}/{n}  [{time.time() - t0:.0f}s]", flush=True)
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg failed")
    print(f"Wrote {args.output}  [{time.time() - t0:.0f}s]")


if __name__ == "__main__":
    main()
