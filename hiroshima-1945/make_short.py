#!/usr/bin/env python3
"""Hiroshima, 1945 -- a pedestrian's view. A low-poly 3D narrated short.

A second-person account of the morning of 6 August 1945, built from widely
documented survivor (hibakusha) testimony. People are shown as simple faceless
figures and the injuries are not depicted; the tone is meant to be sober.

It reuses the renderer pieces, Kokoro narration, Whisper word timing and
captions from ../while-youre-at-work/make_short.py.

    pip install pycairo numpy kokoro-onnx faster-whisper     # plus FFmpeg
    python3 make_short.py              # -> out/hiroshima-1945.mp4
    python3 make_short.py --sheet      # -> out/sheet.png, one frame per shot
    python3 make_short.py --still 9.2  # -> out/still.png
"""
import argparse
import math
import os
import re
import subprocess
import sys
import wave
from multiprocessing import Pool

import cairo
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "while-youre-at-work"))
import make_short as base  # noqa: E402  (renderer, TTS, alignment, captions)
from make_short import Model, box, cone, ell, rot_x, rot_y, rot_z, hexc, clamp, smooth, Camera, clip_near  # noqa: E402

OUT = os.path.join(HERE, "out")
W, H, FPS = base.W, base.H, base.FPS
TAU = math.tau

# ============================================================================ script
# (narration, [(shot, words it covers), ...])
SEGMENTS = [
    ("August sixth, 1945. Hiroshima.", [("establish", 4)]),
    ("It's a quarter past eight in the morning, and you're walking to work.", [("street_walk", 8), ("crowd", 5)]),
    ("The air raid alarm ended earlier. The sky is clear.", [("siren", 6), ("sky", 4)]),
    ("Then, a flash. Brighter than the sun.", [("flash", 7)]),
    ("Survivors called it pika-don. The flash, then the boom.", [("blast", 9)]),
    ("Dust turns the morning into night.", [("dust", 6)]),
    ("When it clears, the city is gone.", [("ruins", 7)]),
    ("Fires spread. People walk in silence toward the rivers, asking for water.", [("fires", 2), ("river_walk", 10)]),
    ("About half an hour later, a black rain falls.", [("black_rain", 9)]),
    ("On the steps of a bank, one person left only a shadow.", [("shadow", 12)]),
    ("By the end of that year, around a hundred and forty thousand people had died.", [("dome_dusk", 15)]),
    ("The survivors, the hibakusha, spent their lives sharing what they saw, so it would never happen again.",
     [("lanterns", 17)]),
]
# lines spoken together, and the silence after each (the long one is the flash)
UTTERANCES = [([0], 0.6), ([1], 0.3), ([2], 0.55), ([3], 1.4), ([4], 0.5), ([5], 0.6), ([6], 0.6),
              ([7], 0.55), ([8], 0.6), ([9], 0.8), ([10], 0.8), ([11], 0.0)]
SAY = {"pika-don.": "peeka don.", "hibakusha,": "hibbakusha,"}  # pronunciation hints for the TTS only
SPEED = 0.86
SOURCES = "Based on survivor accounts  ·  Sources: Hiroshima Peace Memorial Museum, ICRC"

# ============================================================================ palette
SKY_DAY = (hexc("#5E9BD6"), hexc("#CFE3EF"))
SKY_ASH = (hexc("#2B1D16"), hexc("#8A5A3A"))
SKY_DUSK = (hexc("#2E2B5C"), hexc("#F2A66B"))
PLASTER, WOOD, WOOD2, ROOF = hexc("#D8CCB2"), hexc("#6B5038"), hexc("#8C6E52"), hexc("#3F4652")
ROAD, EARTH, TRACK = hexc("#9C9384"), hexc("#7E8A5E"), hexc("#5A5650")
CHAR = [hexc("#3A2E28"), hexc("#55463A"), hexc("#6E6052"), hexc("#2A2422"), hexc("#7D6B57")]
SKIN, HAIR = hexc("#D9AE88"), hexc("#2A2420")
CLOTHES = [hexc("#E8E4D8"), hexc("#B9AC8E"), hexc("#7C7A62"), hexc("#3E4656"), hexc("#D9D2C2"), hexc("#8D7F6A")]


def rnd(i, salt=0):
    """Deterministic pseudo-random number in [0, 1) for particle layouts."""
    return (math.sin(i * 12.9898 + salt * 78.233) * 43758.5453) % 1.0


class Sun:
    def __init__(self, d=(-0.45, 0.8, 0.4), tint=(1, 1, 1), amb=0.55, dif=0.55):
        self.dir = np.array(d, float) / np.linalg.norm(d)
        self.tint, self.amb, self.dif = np.array(tint, float), amb, dif


DAY = Sun()
ASH = Sun((0.3, 0.5, 0.6), (1.0, 0.72, 0.5), 0.42, 0.35)
DUSK = Sun((0.6, 0.45, -0.3), (1.0, 0.82, 0.72), 0.5, 0.45)


# ============================================================================ models
def gable(name, lo, hi, ridge, col, over=0.35):
    """A gabled roof sitting on the box lo..hi, ridge running along z."""
    (xa, _, za), (xb, y, zb) = lo, hi
    xa, xb, za, zb = xa - over, xb + over, za - over, zb + over
    xm = (xa + xb) / 2
    V = np.array([(xa, y, za), (xb, y, za), (xb, y, zb), (xa, y, zb), (xm, y + ridge, za), (xm, y + ridge, zb)], float)
    F = np.array([(0, 3, 5), (0, 5, 4), (1, 4, 5), (1, 5, 2), (0, 4, 1), (3, 2, 5), (0, 1, 2), (0, 2, 3)])
    m = Model()
    m.meshes.append((V, base._orient(V, F), base._colors(len(F), col, name)))
    return m


def house(i, side, z):
    rng = np.random.default_rng(i * 31 + (side + 2) * 7)
    w = 5.0 + rng.random() * 2.0
    dep = 6.0 + rng.random() * 2.0
    two = rng.random() < 0.55
    h = 5.6 if two else 3.1
    x0 = side * 4.7
    xf = side * (4.7 + dep)
    lo, hi = (min(x0, xf), 0, z - w / 2), (max(x0, xf), h, z + w / 2)
    wall = [PLASTER, WOOD, WOOD2][int(rng.random() * 3)]
    m = box(f"h{i}{side}", lo, hi, wall)
    m.add(gable(f"r{i}{side}", lo, hi, 1.3, ROOF * (0.9 + 0.2 * rng.random())))
    if two:
        m.add(box(f"sk{i}{side}", (min(x0, x0 - side * 0.8), 2.9, z - w / 2 - 0.2),
                  (max(x0, x0 - side * 0.8), 3.1, z + w / 2 + 0.2), ROOF))
    for fl in range(2 if two else 1):  # lattice windows facing the street
        y0 = 0.9 + fl * 2.8
        xs = x0 - side * 0.04
        m.add(box(f"w{i}{side}{fl}", (min(xs, xs - side * 0.05), y0, z - w / 3), (max(xs, xs - side * 0.05), y0 + 1.3, z + w / 3),
                  hexc("#2E2A26")))
    return m, (x0, z + w / 2)


STREET_Z = [3 - 7.2 * k for k in range(15)]


def person(name, walk=None, shirt=None, pants=None, hat=False, bow=0.0, scale=1.0):
    """A faceless low-poly figure facing +z, feet at the origin."""
    rng = np.random.default_rng(base._seed(name))
    shirt = shirt if shirt is not None else CLOTHES[int(rng.random() * len(CLOTHES))]
    pants = pants if pants is not None else CLOTHES[int(rng.random() * len(CLOTHES))] * 0.75
    sw = 0.0 if walk is None else math.sin(walk)
    m = Model()
    for sx in (-1, 1):
        leg = ell(f"{name}l{sx}", (0, -0.43, 0), (0.075, 0.44, 0.08), pants)
        leg.add(ell(f"{name}f{sx}", (0, -0.84, 0.05), (0.06, 0.04, 0.1), hexc("#2B2622")))
        leg.xform(rot_x(0.4 * sw * sx), t=(sx * 0.1, 0.88, 0))
        m.add(leg)
        arm = ell(f"{name}a{sx}", (0, -0.28, 0), (0.058, 0.3, 0.06), shirt)
        arm.add(ell(f"{name}hd{sx}", (0, -0.6, 0.0), (0.045, 0.055, 0.045), SKIN))
        arm.xform(rot_z(sx * 0.08) @ rot_x(-0.4 * sw * sx), t=(sx * 0.2, 1.36, 0))
        m.add(arm)
    m.add(ell(f"{name}t", (0, 1.12, 0), (0.2, 0.3, 0.13), shirt, sub=1))
    head = ell(f"{name}h", (0, 1.62, 0.0), (0.1, 0.12, 0.105), SKIN)
    head.add(ell(f"{name}hr", (0, 1.68, -0.02), (0.108, 0.085, 0.11), HAIR))
    if hat:
        head.add(ell(f"{name}hat", (0, 1.72, 0), (0.15, 0.05, 0.15), hexc("#C9B98F")))
    head.xform(rot_x(bow), pivot=(0, 1.48, 0))
    m.add(head)
    if scale != 1.0:
        m.xform(np.eye(3) * scale)
    return m


def place(m, pos, heading=0.0):
    m.xform(rot_y(heading), t=pos)
    return m


def streetcar(z):
    m = box("tram_lo", (-2.5, 0.35, z - 5), (-0.3, 1.6, z + 5), hexc("#3F6B4E"))
    m.add(box("tram_hi", (-2.5, 1.6, z - 5), (-0.3, 2.9, z + 5), hexc("#D9D0B4")))
    m.add(box("tram_roof", (-2.6, 2.9, z - 5.1), (-0.2, 3.15, z + 5.1), hexc("#55524C")))
    for k in range(6):
        zz = z - 4 + k * 1.6
        m.add(box(f"tw{k}", (-0.28, 1.8, zz - 0.55), (-0.25, 2.6, zz + 0.55), hexc("#2C3036")))
    m.add(box("tram_pole", (-1.45, 3.15, z + 3), (-1.35, 4.6, z + 3.1), hexc("#2A2A2A"), rot_x(-0.5), pivot=(-1.4, 3.15, z + 3)))
    return m


def dome_building(ruined=False, at=(14, 0, -112)):
    m = Model()
    stone = hexc("#9C8F78") if ruined else hexc("#CDB991")
    if not ruined:
        m.add(box("dm_main", (-13, 0, -5), (13, 10, 5), stone))
        for fl in range(3):
            for k in range(9):
                x = -11.5 + k * 2.9
                m.add(box(f"dmw{fl}{k}", (x, 1.2 + fl * 3, 5.0), (x + 1.2, 2.8 + fl * 3, 5.08), hexc("#3A3A3C")))
        m.add(box("dm_tower", (-3.6, 0, -3.6), (3.6, 16, 3.6), stone * 1.03))
        m.add(ell("dm_dome", (0, 16, 0), (3.9, 4.3, 3.9), hexc("#5D8A78"), sub=2, jitter=0.02))
    else:
        for k, (x0, x1, top) in enumerate(((-13, -9, 7.5), (-7, -3.8, 9.5), (3.8, 7.5, 8.5), (9, 13, 5.5))):
            m.add(box(f"dr_wall{k}", (x0, 0, 4.4), (x1, top, 5), stone * (0.9 + 0.05 * k)))
        m.add(box("dr_back", (-13, 0, -5), (13, 6.5, -4.4), stone * 0.85))
        for sx in (-1, 1):  # tower shell with window holes
            m.add(box(f"dr_tw{sx}", (sx * 3.6 - 0.3, 0, -3.6), (sx * 3.6 + 0.3, 16, 3.6), stone))
        m.add(box("dr_tf", (-3.6, 0, 3.3), (3.6, 16, 3.6), stone * 0.95))
        for fl in range(4):
            m.add(box(f"dr_hole{fl}", (-2.2, 1.5 + fl * 3.6, 3.6), (2.2, 3.6 + fl * 3.6, 3.65), hexc("#2A2420")))
        n = 12
        for k in range(n):  # the iron dome frame
            a = k * TAU / n
            for s in range(6):
                u0, u1 = s / 6 * math.pi / 2, (s + 1) / 6 * math.pi / 2
                p0 = np.array([3.8 * math.cos(u0) * math.cos(a), 16 + 4.2 * math.sin(u0), 3.8 * math.cos(u0) * math.sin(a)])
                p1 = np.array([3.8 * math.cos(u1) * math.cos(a), 16 + 4.2 * math.sin(u1), 3.8 * math.cos(u1) * math.sin(a)])
                mid, d = (p0 + p1) / 2, p1 - p0
                L = np.linalg.norm(d)
                yaw = math.atan2(d[0], d[2])
                pitch = -math.asin(clamp(d[1] / L, -1, 1))
                m.add(ell(f"rib{k}{s}", (0, 0, 0), (0.09, 0.09, L / 2 + 0.05), hexc("#2E2B29"), sub=1, jitter=0.0)
                      .xform(rot_y(yaw) @ rot_x(pitch), t=mid))
        for k in range(16):
            a0, a1 = k * TAU / 16, (k + 1) * TAU / 16
            p0 = np.array([3.8 * math.cos(a0), 16, 3.8 * math.sin(a0)])
            p1 = np.array([3.8 * math.cos(a1), 16, 3.8 * math.sin(a1)])
            mid, d = (p0 + p1) / 2, p1 - p0
            m.add(ell(f"ring{k}", (0, 0, 0), (0.12, 0.12, np.linalg.norm(d) / 2 + 0.05), hexc("#2E2B29"), sub=1, jitter=0)
                  .xform(rot_y(math.atan2(d[0], d[2])), t=mid))
    m.xform(rot_y(-0.35), t=at)
    return m


def mountains():
    m = Model()
    for k in range(9):
        rng = np.random.default_rng(100 + k)
        x = -260 + k * 65 + rng.random() * 30
        m.add(cone(f"mt{k}", (x, -2, -330 - rng.random() * 80), 70 + rng.random() * 40, 60 + rng.random() * 50,
                   hexc("#6F8A8F"), rot_y(rng.random()), n=7))
    return m


def rubble(n=420, seed=5, area=(-40, 40, -120, 10)):
    m = Model()
    rng = np.random.default_rng(seed)
    for k in range(n):
        x, z = rng.uniform(area[0], area[1]), rng.uniform(area[2], area[3])
        if abs(x) < 2.6 and rng.random() < 0.85:
            continue  # leave the old road mostly clear
        s = rng.uniform(0.25, 1.4)
        col = CHAR[int(rng.random() * len(CHAR))]
        R = rot_y(rng.uniform(0, TAU)) @ rot_x(rng.uniform(-0.6, 0.6))
        m.add(box(f"rb{k}", (x - s, 0, z - s * 0.4), (x + s, s * rng.uniform(0.15, 0.6), z + s * 0.4), col, R))
    for k in range(18):  # burnt poles and wall stumps
        x, z = rng.uniform(area[0], area[1]), rng.uniform(area[2], area[3])
        hgt = rng.uniform(2, 6)
        m.add(box(f"pole{k}", (x - 0.12, 0, z - 0.12), (x + 0.12, hgt, z + 0.12), hexc("#241E1B"),
                  rot_z(rng.uniform(-0.4, 0.4)) @ rot_x(rng.uniform(-0.3, 0.3)), pivot=(x, 0, z)))
    for k in range(8):  # concrete shells that stayed standing
        x = rng.choice([-1, 1]) * rng.uniform(12, 34)
        z = rng.uniform(-100, -20)
        hgt = rng.uniform(5, 11)
        m.add(box(f"shell{k}", (x - 4, 0, z - 3), (x + 4, hgt, z + 3), hexc("#8A8072") * rng.uniform(0.8, 1.0)))
        m.add(box(f"shw{k}", (x - 3, hgt * 0.35, z + 3), (x + 3, hgt * 0.8, z + 3.05), hexc("#211B18")))
    return m


CITY = None


def city_intact():
    m = Model()
    for i, z in enumerate(STREET_Z):
        for side in (-1, 1):
            m.add(house(i, side, z)[0])
    for k in range(9):  # utility poles
        z = 2 - 13 * k
        for side in (-1, 1):
            x = side * 4.0
            m.add(box(f"up{k}{side}", (x - 0.1, 0, z - 0.1), (x + 0.1, 7.5, z + 0.1), hexc("#4A3B2E")))
            m.add(box(f"ux{k}{side}", (x - 0.8, 6.9, z - 0.06), (x + 0.8, 7.05, z + 0.06), hexc("#4A3B2E")))
    m.add(dome_building(False))
    m.add(mountains())
    return m


STATIC = {}


def static(key, fn):
    if key not in STATIC:
        STATIC[key] = fn()
    return STATIC[key]


# ============================================================================ drawing
def sky(ctx, top, horizon, cam):
    fwd = cam.M[2].copy()
    fwd[1] = 0
    fwd /= np.linalg.norm(fwd) + 1e-9
    hy = cam.proj(cam.cam(cam.pos + fwd * 5000 + np.array([0, -cam.pos[1], 0])))[1]
    g = cairo.LinearGradient(0, min(hy - 1400, -10), 0, hy)
    g.add_color_stop_rgb(0, *top)
    g.add_color_stop_rgb(1, *horizon)
    ctx.set_source(g)
    ctx.paint()


def fogged(col, depth, fog):
    if fog is None:
        return col
    k = clamp((depth - fog[1]) / (fog[2] - fog[1])) * fog[3]
    return col * (1 - k) + fog[0] * k


def draw_polys(ctx, cam, light, polys, fog=None):
    for P, col in polys:
        C = clip_near(cam.cam(np.asarray(P, float)))
        if len(C) < 3:
            continue
        n = np.cross(P[1] - P[0], P[2] - P[0])
        n = n / (np.linalg.norm(n) + 1e-9)
        if n @ (cam.pos - P[0]) < 0:
            n = -n
        base.fill_poly(ctx, cam.proj(C), fogged(base.shade(col, n, light), C[:, 2].mean(), fog), seam=False)


def draw_model(ctx, cam, light, model, fog=None, dim=1.0):
    if not model.meshes:
        return
    V = np.vstack([m[0] for m in model.meshes])
    offs = np.cumsum([0] + [len(m[0]) for m in model.meshes])
    F = np.vstack([m[1] + o for m, o in zip(model.meshes, offs)])
    Cf = np.vstack([m[2] for m in model.meshes])
    C = cam.cam(V)
    S = cam.proj(C)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    N = np.cross(b - a, c - a)
    N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
    zc = C[F, 2]
    vis = (((cam.pos - a) * N).sum(1) > 0) & (zc.min(1) > base.NEAR)
    sx, sy = S[F, 0], S[F, 1]
    vis &= (sx.max(1) > -50) & (sx.min(1) < W + 50) & (sy.max(1) > -50) & (sy.min(1) < H + 50)
    depth = zc.mean(1)
    lam = np.clip(N @ light.dir, 0, None)
    K = (light.amb + light.dif * lam + 0.06 * N[:, 1])[:, None]
    cols = np.clip(Cf * K * light.tint * dim, 0, 1)
    if fog is not None:
        k = (np.clip((depth - fog[1]) / (fog[2] - fog[1]), 0, 1) * fog[3])[:, None]
        cols = cols * (1 - k) + np.asarray(fog[0])[None] * k
    idx = np.nonzero(vis)[0]
    for i in idx[np.argsort(-depth[idx])]:
        base.fill_poly(ctx, S[F[i]], cols[i])


def ground_polys(kind="street"):
    polys = [(np.array([(-600, 0, 60), (600, 0, 60), (600, 0, -700), (-600, 0, -700)], float),
              EARTH if kind == "street" else (hexc("#4E6B3E") if kind == "park" else hexc("#5A4A3C")))]
    if kind in ("street", "ruins"):
        road = ROAD if kind == "street" else hexc("#6E6458")
        polys.append((np.array([(-4.2, 0.01, 60), (4.2, 0.01, 60), (4.2, 0.01, -130), (-4.2, 0.01, -130)], float), road))
        for x in (-1.9, -0.9):
            polys.append((np.array([(x - 0.05, 0.02, 60), (x + 0.05, 0.02, 60), (x + 0.05, 0.02, -130),
                                    (x - 0.05, 0.02, -130)], float), TRACK))
    return polys


def wires(ctx, cam, alpha=0.8):
    for side in (-1, 1):
        pts = [np.array([side * 4.0 + dx, 7.0, 2 - 13 * k]) for k in range(9) for dx in (-0.6, 0.6)]
        for dx in (-0.6, 0.6):
            chain = [np.array([side * 4.0 + dx, 7.0, 2 - 13 * k]) for k in range(9)]
            for p0, p1 in zip(chain, chain[1:]):
                seg = [p0 + (p1 - p0) * u - np.array([0, 0.7 * math.sin(u * math.pi), 0]) for u in np.linspace(0, 1, 8)]
                C = cam.cam(np.array(seg))
                if (C[:, 2] < 0.3).any():
                    continue
                S = cam.proj(C)
                ctx.move_to(*S[0])
                for p in S[1:]:
                    ctx.line_to(*p)
        ctx.set_source_rgba(0.15, 0.13, 0.12, alpha)
        ctx.set_line_width(2)
        ctx.stroke()
        del pts


def project(cam, p):
    C = cam.cam(np.asarray(p, float))
    if C[2] < 0.2:
        return None, None
    return cam.proj(C), cam.focal / C[2]


def flames(ctx, cam, spots, t, k=1.0):
    ctx.save()
    for i, (p, size) in enumerate(spots):
        sp, sc = project(cam, p)
        if sp is None:
            continue
        s = size * sc * k
        if s < 2:
            continue
        flick = 1 + 0.22 * math.sin(t * 13 + i * 1.7) + 0.12 * math.sin(t * 29 + i)
        g = cairo.RadialGradient(sp[0], sp[1] - s * 0.4, 0, sp[0], sp[1] - s * 0.4, s * 2.2)
        g.add_color_stop_rgba(0, 1, 0.55, 0.15, 0.45)
        g.add_color_stop_rgba(1, 1, 0.4, 0.1, 0)
        ctx.set_operator(cairo.OPERATOR_ADD)
        ctx.set_source(g)
        ctx.arc(sp[0], sp[1] - s * 0.4, s * 2.2, 0, TAU)
        ctx.fill()
        ctx.set_operator(cairo.OPERATOR_OVER)
        for j, (col, sc2) in enumerate((((0.85, 0.2, 0.05), 1.0), ((1, 0.55, 0.1), 0.72), ((1, 0.88, 0.45), 0.42))):
            hh = s * 1.6 * flick * sc2
            ww = s * 0.55 * sc2
            sway = math.sin(t * 7 + i + j) * ww * 0.3
            ctx.move_to(sp[0] - ww, sp[1])
            ctx.curve_to(sp[0] - ww, sp[1] - hh * 0.5, sp[0] + sway, sp[1] - hh * 0.7, sp[0] + sway, sp[1] - hh)
            ctx.curve_to(sp[0] + sway, sp[1] - hh * 0.7, sp[0] + ww, sp[1] - hh * 0.5, sp[0] + ww, sp[1])
            ctx.close_path()
            ctx.set_source_rgba(*col, 0.92)
            ctx.fill()
    ctx.restore()


def smoke(ctx, cam, sources, t, col=(0.12, 0.1, 0.09), alpha=0.35):
    for i, (p, size) in enumerate(sources):
        for k in range(7):
            u = (t * 0.08 + k / 7 + rnd(i, 3) * 0.3) % 1.0
            q = np.asarray(p, float) + np.array([math.sin(i + u * 3) * 2 * u, u * size * 4, -u * size * 0.8])
            sp, sc = project(cam, q)
            if sp is None:
                continue
            r = size * sc * (0.6 + 1.6 * u)
            g = cairo.RadialGradient(sp[0], sp[1], 0, sp[0], sp[1], r)
            g.add_color_stop_rgba(0, *col, alpha * (1 - u) * 1.2)
            g.add_color_stop_rgba(1, *col, 0)
            ctx.set_source(g)
            ctx.arc(sp[0], sp[1], r, 0, TAU)
            ctx.fill()


def overlay(ctx, rgba):
    ctx.set_source_rgba(*rgba)
    ctx.paint()


def drift_particles(ctx, t, n, col, salt, size=(2, 6), speed=0.05, fall=False):
    for i in range(n):
        u = (t * speed * (0.6 + rnd(i, salt)) + rnd(i, salt + 1)) % 1.0
        x = rnd(i, salt + 2) * W + math.sin(t * 0.7 + i) * 30
        y = (u if fall else 1 - u) * H
        r = size[0] + (size[1] - size[0]) * rnd(i, salt + 3)
        ctx.arc(x, y, r, 0, TAU)
        ctx.set_source_rgba(*col, 0.5 * math.sin(u * math.pi))
        ctx.fill()


# ============================================================================ shots
def lerp(a, b, u):
    return np.asarray(a, float) + (np.asarray(b, float) - np.asarray(a, float)) * u


def pedestrians(t, n=14, seed=1, z0=-6, z1=-60, slow=1.0):
    out = []
    rng = np.random.default_rng(seed)
    for k in range(n):
        lane = rng.choice([-1, 1])
        x = lane * rng.uniform(2.4, 3.8)
        heading = 0 if rng.random() < 0.5 else math.pi
        speed = rng.uniform(1.0, 1.4) * slow
        z = rng.uniform(z1, z0) + (speed * t if heading == 0 else -speed * t)
        out.append(place(person(f"p{seed}{k}", walk=t * 6.5 * slow + k, hat=rng.random() < 0.3), (x, 0, z), heading))
    return out


def street_world(ctx, cam, t, light=DAY, extra=(), tram_z=None, damage=0.0):
    sky(ctx, *SKY_DAY, cam)
    fog = (SKY_DAY[1], 25, 260, 0.65)
    draw_polys(ctx, cam, light, ground_polys("street"), fog)
    world = Model()
    if damage <= 0:
        world.add(static("city", city_intact))
    else:
        world.add(static("mtn", mountains))
        world.add(static("dome", lambda: dome_building(False)))
        for i, z in enumerate(STREET_Z):
            for side in (-1, 1):
                h, (x0, zf) = house(i, side, z)
                d = clamp(damage * 1.6 - (z + 60) / -60 * 0.0 - rnd(i * 2 + side, 9) * 0.5)
                h.xform(rot_x(1.25 * d) @ rot_z(-side * 0.3 * d), t=(0, 0, 4 * d * d), pivot=(x0, 0, zf))
                world.add(h)
    if tram_z is not None:
        world.add(streetcar(tram_z))
    for e in extra:
        world.add(e)
    draw_model(ctx, cam, light, world, fog)
    if damage <= 0:
        wires(ctx, cam)


def shot_establish(ctx, t, d, gt):
    u = smooth(t / d)
    cam = Camera(lerp((-1.0, 10, 14), (-0.6, 9.2, 10), u), (3, 3, -60), 52)
    street_world(ctx, cam, t, extra=pedestrians(t, 18, 1), tram_z=-30 + 3 * t)


def shot_street_walk(ctx, t, d, gt):
    z = 6 - 1.2 * t
    bob = 0.03 * math.sin(t * 6.5 * 2)
    cam = Camera((1.6, 1.62 + bob, z), (1.2, 1.5, z - 20), 55)
    street_world(ctx, cam, t, extra=pedestrians(t, 16, 2, z0=z - 4, z1=z - 50), tram_z=z - 40 + 4 * t)


def shot_crowd(ctx, t, d, gt):
    cam = Camera((-3.9, 1.6, -6.0 - 0.3 * t), (3.5, 1.3, -14.5), 50)
    people = []
    rng = np.random.default_rng(9)
    for k in range(7):
        x = rng.uniform(0.0, 3.6)
        z = -19 + k * 1.1 + rng.uniform(-0.5, 0.5)
        dirn = 1 if k % 2 else -1
        people.append(place(person(f"c{k}", walk=t * 6.5 + k, hat=k % 3 == 0), (x + 0, 0, z + dirn * 1.2 * t),
                            0 if dirn > 0 else math.pi))
    street_world(ctx, cam, t, extra=people)


def shot_siren(ctx, t, d, gt):
    u = smooth(t / d)
    cam = Camera(lerp((0.6, 1.6, -3.5), (0.8, 1.7, -4.3), u), (4.0, 6.0, -15.0), 56)
    horn = box("horn_mount", (3.86, 6.1, -15.1), (4.14, 6.5, -14.9), hexc("#55514A"))
    horn.add(cone("horn", (3.8, 6.3, -15.0), 0.07, 0.55, hexc("#7A766C"), rot_z(1.75), n=8))
    horn.add(cone("horn2", (3.8, 6.3, -15.0), 0.3, 0.02, hexc("#7A766C"), rot_z(1.75) @ rot_x(0.0), n=8)
             .xform(np.eye(3), t=(-0.55, 0.05, 0)))
    street_world(ctx, cam, t, extra=[horn])


def plane(ctx, cam, t, gt):
    p = np.array([60 - 6 * t, 9000, -9000])
    sp, sc = project(cam, cam.pos + (p - cam.pos) / np.linalg.norm(p - cam.pos) * 400)
    if sp is None:
        return
    ctx.save()
    ctx.translate(*sp)
    ctx.set_source_rgba(0.25, 0.27, 0.3, 0.8)
    ctx.move_to(-9, 0)
    ctx.line_to(9, 0)
    ctx.move_to(0, -3)
    ctx.line_to(0, 4)
    ctx.set_line_width(2.2)
    ctx.stroke()
    g = cairo.LinearGradient(9, 0, 260, -40)
    g.add_color_stop_rgba(0, 1, 1, 1, 0.55)
    g.add_color_stop_rgba(1, 1, 1, 1, 0)
    ctx.set_source(g)
    ctx.move_to(9, -1)
    ctx.line_to(260, -42)
    ctx.set_line_width(3)
    ctx.stroke()
    ctx.restore()


def shot_sky(ctx, t, d, gt):
    u = smooth(t / d)
    cam = Camera((0.8, 1.6, -12), lerp((0.4, 30, -40), (0.3, 34, -38), u), 60)
    street_world(ctx, cam, t)
    plane(ctx, cam, t, gt)


def flash_amount(gt):
    f = TL["events"]["flash"]
    dt = gt - f
    if dt < 0:
        return 0.0
    if dt < 0.12:
        return dt / 0.12
    return max(0.0, math.exp(-(dt - 0.5) * 1.3)) if dt > 0.5 else 1.0


def shot_flash(ctx, t, d, gt):
    cam = Camera((1.6, 1.62, -1.0 - 0.4 * t), (1.2, 1.6, -21), 55)
    street_world(ctx, cam, t, extra=pedestrians(t * 0.3 + 2, 16, 2, z0=-5, z1=-50))
    a = flash_amount(gt)
    g = cairo.RadialGradient(W * 0.55, H * 0.3, 0, W * 0.55, H * 0.3, H)
    g.add_color_stop_rgba(0, 1, 1, 0.97, min(1, a * 1.1))
    g.add_color_stop_rgba(1, 1, 0.97, 0.9, a * 0.92)
    ctx.set_source(g)
    ctx.paint()


def shot_blast(ctx, t, d, gt):
    shake = max(0, 1 - t / 2.5)
    j = np.array([math.sin(t * 61), math.sin(t * 47 + 1), 0]) * 0.12 * shake
    cam = Camera(np.array((1.6, 1.62, -1.6)) + j, np.array((1.2, 1.7, -21)) + j * 3, 55)
    damage = smooth(t / 1.6)
    street_world(ctx, cam, t, light=Sun(tint=(1, 0.9, 0.78)), damage=damage)
    for i in range(70):  # debris thrown toward you
        u = (t * 0.9 + rnd(i, 21)) % 1.0
        if t < 0.2:
            break
        p = np.array([rnd(i, 22) * 16 - 8, 0.5 + rnd(i, 23) * 6 + u * 2, -40 + u * 42])
        sp, sc = project(cam, p)
        if sp is None:
            continue
        s = (0.15 + rnd(i, 24) * 0.4) * sc
        ctx.save()
        ctx.translate(*sp)
        ctx.rotate(t * 5 + i)
        ctx.rectangle(-s, -s * 0.5, 2 * s, s)
        ctx.set_source_rgba(0.25, 0.2, 0.16, 0.9)
        ctx.fill()
        ctx.restore()
    dust = smooth((t - 0.3) / 2.2)  # the dust wall rolling in
    for i in range(26):
        x = rnd(i, 30) * W
        y = H * (0.25 + 0.55 * rnd(i, 31))
        r = (220 + 400 * rnd(i, 32)) * (0.4 + dust)
        g = cairo.RadialGradient(x, y, 0, x, y, r)
        g.add_color_stop_rgba(0, 0.42, 0.33, 0.24, 0.55 * dust)
        g.add_color_stop_rgba(1, 0.42, 0.33, 0.24, 0)
        ctx.set_source(g)
        ctx.arc(x, y, r, 0, TAU)
        ctx.fill()
    overlay(ctx, (1, 0.97, 0.9, max(0.0, 0.6 - t * 0.6)))


def shot_dust(ctx, t, d, gt):
    overlay(ctx, (0.17, 0.12, 0.09, 1))
    g = cairo.RadialGradient(W * 0.5, H * 0.38, 0, W * 0.5, H * 0.38, H * 0.7)
    g.add_color_stop_rgba(0, 0.45, 0.32, 0.2, 0.75 * (0.7 + 0.3 * math.sin(t * 0.8)))
    g.add_color_stop_rgba(1, 0.1, 0.07, 0.05, 0)
    ctx.set_source(g)
    ctx.paint()
    cam = Camera((0, 1.5, 6 - 0.3 * t), (0, 1.3, -10), 50)
    figs = Model()
    figs.add(place(person("dust1", bow=0.35, shirt=hexc("#5A4A3C"), pants=hexc("#3C3129")), (-0.4, 0, -2.0), math.pi))
    figs.add(place(person("dust2", bow=0.5, shirt=hexc("#4A3D33"), pants=hexc("#30281F"), scale=0.95), (1.2, 0, -6), 2.6))
    draw_model(ctx, cam, Sun((0, 0.3, 1), (0.6, 0.45, 0.35), 0.35, 0.25), figs, fog=(hexc("#3A2A1E"), 3, 12, 0.85))
    drift_particles(ctx, t, 90, (0.6, 0.5, 0.4), 40, size=(2, 7), speed=0.03, fall=True)


RUIN_FIRES = [((x, 0.4, z), s) for x, z, s in ((-9, -30, 1.4), (7, -22, 1.1), (-15, -55, 2.2), (12, -48, 1.8),
                                               (-4, -75, 2.5), (20, -80, 2.8), (-25, -36, 1.6), (4, -12, 0.9))]


def ruins_world(ctx, cam, t, light=ASH, sky_cols=SKY_ASH, fires=True, fog_k=0.75):
    sky(ctx, *sky_cols, cam)
    fog = (sky_cols[1] * 0.8, 15, 160, fog_k)
    draw_polys(ctx, cam, light, ground_polys("ruins"), fog)
    world = Model()
    world.add(static("rubble", rubble))
    world.add(static("ruin_dome", lambda: dome_building(True)))
    world.add(static("mtn", mountains))
    draw_model(ctx, cam, light, world, fog)
    smoke(ctx, cam, [(p, s * 1.6) for p, s in RUIN_FIRES] + [((-60, 0, -200), 12), ((50, 0, -170), 10)], t)
    if fires:
        flames(ctx, cam, RUIN_FIRES, t)


def shot_ruins(ctx, t, d, gt):
    u = smooth(t / d)
    cam = Camera(lerp((-2, 3.0, 8), (-2, 6.5, 6), u), lerp((6, 2, -60), (8, 3, -70), u), 55)
    ruins_world(ctx, cam, t)
    overlay(ctx, (0.25, 0.17, 0.1, max(0, 0.8 - t * 0.7)))  # the dust thinning


def shot_fires(ctx, t, d, gt):
    cam = Camera((-6, 1.4, -18 - 0.3 * t), (-10, 1.2, -32), 50)
    ruins_world(ctx, cam, t)


RIVER_X = -30


def river_world(ctx, cam, t):
    sky(ctx, *SKY_ASH, cam)
    fog = (SKY_ASH[1] * 0.8, 15, 140, 0.75)
    polys = ground_polys("ruins")
    polys.append((np.array([(-120, 0.02, -20), (120, 0.02, -20), (120, 0.02, -48), (-120, 0.02, -48)], float),
                  hexc("#3C4650")))
    draw_polys(ctx, cam, ASH, polys, fog)
    world = Model()
    world.add(box("bridge", (-5, 1.2, -50), (5, 1.6, -18), hexc("#5E5650")))
    world.add(box("bridge_t", (-30, 1.2, -36), (5, 1.6, -32), hexc("#5E5650")))
    for k in range(4):
        world.add(box(f"pier{k}", (-1.5, 0, -46 + k * 8), (1.5, 1.2, -45 + k * 8), hexc("#4E4842")))
    rng = np.random.default_rng(12)
    for k in range(11):
        x = rng.uniform(-6, 6)
        z = rng.uniform(-14, 2) - 0.45 * t
        world.add(place(person(f"rv{k}", walk=t * 3.5 + k, bow=0.3, shirt=CLOTHES[k % 6] * 0.6, pants=hexc("#3A3029")),
                        (x, 0, z), math.pi))
    world.add(static("rubble_r", lambda: rubble(160, 8, (-40, 40, -18, 10))))
    draw_model(ctx, cam, ASH, world, fog)
    smoke(ctx, cam, [((-40, 0, -120), 14), ((35, 0, -100), 10)], t)


def shot_river_walk(ctx, t, d, gt):
    cam = Camera((0.5, 2.2, 6.5 - 0.35 * t), (0, 0.8, -30), 52)
    river_world(ctx, cam, t)


def shot_black_rain(ctx, t, d, gt):
    u = smooth(t / d)
    cam = Camera(lerp((3, 2.0, -6), (3, 2.2, -9), u), (8, 3, -60), 55)
    ruins_world(ctx, cam, t, light=Sun((0.3, 0.5, 0.6), (0.72, 0.72, 0.76), 0.5, 0.3),
                sky_cols=(hexc("#25252A"), hexc("#6A6460")), fires=False, fog_k=0.8)
    overlay(ctx, (0.08, 0.08, 0.1, 0.12))
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    for i in range(260):  # rain streaks
        u2 = (t * (1.6 + rnd(i, 50)) + rnd(i, 51)) % 1.0
        x = rnd(i, 52) * (W + 200) - 100 - u2 * 120
        y = u2 * (H + 300) - 150
        ln = 60 + 70 * rnd(i, 53)
        ctx.move_to(x, y)
        ctx.line_to(x - ln * 0.18, y + ln)
        ctx.set_source_rgba(0.06, 0.06, 0.07, 0.55)
        ctx.set_line_width(2.5 + 2 * rnd(i, 54))
        ctx.stroke()


def shot_shadow(ctx, t, d, gt):
    """The bank steps: where someone sat, the stone around them was bleached by the heat; under them it stayed dark.

    Drawn as explicit polygons in back-to-front order (the steps are too regular for the painter's sort)."""
    u = smooth(t / d)
    cam = Camera(lerp((1.7, 2.2, 3.2), (1.25, 1.85, 2.4), u), (0.0, 0.7, -1.6), 50)
    g = hexc("#C8BFAF")

    def poly(pts, col, alpha=1.0):
        C = clip_near(cam.cam(np.array(pts, float)))
        if len(C) >= 3:
            base.fill_poly(ctx, cam.proj(C), col, alpha, seam=alpha >= 1)

    overlay(ctx, (0.3, 0.28, 0.26, 1))
    poly([(-30, 0, 15), (30, 0, 15), (30, 0, -3.2), (-30, 0, -3.2)], g * 0.62)  # pavement
    poly([(-8, 0, -3.2), (8, 0, -3.2), (8, 9, -3.2), (-8, 9, -3.2)], g * 0.78)  # bank front
    poly([(-1.4, 0.9, -3.19), (1.4, 0.9, -3.19), (1.4, 4.4, -3.19), (-1.4, 4.4, -3.19)], hexc("#2C2724"))  # doorway
    n, rise, run = 5, 0.18, 0.42
    for k in reversed(range(n)):  # far, high steps first
        y = rise * (k + 1)
        zf, zb = -run * k, (-3.2 if k == n - 1 else -run * (k + 1))
        poly([(-4, y, zb), (4, y, zb), (4, y, zf), (-4, y, zf)], g * 0.92)  # tread, lit from above
        poly([(-4, y - rise, zf), (4, y - rise, zf), (4, y, zf), (-4, y, zf)], g * 0.66)  # riser, in shade
        if k == n - 1:
            for x in (-2.6, 2.6):  # columns standing on the top step
                poly([(x + 0.4, y, -2.5), (x + 0.4, y, -3.2), (x + 0.4, 7, -3.2), (x + 0.4, 7, -2.5)], g * 0.62)
                poly([(x - 0.4, y, -2.5), (x + 0.4, y, -2.5), (x + 0.4, 7, -2.5), (x - 0.4, 7, -2.5)], g * 0.86)
        if k == 2:  # the shadow, on this step's tread and down its riser
            for grow, alpha in ((1.22, 0.16), (1.1, 0.24), (1.0, 0.5)):
                top = []
                for a in np.linspace(0, TAU, 48, endpoint=False):
                    r = (0.36 + 0.05 * math.sin(a * 3 + 1) + 0.03 * math.sin(a * 7)) * grow
                    top.append((0.1 + math.cos(a) * r, y + 0.003, zf - 0.24 + math.sin(a) * min(r * 0.7, 0.22 * grow)))
                poly(top, (0.2, 0.17, 0.15), alpha)
                legs = [(0.1 + math.cos(a) * 0.3 * grow, y - 0.004 - math.sin(a) * 0.14 * grow, zf + 0.003)
                        for a in np.linspace(math.pi, 0, 30)]
                legs = [(0.1 - 0.3 * grow, y - 0.004, zf + 0.003)] + legs
                poly(legs, (0.2, 0.17, 0.15), alpha)


def lanterns(ctx, cam, t, n=34):
    glow = []
    m = Model()
    rng = np.random.default_rng(77)
    for k in range(n):
        x = rng.uniform(-9, 14) + 0.25 * t
        z = rng.uniform(-44, -22)
        y = 0.08 + 0.03 * math.sin(t * 1.5 + k)
        m.add(box(f"ln{k}", (x - 0.22, y, z - 0.22), (x + 0.22, y + 0.42, z + 0.22), hexc("#F6E8C8")))
        glow.append(np.array([x, y + 0.25, z]))
    draw_model(ctx, cam, Sun((0.3, 0.6, 0.6), (1.0, 0.85, 0.65), 0.95, 0.2), m)
    ctx.save()
    ctx.set_operator(cairo.OPERATOR_ADD)
    for k, p in enumerate(glow):
        sp, sc = project(cam, p)
        if sp is None:
            continue
        r = 0.9 * sc * (1 + 0.08 * math.sin(t * 5 + k))
        g = cairo.RadialGradient(sp[0], sp[1], 0, sp[0], sp[1], r)
        g.add_color_stop_rgba(0, 1, 0.75, 0.4, 0.6)
        g.add_color_stop_rgba(1, 1, 0.5, 0.2, 0)
        ctx.set_source(g)
        ctx.arc(sp[0], sp[1], r, 0, TAU)
        ctx.fill()
        rp, _ = project(cam, p - np.array([0, 0.5, 0]))  # reflection on the water
        if rp is not None:
            g = cairo.LinearGradient(0, rp[1] - r * 0.3, 0, rp[1] + r * 1.4)
            g.add_color_stop_rgba(0, 1, 0.7, 0.35, 0.35)
            g.add_color_stop_rgba(1, 1, 0.6, 0.3, 0)
            ctx.set_source(g)
            ctx.rectangle(rp[0] - r * 0.12, rp[1] - r * 0.3, r * 0.24, r * 1.7)
            ctx.fill()
    ctx.restore()


def peace_world(ctx, cam, t, with_lanterns):
    sky(ctx, *SKY_DUSK, cam)
    fog = (SKY_DUSK[1] * 0.9, 30, 220, 0.55)
    polys = ground_polys("park")
    polys.append((np.array([(-200, 0.02, -20), (200, 0.02, -20), (200, 0.02, -46), (-200, 0.02, -46)], float),
                  hexc("#3B4B66")))
    draw_polys(ctx, cam, DUSK, polys, fog)
    world = Model()
    world.add(static("peace_dome", lambda: dome_building(True, at=(4, 0, -62))))
    world.add(static("mtn", mountains))
    rng = np.random.default_rng(31)
    for k in range(16):
        x = rng.uniform(-60, 60)
        z = rng.uniform(-90, -50)
        if abs(x - 4) < 16:
            continue
        world.add(box(f"trk{k}", (x - 0.25, 0, z - 0.25), (x + 0.25, 3, z + 0.25), hexc("#4A3A2C")))
        world.add(ell(f"tre{k}", (x, 5, z), (3, 3.2, 3), hexc("#3E6B45")))
    draw_model(ctx, cam, DUSK, world, fog)
    if with_lanterns:
        lanterns(ctx, cam, t)


def shot_dome_dusk(ctx, t, d, gt):
    u = smooth(t / d)
    cam = Camera(lerp((-6, 2.0, 8), (-4, 2.3, 4), u), (4, 9, -62), 52)
    peace_world(ctx, cam, t, False)


def shot_lanterns(ctx, t, d, gt):
    u = smooth(t / d)
    cam = Camera(lerp((-2, 1.3, -10), (-1, 1.5, -13), u), (3, 4, -62), 52)
    peace_world(ctx, cam, t, True)


SHOTS = {k[5:]: v for k, v in globals().items() if k.startswith("shot_")}
GRADE = {"dust": "warm", "ruins": "warm", "fires": "warm", "river_walk": "warm", "black_rain": "cold", "shadow": "muted"}


# ============================================================================ timeline
def build_timeline():
    """Narrate and time the script, cached in out/ so re-renders don't re-synthesise the voice."""
    import hashlib
    import pickle
    key = hashlib.sha1(repr((SEGMENTS, UTTERANCES, SAY, SPEED, base.VOICE_NAME)).encode()).hexdigest()[:12]
    cache = os.path.join(OUT, f"timeline-{key}.pkl")
    if os.path.exists(cache):
        with open(cache, "rb") as fh:
            return pickle.load(fh)
    tl = _build_timeline()
    with open(cache, "wb") as fh:
        pickle.dump(tl, fh)
    return tl


def _build_timeline():
    from faster_whisper import WhisperModel
    from kokoro_onnx import Kokoro
    model, packed = base.ensure_kokoro()
    tts = Kokoro(model, packed)
    asr = WhisperModel("base.en", device="cpu", compute_type="int8",
                       download_root=os.path.join(base.VOICE_DIR, "whisper"))
    t, clips, words, shots, sr = 0.9, [], [], [], 24000
    for seg_ids, pause in UTTERANCES:
        text = " ".join(SEGMENTS[i][0] for i in seg_ids)
        spoken = " ".join(SAY.get(w, w) for w in text.split())
        a, sr = tts.create(spoken, voice=base.VOICE_NAME, speed=SPEED, lang="en-us")
        loud = np.nonzero(np.abs(a) > 0.01)[0]
        a = a[max(0, loud[0] - int(0.04 * sr)): loud[-1] + int(0.15 * sr)]
        a16 = np.interp(np.arange(0, len(a), sr / 16000), np.arange(len(a)), a).astype(np.float32)
        segs, _ = asr.transcribe(a16, word_timestamps=True, language="en", initial_prompt=spoken)
        heard = [w for s in segs for w in s.words]
        sw = text.split()
        times = base.align_words(spoken.split(), heard)
        k = 0
        for i in seg_ids:
            seg_text, shot_list = SEGMENTS[i]
            n = len(seg_text.split())
            seg_words = [dict(text=re.sub(r"[^A-Za-z0-9'’\-]", "", w).upper().strip("-"), raw=w, t0=t + s, t1=t + e, seg=i)
                         for w, (s, e) in zip(sw[k:k + n], times[k:k + n])]
            kk = 0
            for name, nw in shot_list:
                shots.append(dict(name=name, t0=max(0.0, seg_words[kk]["t0"] - 0.1) if shots else 0.0))
                kk += nw
            assert kk == n, f"shot word counts don't add up for: {seg_text}"
            words += seg_words
            k += n
        clips.append((t, a))
        t += len(a) / sr + pause
    total = t + 3.2
    for i, s in enumerate(shots):
        s["t1"] = shots[i + 1]["t0"] if i + 1 < len(shots) else total
    flash = next(w["t0"] for w in words if w["text"] == "FLASH")
    blast = next(s["t0"] for s in shots if s["name"] == "blast")
    end_voice = words[-1]["t1"]
    return dict(words=words, chunks=base.caption_chunks(words), shots=shots, total=total, clips=clips, sr=sr,
                events=dict(flash=flash, blast=blast, end=end_voice))


# ============================================================================ frames
TL = None


def credits(ctx, t):
    a = clamp((t - TL["events"]["end"] - 0.6) / 0.8)
    if a <= 0:
        return
    ctx.select_font_face("Montserrat Black")
    ctx.set_font_size(46)
    for k, line in enumerate(("Hiroshima, 6 August 1945", SOURCES.split("  ·  ")[0], SOURCES.split("  ·  ")[1])):
        if k == 1:
            ctx.select_font_face("DejaVu Sans")
            ctx.set_font_size(33)
        ext = ctx.text_extents(line)
        if ext.x_advance > W - 80:
            ctx.set_font_size(33 * (W - 80) / ext.x_advance)
            ext = ctx.text_extents(line)
        ctx.move_to(W / 2 - ext.x_advance / 2, H * 0.80 + k * 62)
        ctx.set_source_rgba(1, 0.96, 0.9, 0.9 * a)
        ctx.show_text(line)


def render_frame(i):
    t = i / FPS
    shot = next(s for s in TL["shots"] if s["t0"] <= t < s["t1"] or s is TL["shots"][-1])
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    ctx = cairo.Context(surf)
    ctx.set_source_rgb(0, 0, 0)
    ctx.paint()
    SHOTS[shot["name"]](ctx, t - shot["t0"], shot["t1"] - shot["t0"], t)
    surf.flush()
    a = base.surf_array(surf)
    rgb = a[..., :3].astype(np.float32)
    grade = GRADE.get(shot["name"])
    if grade in ("muted", "cold"):
        g = rgb @ np.array([0.114, 0.587, 0.299], np.float32)
        mix = 0.5 if grade == "muted" else 0.6
        rgb = rgb * (1 - mix) + g[..., None] * mix
    if grade:
        rng = np.random.default_rng(i)
        rgb += rng.normal(0, 4, rgb.shape[:2])[..., None]
    rgb *= base.vignette() ** (1.4 if grade else 1.0)
    a[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    surf.mark_dirty()
    chunk = next((c for c in TL["chunks"] if c["t0"] <= t < c["t1"]), None)
    if chunk:
        base.caption(ctx, chunk, t)
    credits(ctx, t)
    fade = clamp(t / 0.8) * clamp((TL["total"] - t) / 0.9)
    if fade < 1:
        overlay(ctx, (0, 0, 0, 1 - fade))
    surf.flush()
    return bytes(surf.get_data())


# ============================================================================ audio
def band_noise(n, lo, hi, sr, seed):
    rng = np.random.default_rng(seed)
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / sr)
    spec[(f < lo) | (f > hi)] = 0
    x = np.fft.irfft(spec, n)
    return x / (np.abs(x).max() + 1e-9)


def synth_audio(tl, path):
    sr = 44100
    n = int(tl["total"] * sr)
    tt = np.arange(n) / sr
    ev = tl["events"]
    voice = np.zeros(n)
    for t0, a in tl["clips"]:
        up = np.interp(np.arange(int(len(a) * sr / tl["sr"])) / sr, np.arange(len(a)) / tl["sr"], a)
        i = int(t0 * sr)
        voice[i:i + len(up)] += up[: n - i]
    voice /= np.max(np.abs(voice)) + 1e-9
    sfx = np.zeros(n)
    music = np.zeros(n)

    def env(t0, t1, fade=0.4):
        return np.clip((tt - t0) / fade, 0, 1) * np.clip((t1 - tt) / fade, 0, 1)

    pre = env(0, ev["flash"], 0.05)
    # morning: cicadas, a few birds, a streetcar bell
    cic = band_noise(n, 3800, 6500, sr, 1) * (0.55 + 0.45 * np.sin(TAU * 31 * tt) ** 2) * (0.7 + 0.3 * np.sin(TAU * 0.13 * tt))
    sfx += 0.05 * cic * pre
    rng = np.random.default_rng(4)
    for k in range(9):
        t0 = rng.uniform(0.5, ev["flash"] - 0.5)
        x = np.arange(int(0.12 * sr)) / sr
        chirp = np.sin(TAU * np.cumsum(2600 + 1800 * x / 0.12) / sr) * np.sin(math.pi * x / 0.12)
        i = int(t0 * sr)
        sfx[i:i + len(x)] += 0.05 * chirp[: n - i]
    for k, t0 in enumerate((2.2, 2.45)):
        x = np.arange(int(1.2 * sr)) / sr
        bell = (np.sin(TAU * 1250 * x) + 0.5 * np.sin(TAU * 3100 * x)) * np.exp(-x * 4)
        i = int(t0 * sr)
        sfx[i:i + len(x)] += 0.06 * bell
    # the flash: everything drops away to a ringing tone
    f = ev["flash"]
    x = tt - f
    ring = np.where(x > 0, np.sin(TAU * 3700 * tt) * np.exp(-np.clip(x, 0, None) * 0.55), 0)
    sfx += 0.05 * ring * (x < 7)
    # the boom
    b = ev["blast"]
    x = np.clip(tt - b, 0, None)
    rumble = band_noise(n, 20, 260, sr, 7)
    boom = (np.sin(TAU * np.cumsum(55 - 25 * np.clip(x / 2, 0, 1)) / sr) * 0.8 + rumble) * np.exp(-x * 0.9)
    sfx += 0.9 * boom * (tt >= b) * np.clip(x / 0.03, 0, 1)
    sfx += 0.15 * band_noise(n, 800, 5000, sr, 8) * np.exp(-x * 3) * (tt >= b)
    # afterwards: wind and fire
    after = env(b + 1.5, tl["shots"][[s["name"] for s in tl["shots"]].index("shadow")]["t1"], 1.5)
    wind = band_noise(n, 60, 500, sr, 9) * (0.6 + 0.4 * np.sin(TAU * 0.11 * tt))
    sfx += 0.12 * wind * after
    crackle = np.zeros(n)
    for k in range(int(tl["total"] * 25)):
        i = int(rng.uniform(0, n - 200))
        crackle[i:i + 120] += rng.uniform(-1, 1) * np.exp(-np.arange(120) / 18)
    fires = [s for s in tl["shots"] if s["name"] in ("ruins", "fires", "river_walk")]
    sfx += 0.08 * crackle * env(fires[0]["t0"], fires[-1]["t1"], 0.8)
    br = next(s for s in tl["shots"] if s["name"] == "black_rain")
    sfx += 0.07 * band_noise(n, 1500, 9000, sr, 10) * env(br["t0"], br["t1"], 0.4)
    peace = next(s for s in tl["shots"] if s["name"] == "dome_dusk")["t0"]
    water = band_noise(n, 150, 900, sr, 11) * (0.5 + 0.5 * np.sin(TAU * 0.4 * tt) ** 2)
    sfx += 0.05 * water * env(peace, tl["total"], 1.0)

    def note(t0, m, dur, amp):
        fr = 440 * 2 ** ((m - 69) / 12)
        x = np.arange(int(dur * sr)) / sr
        sig = (np.sin(TAU * fr * x) + 0.4 * np.sin(TAU * 2 * fr * x) * np.exp(-x * 3)
               + 0.15 * np.sin(TAU * 3 * fr * x) * np.exp(-x * 5)) * np.exp(-x * 1.1) * np.minimum(1, x / 0.008)
        i = int(t0 * sr)
        if i < n:
            music[i:i + len(sig)] += amp * sig[: n - i]

    melody = [62, 65, 67, 69, 72, 69, 67, 65]  # D minor pentatonic, before the flash
    tq = 1.0
    k = 0
    while tq < f - 0.3:
        note(tq, melody[k % len(melody)], 3.0, 0.22)
        if k % 4 == 0:
            note(tq, 50, 4.0, 0.25)
        tq += 1.25
        k += 1
    drone_on = env(next(s["t0"] for s in tl["shots"] if s["name"] == "ruins"), peace + 0.5, 2.0)
    music += 0.18 * (np.sin(TAU * 73.4 * tt) + 0.6 * np.sin(TAU * 110 * tt + 0.3 * np.sin(TAU * 0.2 * tt))) * drone_on
    chords = [(50, [62, 65, 69]), (46, [62, 65, 70]), (53, [60, 65, 69]), (48, [60, 64, 67])]  # Dm Bb F C
    tq, k = peace + 0.2, 0
    while tq < tl["total"] - 1:
        root, ch = chords[(k // 3) % 4]
        if k % 3 == 0:
            note(tq, root, 4.5, 0.3)
        note(tq, ch[k % 3] + 12, 3.0, 0.2)
        tq += 0.75
        k += 1
    d = int(0.45 * sr)
    music[d:] += music[:-d] * 0.3
    music /= np.max(np.abs(music)) + 1e-9
    mix = 0.85 * voice + 0.14 * music * (1 - 0.95 * ((tt >= f) & (tt < peace))) + 0.14 * music * drone_on * 0 + sfx
    mix *= np.clip(tt / 0.8, 0, 1) * np.clip((tl["total"] - tt) / 1.2, 0, 1)
    mix /= max(1.0, np.max(np.abs(mix)) / 0.95)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((mix * 32767).astype("<i2").tobytes())


def write_srt(tl, path):
    def ts(s):
        ms = int(round(s * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    with open(path, "w") as f:
        k = 0
        for j, (text, _) in enumerate(SEGMENTS):
            n = len(text.split())
            ws = tl["words"][k:k + n]
            f.write(f"{j + 1}\n{ts(ws[0]['t0'])} --> {ts(ws[-1]['t1'])}\n{text}\n\n")
            k += n


# ============================================================================ main
def main():
    global TL
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sheet", action="store_true")
    ap.add_argument("--still", type=float)
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    base.ensure_fonts()
    base.CAP_ACTIVE = (1.0, 0.78, 0.48)  # a softer amber highlight for a sombre piece
    TL = build_timeline()
    nframes = int(round(TL["total"] * FPS))
    print(f"{TL['total']:.1f} s, {len(TL['shots'])} shots, {len(TL['words'])} words", file=sys.stderr)
    if args.still is not None:
        data = render_frame(int(args.still * FPS))
        cairo.ImageSurface.create_for_data(bytearray(data), cairo.FORMAT_ARGB32, W, H).write_to_png(
            os.path.join(OUT, "still.png"))
        return
    if args.sheet:
        tw, th, cols = W // 4, H // 4, 8
        rows = math.ceil(len(TL["shots"]) / cols)
        img = cairo.ImageSurface(cairo.FORMAT_ARGB32, tw * cols, th * rows)
        c = cairo.Context(img)
        for k, s in enumerate(TL["shots"]):
            mid = s["t0"] + (s["t1"] - s["t0"]) * 0.6
            fr = cairo.ImageSurface.create_for_data(bytearray(render_frame(int(mid * FPS))), cairo.FORMAT_ARGB32, W, H)
            c.save()
            c.translate((k % cols) * tw, (k // cols) * th)
            c.scale(0.25, 0.25)
            c.set_source_surface(fr)
            c.paint()
            c.restore()
        img.write_to_png(os.path.join(OUT, "sheet.png"))
        return
    audio = os.path.join(OUT, "audio.wav")
    synth_audio(TL, audio)
    write_srt(TL, os.path.join(OUT, "hiroshima-1945.srt"))
    video = os.path.join(OUT, "hiroshima-1945.mp4")
    enc = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                            "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-i", audio, "-c:v", "libx264", "-preset", "medium", "-crf", "19",
                            "-pix_fmt", "yuv420p", "-profile:v", "high",
                            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
                            "-shortest", "-movflags", "+faststart", video], stdin=subprocess.PIPE)
    with Pool(args.workers) as pool:
        for i, data in enumerate(pool.imap(render_frame, range(nframes), chunksize=3)):
            enc.stdin.write(data)
            if i % 150 == 0:
                print(f"frame {i}/{nframes}", file=sys.stderr)
    enc.stdin.close()
    if enc.wait():
        sys.exit("ffmpeg failed")
    print("wrote", video)


if __name__ == "__main__":
    main()
