#!/usr/bin/env python3
"""While You're at Work -- a low-poly 3D pet story short.

A tiny software 3D renderer (numpy + cairo) draws faceted, flat-shaded low-poly
scenes; the open Kokoro TTS model narrates, Whisper times every word, and the
captions show short phrases with the spoken word highlighted. Every model,
sound and note of music is generated here.

    pip install pycairo numpy kokoro-onnx faster-whisper   # plus FFmpeg
    python3 make_short.py                     # -> out/while-youre-at-work.mp4
    python3 make_short.py --sheet             # -> out/sheet.png (one frame per shot)
    python3 make_short.py --still 4.2         # -> out/still.png

The first run downloads the Kokoro voice model (about 330 MB) and the Whisper
base.en model (about 150 MB) into ./voices.
"""
import argparse
import math
import os
import re
import subprocess
import sys
import urllib.request
import wave
from multiprocessing import Pool

import cairo
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
VOICE_DIR = os.path.join(HERE, "voices")
W, H, FPS = 1080, 1920, 30
TAU = math.tau


def hexc(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def smooth(x):
    x = clamp(x)
    return x * x * (3 - 2 * x)


# ============================================================================ script
# (narration, [(shot, number of words the shot covers), ...])  -- cuts land on words
SEGMENTS = [
    ("Every morning, you grab your keys and leave for work.", [("cat_hello", 2), ("leave", 8)]),
    ("You probably think your cat doesn't even notice.", [("owner_face", 8)]),
    ("But the second that door closes,", [("door_close", 6)]),
    ("she's on the windowsill, watching the street.", [("sill_back", 4), ("sill_side", 3)]),
    ("Hours go by.", [("timelapse", 3)]),
    ("She curls up on your hoodie,", [("curl", 6)]),
    ("because it still smells like you.", [("memory", 6)]),
    ("Then she hears your keys...", [("perk", 5)]),
    ("and runs to the door.", [("run", 5)]),
    ("But when you walk in,", [("enter", 5)]),
    ("she acts like she wasn't waiting at all.", [("unbothered", 8)]),
]


# ============================================================================ math / meshes
def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def _icosphere(sub):
    t = (1 + 5 ** 0.5) / 2
    v = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
         (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    f = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2),
         (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11),
         (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    v = [np.array(p, float) / np.linalg.norm(p) for p in v]
    for _ in range(sub):
        cache, nf = {}, []

        def mid(a, b):
            key = (min(a, b), max(a, b))
            if key not in cache:
                m = v[a] + v[b]
                v.append(m / np.linalg.norm(m))
                cache[key] = len(v) - 1
            return cache[key]
        for a, b, c in f:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        f = nf
    return np.array(v), np.array(f)


ICO = {s: _icosphere(s) for s in (1, 2)}


def _seed(name):
    return sum(ord(ch) * (i + 1) for i, ch in enumerate(name)) % 100000


class Model:
    """A bag of triangle meshes (V, F, colour per face) plus 2D 'sprites' (eyes, mouths)."""

    def __init__(self):
        self.meshes, self.sprites = [], []

    def add(self, other):
        self.meshes += other.meshes
        self.sprites += [dict(s) for s in other.sprites]
        return self

    def xform(self, R=np.eye(3), t=(0, 0, 0), pivot=(0, 0, 0)):
        R, t, p = np.asarray(R), np.asarray(t, float), np.asarray(pivot, float)
        self.meshes = [((V - p) @ R.T + p + t, F, C) for V, F, C in self.meshes]
        for s in self.sprites:
            s["pos"] = (s["pos"] - p) @ R.T + p + t
            for k in ("normal", "up", "right"):
                s[k] = s[k] @ R.T
        return self


def _orient(V, F):
    """Make every face wind outward from the mesh centre (all primitives here are convex)."""
    c = V.mean(0)
    a, b, d = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    n = np.cross(b - a, d - a)
    flip = ((a + b + d) / 3 - c) @ np.eye(3) * n
    flip = flip.sum(1) < 0
    F = F.copy()
    F[flip] = F[flip][:, ::-1]
    return F


def _colors(n, col, name):
    rng = np.random.default_rng(_seed(name) + 7)
    return np.clip(np.asarray(col)[None] * (1 + 0.05 * (rng.random((n, 1)) - 0.5)), 0, 1)


def ell(name, c, r, col, R=np.eye(3), sub=1, jitter=0.06):
    v, f = ICO[sub]
    rng = np.random.default_rng(_seed(name))
    V = v * (1 + jitter * (rng.random((len(v), 1)) - 0.5) * 2)
    V = (V * np.asarray(r, float)) @ np.asarray(R).T + np.asarray(c, float)
    m = Model()
    m.meshes.append((V, f, _colors(len(f), col, name)))
    return m


def cone(name, base, radius, height, col, R=np.eye(3), n=6):
    ang = np.arange(n) * TAU / n
    ring = np.stack([np.cos(ang) * radius, np.zeros(n), np.sin(ang) * radius], 1)
    V = np.vstack([ring, [[0, height, 0]], [[0, 0, 0]]]) @ np.asarray(R).T + np.asarray(base, float)
    F = [(i, (i + 1) % n, n) for i in range(n)] + [((i + 1) % n, i, n + 1) for i in range(n)]
    F = _orient(V, np.array(F))
    m = Model()
    m.meshes.append((V, F, _colors(len(F), col, name)))
    return m


def box(name, lo, hi, col, R=np.eye(3), pivot=None):
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    V = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    F = np.array([(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
                  (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)])
    F = _orient(V, F)
    p = V.mean(0) if pivot is None else np.asarray(pivot, float)
    V = (V - p) @ np.asarray(R).T + p
    m = Model()
    m.meshes.append((V, F, _colors(len(F), col, name)))
    return m


def sprite(kind, pos, normal, up=(0, 1, 0), r=0.03, **kw):
    n = np.asarray(normal, float)
    n /= np.linalg.norm(n)
    u = np.asarray(up, float)
    right = np.cross(u, n)
    right /= np.linalg.norm(right)
    u = np.cross(n, right)
    m = Model()
    m.sprites.append(dict(kind=kind, pos=np.asarray(pos, float), normal=n, up=u, right=right, r=r, **kw))
    return m


# ============================================================================ palette
FUR, FUR_D = hexc("#8F98A8"), hexc("#6F7788")
CREAM, PINKC = hexc("#F3F0EA"), hexc("#F2A3B3")
HOODIE, HOODIE_D = hexc("#D8603A"), hexc("#B34B2C")
JEANS, SKIN, SKIN_D, HAIR, SHOE = hexc("#3E4E70"), hexc("#EDBE9A"), hexc("#DDA67F"), hexc("#4B3426"), hexc("#2B2B30")
WOOD, WOOD2 = hexc("#B98656"), hexc("#AD7B4D")
WALL, WALL2, TRIM = hexc("#EEE2CC"), hexc("#E4D5BA"), hexc("#FAF7F0")
DOOR, BRASS, SOFA, SOFA2 = hexc("#2F6EA6"), hexc("#D8B04A"), hexc("#3F8C8C"), hexc("#4FA0A0")
RUG, LEAF, POT = hexc("#8DAA91"), hexc("#4E9A5A"), hexc("#C4683E")


# ============================================================================ characters
def cat_head(eyes="open", ears=0.0, mouth=True, look=None):
    look = look or {}
    fur, cream = look.get("fur", FUR), look.get("cream", CREAM)
    m = Model()
    m.add(ell("head", (0, 0.40, 0.04), (0.135, 0.115, 0.12), fur, sub=2, jitter=0.04))
    for sx in (-1, 1):
        m.add(ell(f"cheek{sx}", (sx * 0.08, 0.37, 0.08), (0.062, 0.05, 0.05), fur))
        tilt = sx * (0.38 - 0.35 * ears)
        R = rot_z(-tilt) @ rot_x(-0.12 + 0.25 * min(0, ears))
        m.add(cone(f"ear{sx}", (sx * 0.075, 0.47, 0.03), 0.052, 0.105 + 0.02 * max(0, ears), fur, R))
        m.add(cone(f"ein{sx}", (sx * 0.075, 0.468, 0.047), 0.032, 0.075, PINKC, R))
        m.add(sprite("cat_eye", (sx * 0.054, 0.418, 0.143), (sx * 0.38, 0.1, 0.92), r=0.041,
                     state=eyes, lid=fur))
    m.add(ell("muzzle", (0, 0.368, 0.128), (0.066, 0.046, 0.042), cream))
    m.add(ell("nose", (0, 0.392, 0.168), (0.018, 0.012, 0.011), PINKC))
    if mouth:
        m.add(sprite("cat_mouth", (0, 0.35, 0.168), (0, -0.25, 1), r=0.022))
    return m


def build_cat(pose="sit", t=0.0, eyes="open", ears=0.0, yaw=0.0, pitch=0.0, run=0.0, look=None):
    """Cat facing +z with its feet at the origin."""
    look = look or {}
    fur, cream = look.get("fur", FUR), look.get("cream", CREAM)
    m = Model()
    head = cat_head(eyes, ears, look=look)
    if pose == "sit":
        breathe = 1 + 0.015 * math.sin(t * 3)
        m.add(ell("body", (0, 0.16, -0.01), (0.125, 0.16 * breathe, 0.14), fur, rot_x(-0.15), sub=2, jitter=0.04))
        m.add(ell("chest", (0, 0.2, 0.085), (0.082, 0.11, 0.06), cream))
        for sx in (-1, 1):
            m.add(ell(f"haunch{sx}", (sx * 0.088, 0.08, -0.04), (0.066, 0.076, 0.1), fur))
            m.add(ell(f"leg{sx}", (sx * 0.046, 0.09, 0.085), (0.033, 0.085, 0.036), fur))
            m.add(ell(f"paw{sx}", (sx * 0.046, 0.016, 0.11), (0.039, 0.021, 0.046), cream))
        sw = 0.04 * math.sin(t * 2.2)
        for i in range(7):
            s = i / 6
            p = (0.06 + 0.12 * s + sw * s, 0.03 + 0.05 * s * s * (0.5 + 0.5 * math.sin(t * 3)),
                 -0.14 + 0.2 * s * s)
            m.add(ell(f"tail{i}", p, (0.032 - 0.008 * s,) * 3, fur if i < 6 else FUR_D))
        head.xform(rot_y(yaw) @ rot_x(pitch), pivot=(0, 0.31, 0.03))
    elif pose == "curl":
        breathe = 1 + 0.03 * math.sin(t * 2.4)
        m.add(ell("cbody", (0, 0.09, -0.02), (0.17, 0.1 * breathe, 0.15), fur, sub=2, jitter=0.04))
        for i in range(9):
            a = -1.9 + 2.9 * i / 8
            m.add(ell(f"ctail{i}", (0.18 * math.sin(a), 0.035, 0.16 * math.cos(a) - 0.01),
                      (0.034,) * 3, fur))
        m.add(ell("cpaw", (-0.06, 0.03, 0.12), (0.045, 0.025, 0.05), cream))
        head.xform(rot_y(0.25 + yaw) @ rot_x(0.35 + pitch), t=(0.03, -0.24, 0.07), pivot=(0, 0.31, 0.03))
    elif pose == "run":
        ph = run
        bob = 0.025 * abs(math.sin(ph))
        m.add(ell("rbody", (0, 0.2 + bob, -0.01), (0.105, 0.095, 0.2), fur, rot_x(0.08), sub=2, jitter=0.04))
        m.add(ell("rchest", (0, 0.18 + bob, 0.12), (0.07, 0.07, 0.06), cream))
        for fz, off in ((0.12, 0), (-0.13, math.pi)):
            for sx in (-1, 1):
                a = 0.75 * math.sin(ph + off + (0.4 if sx > 0 else 0))
                leg = ell(f"rleg{fz}{sx}", (0, -0.08, 0), (0.032, 0.085, 0.034), fur)
                leg.add(ell(f"rpaw{fz}{sx}", (0, -0.16, 0.015), (0.036, 0.02, 0.044), cream))
                leg.xform(rot_x(-a), t=(sx * 0.055, 0.19 + bob, fz))
                m.add(leg)
        for i in range(6):
            s = i / 5
            m.add(ell(f"rtail{i}", (0, 0.24 + bob + 0.12 * s, -0.2 - 0.14 * s + 0.03 * math.sin(ph + s * 2)),
                      (0.03 - 0.006 * s,) * 3, fur))
        head.xform(rot_x(0.12 + pitch), t=(0, -0.08 + bob, 0.21), pivot=(0, 0.31, 0.03))
    m.add(head)
    return m


def build_human(walk=None, yaw=0.0, eyes="half", arms="down", mouth="smug"):
    """Owner facing +z, feet at the origin. walk = phase (radians) or None for standing."""
    m = Model()
    sw = 0.0 if walk is None else math.sin(walk)
    for sx in (-1, 1):
        a = 0.45 * sw * sx
        leg = ell(f"hleg{sx}", (0, -0.45, 0), (0.078, 0.46, 0.088), JEANS)
        leg.add(ell(f"shoe{sx}", (0, -0.88, 0.05), (0.064, 0.048, 0.115), SHOE))
        leg.xform(rot_x(a), t=(sx * 0.1, 0.92, 0))
        m.add(leg)
    m.add(ell("torso", (0, 1.18, 0), (0.21, 0.32, 0.135), HOODIE, sub=2, jitter=0.04))
    m.add(ell("hood", (0, 1.46, -0.08), (0.14, 0.075, 0.085), HOODIE_D))
    m.add(ell("pocket", (0, 1.0, 0.105), (0.13, 0.07, 0.04), HOODIE_D))
    for sx in (-1, 1):
        arm = ell(f"arm{sx}", (0, -0.28, 0), (0.062, 0.3, 0.066), HOODIE)
        arm.add(ell(f"hand{sx}", (0, -0.6, 0.01), (0.046, 0.056, 0.046), SKIN))
        if arms == "cradle":
            arm.xform(rot_y(-sx * 0.75) @ rot_x(-1.4), t=(sx * 0.2, 1.38, 0.02))
        else:
            arm.xform(rot_z(sx * 0.1) @ rot_x(-0.45 * sw * sx), t=(sx * 0.205, 1.38, 0))
        m.add(arm)
    head = Model()
    head.add(ell("neck", (0, 1.52, 0), (0.05, 0.05, 0.05), SKIN_D))
    head.add(ell("hhead", (0, 1.66, 0.01), (0.105, 0.13, 0.115), SKIN, sub=2, jitter=0.04))
    head.add(ell("hair", (0, 1.735, -0.02), (0.117, 0.088, 0.122), HAIR, sub=2))
    head.add(ell("fringe", (0.025, 1.752, 0.058), (0.092, 0.045, 0.07), HAIR))
    head.add(ell("hnose", (0, 1.642, 0.118), (0.022, 0.03, 0.024), SKIN_D))
    for sx in (-1, 1):
        head.add(ell(f"hear{sx}", (sx * 0.105, 1.65, 0.0), (0.022, 0.036, 0.026), SKIN_D))
        head.add(sprite("h_eye", (sx * 0.041, 1.676, 0.106), (sx * 0.3, 0, 0.95), r=0.021, state=eyes, lid=SKIN))
    head.add(sprite("h_mouth", (0, 1.598, 0.11), (0, -0.1, 1), r=0.026, state=mouth))
    head.xform(rot_y(yaw), pivot=(0, 1.5, 0))
    m.add(head)
    return m


# ============================================================================ room
ROOM = dict(x0=-2.0, x1=2.5, z0=-2.5, z1=2.5, h=2.6)
DOOR_X0, DOOR_X1, DOOR_H = 0.5, 1.4, 2.0
WIN = dict(z0=-1.6, z1=-0.4, y0=0.88, y1=1.85)


def quad(a, b, c, d):
    return np.array([a, b, c, d], float)


def room_shell():
    x0, x1, z0, z1, h = ROOM["x0"], ROOM["x1"], ROOM["z0"], ROOM["z1"], ROOM["h"]
    polys = []
    n = 12
    for i in range(n):  # floor planks
        za, zb = z0 + (z1 - z0) * i / n, z0 + (z1 - z0) * (i + 1) / n
        polys.append((quad((x0, 0, za), (x1, 0, za), (x1, 0, zb), (x0, 0, zb)), WOOD if i % 2 else WOOD2))
    polys.append((quad((x0, 0, z0), (x1, 0, z0), (x1, h, z0), (x0, h, z0)), WALL))  # back
    polys.append((quad((x0, 0, z1), (x0, 0, z0), (x0, h, z0), (x0, h, z1)), WALL2))  # left
    polys.append((quad((x1, 0, z0), (x1, 0, z1), (x1, h, z1), (x1, h, z0)), WALL2))  # right
    polys.append((quad((x1, 0, z1), (x0, 0, z1), (x0, h, z1), (x1, h, z1)), WALL))  # front
    polys.append((quad((x0, h, z0), (x1, h, z0), (x1, h, z1), (x0, h, z1)), hexc("#F6EFE2")))
    e = 0.004
    for (a, b) in (((x0, z0 + e), (x1, z0 + e)), ((x0 + e, z1), (x0 + e, z0)), ((x1 - e, z0), (x1 - e, z1))):
        polys.append((quad((a[0], 0, a[1]), (b[0], 0, b[1]), (b[0], 0.1, b[1]), (a[0], 0.1, a[1])), TRIM))
    zb = z0 + 0.006
    polys.append((quad((DOOR_X0 - 0.07, 0, zb), (DOOR_X1 + 0.07, 0, zb), (DOOR_X1 + 0.07, DOOR_H + 0.07, zb),
                       (DOOR_X0 - 0.07, DOOR_H + 0.07, zb)), TRIM))
    polys.append((quad((DOOR_X0, 0, zb + e), (DOOR_X1, 0, zb + e), (DOOR_X1, DOOR_H, zb + e),
                       (DOOR_X0, DOOR_H, zb + e)), hexc("#FFF2CF")))  # light from the hallway
    xw = x0 + 0.006
    polys.append((quad((xw, WIN["y0"] - 0.07, WIN["z1"] + 0.07), (xw, WIN["y0"] - 0.07, WIN["z0"] - 0.07),
                       (xw, WIN["y1"] + 0.07, WIN["z0"] - 0.07), (xw, WIN["y1"] + 0.07, WIN["z1"] + 0.07)), TRIM))
    polys.append((quad((-0.55, 1.25, zb), (0.15, 1.25, zb), (0.15, 1.75, zb), (-0.55, 1.75, zb)), hexc("#6B4A33")))
    polys.append((quad((-0.5, 1.3, zb + e), (0.1, 1.3, zb + e), (0.1, 1.7, zb + e), (-0.5, 1.7, zb + e)),
                  hexc("#E9B949")))
    polys.append((quad((-0.42, 1.36, zb + 2 * e), (0.02, 1.36, zb + 2 * e), (-0.1, 1.6, zb + 2 * e)
                       , (-0.2, 1.62, zb + 2 * e)), hexc("#F2D27A")))
    return polys


def window_quad():
    xw = ROOM["x0"] + 0.012
    return quad((xw, WIN["y0"], WIN["z1"]), (xw, WIN["y0"], WIN["z0"]), (xw, WIN["y1"], WIN["z0"]),
                (xw, WIN["y1"], WIN["z1"]))


def outside_model():
    m = Model()
    m.add(box("lawn", (-14, -0.6, -12), (-2.05, 0.0, 10), hexc("#7DB36A")))
    m.add(box("street", (-9, -0.58, -12), (-6.5, 0.02, 10), hexc("#8A8D95")))
    for i, (z, col) in enumerate(((-4.0, "#E8A87C"), (-0.5, "#9FC5E8"), (3.0, "#F3D28B"))):
        m.add(box(f"house{i}", (-12.5, 0, z - 1.3), (-10.5, 2.4, z + 1.3), hexc(col)))
        m.add(cone(f"roof{i}", (-11.5, 2.4, z), 1.9, 1.2, hexc("#A0524A"), rot_y(math.pi / 4), n=4))
    m.add(box("trunk", (-4.2, 0, -2.2), (-3.9, 1.6, -1.9), hexc("#7A5233")))
    for i, (c, r) in enumerate((((-4.05, 2.1, -2.05), 0.9), ((-4.4, 1.8, -1.5), 0.6), ((-3.7, 1.9, -2.6), 0.6))):
        m.add(ell(f"tree{i}", c, (r, r * 0.9, r), LEAF))
    return m


def props(door_angle=0.0, hoodie=True):
    m = Model()
    door = box("door", (DOOR_X0, 0, ROOM["z0"] + 0.01), (DOOR_X1, DOOR_H, ROOM["z0"] + 0.05), DOOR)
    door.add(ell("knob", (DOOR_X1 - 0.09, 1.0, ROOM["z0"] + 0.08), (0.03, 0.03, 0.03), BRASS))
    door.add(box("doorpanel", (DOOR_X0 + 0.12, 1.15, ROOM["z0"] + 0.05), (DOOR_X1 - 0.12, 1.85, ROOM["z0"] + 0.06),
                 DOOR * 1.08))
    door.xform(rot_y(-door_angle), pivot=(DOOR_X0, 0, ROOM["z0"] + 0.03))
    m.add(door)
    x0 = ROOM["x0"]
    m.add(box("sill", (x0, 0.8, WIN["z0"] - 0.12), (x0 + 0.24, 0.86, WIN["z1"] + 0.12), TRIM))
    m.add(box("sofa_seat", (-1.75, 0.05, -2.45), (-0.25, 0.42, -1.7), SOFA))
    m.add(box("sofa_back", (-1.75, 0.05, -2.48), (-0.25, 0.95, -2.22), SOFA))
    for i, x in enumerate((-1.75, -0.4)):
        m.add(box(f"sofa_arm{i}", (x, 0.05, -2.45), (x + 0.15, 0.62, -1.7), SOFA2))
    m.add(box("cushion", (-1.58, 0.42, -2.2), (-0.42, 0.5, -1.75), SOFA2))
    if hoodie:
        m.add(ell("hoodie1", (-1.0, 0.53, -1.98), (0.28, 0.045, 0.2), HOODIE, rot_y(0.3)))
        m.add(ell("hoodie2", (-0.8, 0.54, -1.85), (0.08, 0.04, 0.17), HOODIE_D, rot_y(-0.6)))
        m.add(ell("hoodie3", (-1.22, 0.55, -2.05), (0.13, 0.05, 0.1), HOODIE_D))
    m.add(box("pot", (2.05, 0, -2.4), (2.4, 0.38, -2.05), POT))
    for i in range(6):
        a = i * TAU / 6
        m.add(ell(f"leaf{i}", (2.22 + 0.17 * math.cos(a), 0.62, -2.22 + 0.17 * math.sin(a)), (0.08, 0.3, 0.06),
                  LEAF, rot_y(a) @ rot_z(0.35)))
    return m


# ============================================================================ renderer
class Camera:
    def __init__(self, pos, target, fov=50):
        self.pos = np.asarray(pos, float)
        f = np.asarray(target, float) - self.pos
        f /= np.linalg.norm(f)
        r = np.cross(f, (0, 1, 0))
        r /= np.linalg.norm(r)
        u = np.cross(r, f)
        self.M = np.stack([r, u, f])
        self.focal = (H / 2) / math.tan(math.radians(fov) / 2)

    def cam(self, P):
        return (np.asarray(P) - self.pos) @ self.M.T

    def proj(self, C):
        z = np.maximum(C[..., 2], 1e-4)
        return np.stack([W / 2 + C[..., 0] / z * self.focal, H / 2 - C[..., 1] / z * self.focal], -1)


NEAR = 0.05


def clip_near(C):
    out = []
    n = len(C)
    for i in range(n):
        a, b = C[i], C[(i + 1) % n]
        ina, inb = a[2] >= NEAR, b[2] >= NEAR
        if ina:
            out.append(a)
        if ina != inb:
            t = (NEAR - a[2]) / (b[2] - a[2])
            out.append(a + (b - a) * t)
    return np.array(out)


def fill_poly(ctx, pts, col, alpha=1.0, seam=True):
    ctx.move_to(*pts[0])
    for p in pts[1:]:
        ctx.line_to(*p)
    ctx.close_path()
    ctx.set_source_rgba(*np.clip(col, 0, 1), alpha)
    if seam:
        ctx.fill_preserve()
        ctx.set_line_width(1.2)
        ctx.stroke()
    else:
        ctx.fill()


class Light:
    def __init__(self, tod=0.3):
        """tod 0 = morning, 1 = evening."""
        a = -0.6 + 1.4 * tod
        self.dir = np.array([-0.45 + 0.4 * math.sin(a), 0.75, 0.5])
        self.dir /= np.linalg.norm(self.dir)
        warm = smooth((tod - 0.45) / 0.55)
        self.tint = np.array([1.0, 1.0 - 0.1 * warm, 1.0 - 0.25 * warm])
        self.amb, self.dif = 0.58 - 0.08 * warm, 0.5


def shade(col, n, light):
    lam = max(0.0, float(n @ light.dir))
    k = light.amb + light.dif * lam + 0.06 * n[1]
    return np.clip(col * k * light.tint, 0, 1)


def draw_shell(ctx, cam, light, polys):
    for P, col in polys:
        C = clip_near(cam.cam(P))
        if len(C) < 3:
            continue
        n = np.cross(P[1] - P[0], P[2] - P[0])
        n /= np.linalg.norm(n) + 1e-9
        if n @ (cam.pos - P[0]) < 0:
            n = -n
        fill_poly(ctx, cam.proj(C), shade(col, n, light), seam=False)


def draw_model(ctx, cam, light, model, extra=None):
    """Painter's algorithm over every face of every mesh, with sprites interleaved by depth."""
    items = []
    if model.meshes:
        V = np.vstack([m[0] for m in model.meshes])
        offs = np.cumsum([0] + [len(m[0]) for m in model.meshes])
        F = np.vstack([m[1] + o for m, o in zip(model.meshes, offs)])
        Cf = np.vstack([m[2] for m in model.meshes])
        C = cam.cam(V)
        S = cam.proj(C)
        a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
        N = np.cross(b - a, c - a)
        N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
        vis = ((cam.pos - a) * N).sum(1) > 0
        zc = C[F, 2]
        vis &= zc.min(1) > NEAR
        depth = zc.mean(1)
        lam = np.clip(N @ light.dir, 0, None)
        K = (light.amb + light.dif * lam + 0.06 * N[:, 1])[:, None]
        cols = np.clip(Cf * K * light.tint, 0, 1)
        for i in np.nonzero(vis)[0]:
            items.append((depth[i], 0, S[F[i]], cols[i]))
    for s in model.sprites:
        cz = cam.cam(s["pos"])[2]
        if cz > NEAR and s["normal"] @ (cam.pos - s["pos"]) > 0:
            items.append((cz - 0.03, 1, s, None))
    items.sort(key=lambda it: -it[0])
    for d, kind, a, col in items:
        if kind == 0:
            fill_poly(ctx, a, col)
        else:
            draw_sprite(ctx, cam, light, a)


def draw_sprite(ctx, cam, light, s):
    p, r = s["pos"], s["r"]
    sp = cam.proj(cam.cam(p))
    ex = cam.proj(cam.cam(p + s["right"] * r)) - sp
    ey = cam.proj(cam.cam(p - s["up"] * r)) - sp
    ctx.save()
    ctx.transform(cairo.Matrix(ex[0], ex[1], ey[0], ey[1], sp[0], sp[1]))
    k, st = s["kind"], s.get("state", "open")
    dark = (0.08, 0.06, 0.09)
    if k in ("cat_eye", "h_eye"):
        big = k == "cat_eye"
        lid = shade(s["lid"], s["normal"], light)
        if st == "closed":
            ctx.move_to(-0.95, -0.05)
            ctx.curve_to(-0.4, 0.55, 0.4, 0.55, 0.95, -0.05)
            ctx.set_source_rgb(*dark)
            ctx.set_line_width(0.2)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.stroke()
        else:
            ry = 1.15 if (big and st == "wide") else 1.0
            ctx.save()
            ctx.scale(1, ry)
            ctx.arc(0, 0, 1, 0, TAU)
            ctx.restore()
            ctx.set_source_rgb(*dark)
            ctx.fill()
            if big:
                g = cairo.RadialGradient(0, 0.5, 0.1, 0, 0.3, 1.0)
                g.add_color_stop_rgba(0, 0.35, 0.45, 0.6, 0.55)
                g.add_color_stop_rgba(1, 0.35, 0.45, 0.6, 0.0)
                ctx.save()
                ctx.scale(1, ry)
                ctx.arc(0, 0, 1, 0, TAU)
                ctx.restore()
                ctx.set_source(g)
                ctx.fill()
                if st == "wet":
                    ctx.save()
                    ctx.scale(1, ry)
                    ctx.arc(0, 0, 0.98, 0.15 * math.pi, 0.85 * math.pi)
                    ctx.restore()
                    ctx.set_source_rgba(0.75, 0.9, 1.0, 0.75)
                    ctx.set_line_width(0.14)
                    ctx.stroke()
            hl = 1.0 if big else 0.7
            ctx.arc(0.33, -0.36, 0.3 * hl, 0, TAU)
            ctx.set_source_rgb(1, 1, 1)
            ctx.fill()
            ctx.arc(-0.33, 0.34, 0.13 * hl, 0, TAU)
            ctx.fill()
            if st in ("half", "sleepy"):
                cover = -0.05 if st == "half" else 0.25
                ctx.save()
                ctx.arc(0, 0, 1.08, 0, TAU)
                ctx.clip()
                ctx.rectangle(-1.3, -1.4, 2.6, 1.4 + cover)
                ctx.set_source_rgb(*lid)
                ctx.fill()
                ctx.restore()
                ctx.move_to(-1.05, cover)
                ctx.curve_to(-0.4, cover + 0.12, 0.4, cover + 0.12, 1.05, cover)
                ctx.set_source_rgb(*dark)
                ctx.set_line_width(0.2)
                ctx.stroke()
        if not big:  # eyebrow
            ctx.move_to(-0.95, -1.5)
            ctx.curve_to(-0.3, -1.85, 0.4, -1.8, 1.0, -1.55)
            ctx.set_source_rgb(*shade(HAIR, s["normal"], light))
            ctx.set_line_width(0.35)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.stroke()
    elif k == "cat_mouth":
        ctx.move_to(-0.9, -0.1)
        ctx.curve_to(-0.7, 0.6, -0.1, 0.6, 0, 0)
        ctx.curve_to(0.1, 0.6, 0.7, 0.6, 0.9, -0.1)
        ctx.set_source_rgb(*dark)
        ctx.set_line_width(0.18)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.stroke()
    elif k == "h_mouth":
        ctx.move_to(-0.7, 0.05)
        ctx.curve_to(-0.2, 0.25, 0.4, 0.2, 0.75, -0.15)
        ctx.set_source_rgb(0.45, 0.22, 0.2)
        ctx.set_line_width(0.22)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.stroke()
    ctx.restore()


def floor_shadow(ctx, cam, x, z, r, y=0.0, alpha=0.22):
    ang = np.linspace(0, TAU, 20, endpoint=False)
    P = np.stack([x + np.cos(ang) * r, np.full(20, y + 0.003), z + np.sin(ang) * r * 0.85], 1)
    C = clip_near(cam.cam(P))
    if len(C) >= 3:
        fill_poly(ctx, cam.proj(C), (0.1, 0.07, 0.05), alpha, seam=False)


def wall_clock(ctx, cam, light, hours):
    c = np.array([-1.0, 1.82, ROOM["z0"] + 0.01])
    ang = np.linspace(0, TAU, 28, endpoint=False)
    for rad, col in ((0.17, hexc("#3A3A40")), (0.145, hexc("#FBFAF5"))):
        P = c + np.stack([np.cos(ang) * rad, np.sin(ang) * rad, np.zeros(28)], 1)
        C = clip_near(cam.cam(P))
        if len(C) >= 3:
            fill_poly(ctx, cam.proj(C), shade(col, np.array([0, 0, 1.0]), light), seam=False)
    for frac, length, lw in ((hours / 12, 0.08, 0.016), (hours % 1, 0.12, 0.01)):
        a = math.pi / 2 - frac * TAU
        p0, p1 = cam.proj(cam.cam(c)), cam.proj(cam.cam(c + np.array([math.cos(a), math.sin(a), 0]) * length))
        ctx.move_to(*p0)
        ctx.line_to(*p1)
        ctx.set_source_rgb(0.15, 0.15, 0.17)
        ctx.set_line_width(lw * cam.focal / max(cam.cam(c)[2], 0.1))
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.stroke()


def sun_patch(ctx, cam, tod):
    """Window light falling on the floor, sliding across the room as the day goes on."""
    a = 0.4 + 2.2 * tod
    dz = -0.5 + 1.0 * tod
    P = np.array([(ROOM["x0"], 0.004, WIN["z0"]), (ROOM["x0"], 0.004, WIN["z1"]),
                  (ROOM["x0"] + a, 0.004, WIN["z1"] + dz), (ROOM["x0"] + a, 0.004, WIN["z0"] + dz)])
    C = clip_near(cam.cam(P))
    if len(C) >= 3:
        warm = smooth((tod - 0.45) / 0.55)
        fill_poly(ctx, cam.proj(C), (1.0, 0.93 - 0.15 * warm, 0.7 - 0.3 * warm), 0.28, seam=False)


SHELL = room_shell()
OUTSIDE = outside_model()


def draw_world(ctx, cam, light, actors, door=0.0, tod=0.3, clock=10.0, shadows=(), hoodie=True):
    draw_shell(ctx, cam, light, SHELL)
    C = clip_near(cam.cam(window_quad()))
    if len(C) >= 3:  # the view outside, clipped to the window
        pts = cam.proj(C)
        ctx.save()
        ctx.move_to(*pts[0])
        for p in pts[1:]:
            ctx.line_to(*p)
        ctx.close_path()
        ctx.clip()
        top, bot = pts[:, 1].min(), pts[:, 1].max()
        g = cairo.LinearGradient(0, top, 0, bot)
        warm = smooth((tod - 0.45) / 0.55)
        g.add_color_stop_rgb(0, 0.45 + 0.4 * warm, 0.72 - 0.1 * warm, 0.95 - 0.35 * warm)
        g.add_color_stop_rgb(1, 0.82 + 0.15 * warm, 0.9 - 0.1 * warm, 0.98 - 0.4 * warm)
        ctx.set_source(g)
        ctx.paint()
        draw_model(ctx, cam, Light(tod), OUTSIDE)
        ctx.restore()
        xw = ROOM["x0"] + 0.014  # window bars
        zm, ym = (WIN["z0"] + WIN["z1"]) / 2, (WIN["y0"] + WIN["y1"]) / 2
        bars = [quad((xw, WIN["y0"], zm - 0.02), (xw, WIN["y0"], zm + 0.02), (xw, WIN["y1"], zm + 0.02),
                     (xw, WIN["y1"], zm - 0.02)),
                quad((xw, ym - 0.02, WIN["z1"]), (xw, ym - 0.02, WIN["z0"]), (xw, ym + 0.02, WIN["z0"]),
                     (xw, ym + 0.02, WIN["z1"]))]
        draw_shell(ctx, cam, light, [(b, TRIM) for b in bars])
    sun_patch(ctx, cam, tod)
    ang = np.linspace(0, TAU, 24, endpoint=False)  # rug
    P = np.stack([0.1 + np.cos(ang) * 1.0, np.full(24, 0.002), -0.6 + np.sin(ang) * 0.7], 1)
    C = clip_near(cam.cam(P))
    if len(C) >= 3:
        fill_poly(ctx, cam.proj(C), shade(RUG, np.array([0, 1.0, 0]), light), seam=False)
    wall_clock(ctx, cam, light, clock)
    for x, z, r in shadows:
        floor_shadow(ctx, cam, x, z, r)
    world = props(door, hoodie)
    for a in actors:
        world.add(a)
    draw_model(ctx, cam, light, world)


# ============================================================================ shots
def lerp(a, b, u):
    return np.asarray(a, float) + (np.asarray(b, float) - np.asarray(a, float)) * u


def place(model, pos, heading):
    return model.xform(rot_y(heading), t=pos)


def shot_cat_hello(ctx, t, d):
    u = smooth(t / d)
    cam = Camera(lerp((0.2, 0.36, 0.62), (0.2, 0.37, 0.45), u), (0.2, 0.37, -0.3), 50)
    cat = place(build_cat("sit", t, eyes="wet", pitch=-0.18, yaw=0.05 * math.sin(t * 1.5)), (0.2, 0, -0.3), 0)
    draw_world(ctx, cam, Light(0.15), [cat], shadows=[(0.2, -0.32, 0.17)], clock=8.2)


def shot_leave(ctx, t, d):
    u = t / d
    pos = lerp((0.55, 0, -0.5), (0.95, 0, -2.05), smooth(u * 1.15))
    door = 1.25 * smooth((u - 0.55) / 0.4)
    walking = u < 0.92
    human = place(build_human(walk=t * 7 if walking else None, eyes="open"), pos, math.pi + 0.15 * (1 - u))
    cat = place(build_cat("sit", t, eyes="wet", pitch=-0.25, yaw=0.3), (-0.25, 0, 0.35), math.pi - 0.3)
    cam = Camera((-0.15, 0.32, 1.05), lerp((0.75, 0.85, -2.5), (0.9, 0.95, -2.5), u), 52)
    draw_world(ctx, cam, Light(0.15), [human, cat], door=door, clock=8.25,
               shadows=[(pos[0], pos[2], 0.3), (-0.25, 0.33, 0.17)])


def shot_owner_face(ctx, t, d):
    u = smooth(t / d)
    human = place(build_human(eyes="half", yaw=-0.12 + 0.05 * math.sin(t)), (0, 0, -0.5), 0)
    cam = Camera(lerp((0.08, 1.64, 0.2), (0.04, 1.65, 0.05), u), (0, 1.66, -0.5), 50)
    draw_world(ctx, cam, Light(0.15), [human], clock=8.3)


def shot_door_close(ctx, t, d):
    door = 1.25 * (1 - smooth(t / (0.6 * d)))
    ears = -0.6 * smooth((t - 0.55 * d) / 0.3)
    cat = place(build_cat("sit", t, ears=ears, pitch=-0.2), (0.95, 0, -1.05), math.pi)
    cam = Camera((0.78, 0.55, -0.15), (0.95, 0.85, -2.5), 54)
    draw_world(ctx, cam, Light(0.2), [cat], door=door, clock=8.4, shadows=[(0.95, -1.05, 0.17)])


def shot_sill_back(ctx, t, d):
    u = smooth(t / d)
    cat = place(build_cat("sit", t, pitch=-0.05, yaw=0.15 * math.sin(t * 0.9)), (-1.86, 0.86, -1.0), -math.pi / 2)
    cam = Camera(lerp((-0.75, 1.22, -0.5), (-0.95, 1.22, -0.6), u), (-2.0, 1.25, -1.05), 52)
    draw_world(ctx, cam, Light(0.3), [cat], clock=9.5)


def shot_sill_side(ctx, t, d):
    u = smooth(t / d)
    cat = place(build_cat("sit", t, eyes="wet", pitch=-0.12, yaw=0.95), (-1.86, 0.86, -1.0), -math.pi / 2)
    cam = Camera(lerp((-1.72, 1.29, -0.42), (-1.74, 1.28, -0.5), u), (-1.86, 1.26, -1.0), 48)
    draw_world(ctx, cam, Light(0.35), [cat], clock=10.0)


def shot_timelapse(ctx, t, d):
    u = t / d
    tod = 0.1 + 0.8 * u
    cat = place(build_cat("curl", t, eyes="closed"), (-0.6, 0, -0.9), 0.6)
    cam = Camera((2.15, 1.85, 1.6), (-0.7, 0.55, -1.4), 55)
    draw_world(ctx, cam, Light(tod), [cat], tod=tod, clock=10 + 7 * u, shadows=[(-0.6, -0.9, 0.22)])


def shot_curl(ctx, t, d):
    u = smooth(t / d)
    cat = place(build_cat("curl", t, eyes="closed"), (-0.98, 0.5, -1.98), 0.2)
    cam = Camera(lerp((-0.7, 0.88, -1.15), (-0.8, 0.82, -1.35), u), (-1.0, 0.6, -2.0), 50)
    draw_world(ctx, cam, Light(0.85), [cat], tod=0.85, clock=17.2)


def shot_memory(ctx, t, d):
    u = smooth(t / d)
    human = place(build_human(arms="cradle", eyes="open", mouth="smile"), (0, 0, -0.6), 0)
    kitten = build_cat("sit", t, eyes="wet", pitch=-0.35, yaw=0.1 * math.sin(t * 2))
    kitten.xform(np.eye(3) * 0.55)
    kitten = place(kitten, (0, 1.17, -0.2), 0)
    cam = Camera(lerp((0.05, 1.5, 0.5), (0.03, 1.48, 0.38), u), (0, 1.33, -0.45), 50)
    draw_world(ctx, cam, Light(0.3), [human, kitten], clock=8.0)


def shot_perk(ctx, t, d):
    k = smooth(t / 0.35)
    eyes = "sleepy" if t < 0.15 else ("wide" if t < 0.9 else "open")
    cat = place(build_cat("sit", t, eyes=eyes, ears=-0.6 + 1.6 * k, yaw=-0.12 * k, pitch=-0.05),
                (-0.98, 0.5, -1.98), 0.2)
    cam = Camera((-0.92, 0.84, -1.38), (-0.99, 0.84, -2.0), 50)
    draw_world(ctx, cam, Light(0.9), [cat], tod=0.9, clock=17.6)


def shot_run(ctx, t, d):
    u = t / d
    x = -1.4 + 2.3 * u
    cat = place(build_cat("run", t, run=t * 15, eyes="wide", ears=0.6), (x, 0, -1.3), math.pi / 2)
    cam = Camera((x + 0.95, 0.42, -0.6), (x + 0.12, 0.24, -1.3), 52)
    draw_world(ctx, cam, Light(0.9), [cat], tod=0.9, clock=17.7, shadows=[(x, -1.3, 0.2)])


def shot_enter(ctx, t, d):
    u = t / d
    door = 1.3 * smooth(u / 0.45)
    pos = lerp((1.0, 0, -2.3), (0.95, 0, -1.95), smooth((u - 0.3) / 0.6))
    human = place(build_human(walk=t * 7 if 0.3 < u < 0.9 else None, eyes="open"), pos, 0)
    cat = place(build_cat("sit", t, ears=1.0, pitch=-0.25), (0.95, 0, -1.2), math.pi)
    actors = [cat] + ([human] if u > 0.18 else [])
    cam = Camera((0.78, 0.38, -0.45), (0.95, 1.0, -2.5), 54)
    draw_world(ctx, cam, Light(0.92), actors, door=door, tod=0.92, clock=17.9,
               shadows=[(0.95, -1.2, 0.17)] + ([(pos[0], pos[2], 0.3)] if u > 0.18 else []))


def shot_unbothered(ctx, t, d):
    u = smooth(t / d)
    blink = (t % 2.6) > 2.45
    cat = place(build_cat("sit", t * 1.6, eyes="closed" if blink else "half", yaw=0.62, pitch=0.05),
                (0.95, 0, -1.2), 0)
    human = place(build_human(eyes="open"), (0.95, 0, -2.0), 0)
    cam = Camera(lerp((0.88, 0.46, -0.4), (0.9, 0.44, -0.55), u), (0.95, 0.4, -1.3), 52)
    draw_world(ctx, cam, Light(0.92), [cat, human], door=1.3, tod=0.92, clock=18.0,
               shadows=[(0.95, -1.2, 0.17), (0.95, -2.0, 0.3)])


SHOTS = {k[5:]: v for k, v in globals().items() if k.startswith("shot_")}
GRAY_SHOTS = {"memory"}


# ============================================================================ narration + timeline
KOKORO_DIR = os.path.join(VOICE_DIR, "kokoro")
KOKORO_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/"
VOICE_NAME = "af_heart"  # Kokoro's warmest US English narrator
SPEED = 0.9
# Narration lines spoken in one breath (indexes into SEGMENTS), and the pause after each, in seconds.
UTTERANCES = [([0], 0.3), ([1], 0.45), ([2, 3], 0.35), ([4], 0.6), ([5, 6], 0.45), ([7, 8], 0.4), ([9, 10], 0.0)]


def _download(url, path):
    if not os.path.exists(path):
        print("downloading", os.path.basename(path), file=sys.stderr)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        urllib.request.urlretrieve(url, path)


def ensure_kokoro():
    """Fetch the Kokoro model and voice from Hugging Face (once) and pack the voice for kokoro-onnx."""
    model = os.path.join(KOKORO_DIR, "model.onnx")
    _download(KOKORO_URL + "onnx/model.onnx", model)
    vbin = os.path.join(KOKORO_DIR, "voices", VOICE_NAME + ".bin")
    _download(KOKORO_URL + f"voices/{VOICE_NAME}.bin", vbin)
    packed = os.path.join(KOKORO_DIR, f"{VOICE_NAME}.npz")
    if not os.path.exists(packed):
        np.savez(packed, **{VOICE_NAME: np.fromfile(vbin, dtype=np.float32).reshape(-1, 1, 256)})
    return model, packed


def ensure_fonts():
    """Register the bundled caption font (Montserrat Black, SIL OFL) with fontconfig."""
    src = os.path.join(HERE, "fonts", "Montserrat-Black.ttf")
    dst_dir = os.path.expanduser("~/.local/share/fonts")
    dst = os.path.join(dst_dir, "Montserrat-Black.ttf")
    if not os.path.exists(dst):
        os.makedirs(dst_dir, exist_ok=True)
        with open(src, "rb") as a, open(dst, "wb") as b:
            b.write(a.read())
        subprocess.run(["fc-cache", "-f", dst_dir], check=False)


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def align_words(script_words, heard):
    """Give each script word the start/end time of the letters Whisper heard for it.

    Matching letter by letter copes with Whisper splitting or joining words
    ("windowsill" -> "window sill"); words it missed are interpolated."""
    import difflib
    sc = "".join(_norm(w) for w in script_words)
    hc, ht = [], []
    for w in heard:
        for ch in _norm(w.word):
            hc.append(ch)
            ht.append((w.start, w.end))
    cmap = {}
    for a, b, size in difflib.SequenceMatcher(None, sc, "".join(hc), autojunk=False).get_matching_blocks():
        for k in range(size):
            cmap[a + k] = b + k
    times, pos = [], 0
    for w in script_words:
        idx = [cmap[i] for i in range(pos, pos + len(_norm(w))) if i in cmap]
        times.append([ht[idx[0]][0], ht[idx[-1]][1]] if idx else None)
        pos += len(_norm(w))
    for i, tm in enumerate(times):
        if tm is None:
            prev = times[i - 1][1] if i and times[i - 1] else 0.0
            nxt = next((x[0] for x in times[i + 1:] if x), prev + 0.3)
            times[i] = [prev, max(prev + 0.08, nxt)]
    for i in range(1, len(times)):
        times[i][0] = max(times[i][0], times[i - 1][0] + 0.02)
    return times


WEAK_WORDS = {"the", "a", "an", "to", "your", "on", "and", "for", "of", "that", "she", "you", "it", "like", "but",
              "when", "then", "shes"}


def caption_chunks(words):
    """Group words into short phrases for on-screen captions.

    Each clause (split at punctuation) becomes one phrase if it is short, otherwise it is
    split into balanced 2-3 word phrases, preferring breaks that don't strand a single
    word or end a phrase on a small word like "the" or "your"."""
    clauses, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        nxt = words[i + 1] if i + 1 < len(words) else None
        if nxt is None or re.search(r"[,.!?…]$", w["raw"]) or nxt["seg"] != w["seg"]:
            clauses.append(cur)
            cur = []
    chunks = []
    for cl in clauses:
        n, letters = len(cl), sum(len(w["text"]) for w in cl)
        if n <= 3 or letters <= 16 or (n == 4 and letters <= 20):
            parts = [cl]
        else:
            parts, prev, k = [], 0, math.ceil(n / 3)
            while k > 1:
                target = prev + round((n - prev) / k)

                def score(c):
                    return (abs(c - target) + 3 * (_norm(cl[c - 1]["raw"]) in WEAK_WORDS)
                            + 3 * (c - prev == 1) + 3 * (n - c == 1))
                c = min(range(prev + 1, n), key=score)
                parts.append(cl[prev:c])
                prev, k = c, k - 1
            parts.append(cl[prev:])
        chunks += [dict(words=p, t0=p[0]["t0"], t1=p[-1]["t1"]) for p in parts]
    for a, b in zip(chunks, chunks[1:]):  # hold a phrase on screen until the next one if the gap is short
        a["t1"] = b["t0"] if b["t0"] - a["t1"] < 0.45 else a["t1"] + 0.25
    chunks[-1]["t1"] += 0.6
    return chunks


def build_timeline():
    from faster_whisper import WhisperModel
    from kokoro_onnx import Kokoro
    model, packed = ensure_kokoro()
    tts = Kokoro(model, packed)
    asr = WhisperModel("base.en", device="cpu", compute_type="int8", download_root=os.path.join(VOICE_DIR, "whisper"))
    t = 0.4
    clips, words, shots, sr = [], [], [], 24000
    for seg_ids, pause in UTTERANCES:
        text = " ".join(SEGMENTS[i][0] for i in seg_ids)
        a, sr = tts.create(text, voice=VOICE_NAME, speed=SPEED, lang="en-us")
        loud = np.nonzero(np.abs(a) > 0.01)[0]
        a = a[max(0, loud[0] - int(0.04 * sr)): loud[-1] + int(0.12 * sr)]
        a16 = np.interp(np.arange(0, len(a), sr / 16000), np.arange(len(a)), a).astype(np.float32)
        segs, _ = asr.transcribe(a16, word_timestamps=True, language="en", initial_prompt=text)
        heard = [w for s in segs for w in s.words]
        sw = text.split()
        times = align_words(sw, heard)
        k = 0
        for i in seg_ids:
            seg_text, shot_list = SEGMENTS[i]
            n = len(seg_text.split())
            seg_words = [dict(text=re.sub(r"[^A-Za-z0-9'’]", "", w).upper(), raw=w, t0=t + s, t1=t + e, seg=i)
                         for w, (s, e) in zip(sw[k:k + n], times[k:k + n])]
            kk = 0
            for name, nw in shot_list:  # cut a beat before the word lands
                shots.append(dict(name=name, t0=max(0.0, seg_words[kk]["t0"] - 0.08) if shots else 0.0))
                kk += nw
            assert kk == n, f"shot word counts don't add up for: {seg_text}"
            words += seg_words
            k += n
        clips.append((t, a))
        t += len(a) / sr + pause
    total = t + 1.1
    for i, s in enumerate(shots):
        s["t1"] = shots[i + 1]["t0"] if i + 1 < len(shots) else total
    return dict(words=words, chunks=caption_chunks(words), shots=shots, total=total, clips=clips, sr=sr)


# ============================================================================ captions
CAP_FONT = "Montserrat Black"
CAP_Y = 0.70  # vertical centre of the captions, as a fraction of the height
CAP_ACTIVE = (1.0, 0.84, 0.2)  # the word being spoken
CAP_TEXT = (1.0, 1.0, 1.0)


def ease_out_back(x):
    x = clamp(x)
    return 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2


def caption(ctx, chunk, t):
    """A 2-3 word phrase in bold Montserrat; the spoken word turns yellow and pops up a little."""
    words = [w["text"] for w in chunk["words"]]
    active = max((i for i, w in enumerate(chunk["words"]) if w["t0"] <= t), default=0)
    ctx.save()
    ctx.select_font_face(CAP_FONT, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    size = 88
    ctx.set_font_size(size)
    space = ctx.text_extents(" ").x_advance * 1.1
    widths = [ctx.text_extents(w).x_advance for w in words]
    lines, cur, cw = [], [], 0.0  # wrap to at most two lines
    for i, wd in enumerate(widths):
        if cur and cw + space + wd > W - 110:
            lines.append(cur)
            cur, cw = [], 0.0
        cw += (space if cur else 0) + wd
        cur.append(i)
    lines.append(cur)
    pop = ease_out_back((t - chunk["t0"]) / 0.22)
    line_h = size * 1.12
    cy = H * CAP_Y
    ctx.translate(W / 2, cy)
    ctx.scale(0.75 + 0.25 * pop, 0.75 + 0.25 * pop)
    ctx.translate(-W / 2, -cy)
    alpha = clamp((t - chunk["t0"]) / 0.08) * clamp((chunk["t1"] - t) / 0.08 + 0.001)
    ctx.push_group()
    for li, line in enumerate(lines):
        lw = sum(widths[i] for i in line) + space * (len(line) - 1)
        x = W / 2 - lw / 2
        base = cy + (li - (len(lines) - 1) / 2) * line_h + size * 0.36
        for i in line:
            k = 1.0
            if i == active:  # the spoken word grows a little as it starts
                k = 1 + 0.12 * (1 - clamp((t - chunk["words"][i]["t0"]) / 0.18)) + 0.06
            ctx.save()
            cx = x + widths[i] / 2
            ctx.translate(cx, base - size * 0.36)
            ctx.scale(k, k)
            ctx.translate(-cx, -(base - size * 0.36))
            ctx.move_to(x, base)
            ctx.text_path(words[i])
            path = ctx.copy_path()
            ctx.new_path()
            ctx.translate(0, 9)  # soft drop shadow
            ctx.append_path(path)
            ctx.set_source_rgba(0, 0, 0, 0.35)
            ctx.set_line_width(24)
            ctx.set_line_join(cairo.LINE_JOIN_ROUND)
            ctx.stroke()
            ctx.translate(0, -9)
            ctx.append_path(path)
            ctx.set_source_rgb(0.04, 0.03, 0.05)  # thick outline
            ctx.set_line_width(16)
            ctx.stroke_preserve()
            ctx.set_source_rgb(*(CAP_ACTIVE if i == active else CAP_TEXT))
            ctx.fill()
            ctx.restore()
            x += widths[i] + space
    ctx.pop_group_to_source()
    ctx.paint_with_alpha(alpha)
    ctx.restore()


# ============================================================================ frames
def surf_array(surf):
    return np.ndarray((surf.get_height(), surf.get_stride() // 4, 4), np.uint8, surf.get_data())[:, :surf.get_width()]


VIGNETTE = None


def vignette():
    global VIGNETTE
    if VIGNETTE is None:
        y, x = np.mgrid[0:H, 0:W]
        d = np.sqrt(((x - W / 2) / (W * 0.62)) ** 2 + ((y - H / 2) / (H * 0.62)) ** 2)
        VIGNETTE = np.clip(1 - 0.38 * np.clip(d - 0.55, 0, None) ** 1.5 * 2.2, 0.55, 1)[..., None].astype(np.float32)
    return VIGNETTE


TL = None


def render_frame(i):
    t = i / FPS
    shot = next(s for s in TL["shots"] if s["t0"] <= t < s["t1"] or s is TL["shots"][-1])
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    ctx = cairo.Context(surf)
    ctx.set_source_rgb(0, 0, 0)
    ctx.paint()
    SHOTS[shot["name"]](ctx, t - shot["t0"], shot["t1"] - shot["t0"])
    surf.flush()
    a = surf_array(surf)
    rgb = a[..., :3].astype(np.float32)
    if shot["name"] in GRAY_SHOTS:
        g = rgb @ np.array([0.114, 0.587, 0.299], np.float32)
        rgb = np.repeat(g[..., None], 3, 2) * 0.92 + 14
        rng = np.random.default_rng(i)
        rgb += rng.normal(0, 5, rgb.shape[:2])[..., None]
        rgb *= vignette() ** 1.6
    else:
        rgb *= vignette()
    a[..., :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    surf.mark_dirty()
    chunk = next((c for c in TL["chunks"] if c["t0"] <= t < c["t1"]), None)
    if chunk:
        caption(ctx, chunk, t)
    surf.flush()
    return bytes(surf.get_data())


# ============================================================================ audio
def synth_audio(tl, path):
    sr = 44100
    n = int(tl["total"] * sr)
    voice = np.zeros(n)
    for t0, a in tl["clips"]:
        up = np.interp(np.arange(int(len(a) * sr / tl["sr"])) / sr, np.arange(len(a)) / tl["sr"], a)
        i = int(t0 * sr)
        voice[i:i + len(up)] += up[: n - i]
    voice /= np.max(np.abs(voice)) + 1e-9

    music = np.zeros(n)

    def note(t0, f, dur, amp):
        x = np.arange(int(dur * sr)) / sr
        sig = (np.sin(TAU * f * x) + 0.45 * np.sin(TAU * 2 * f * x) * np.exp(-x * 2.5)
               + 0.2 * np.sin(TAU * 3 * f * x) * np.exp(-x * 4)) * np.exp(-x * 1.4) * np.minimum(1, x / 0.006)
        i = int(t0 * sr)
        if i < n:
            music[i:i + len(sig)] += amp * sig[: n - i]

    hz = lambda m: 440 * 2 ** ((m - 69) / 12)  # noqa: E731
    chords = [(57, [57, 60, 64]), (53, [57, 60, 65]), (48, [55, 60, 64]), (55, [55, 59, 62])]  # Am F C G
    beat = 60 / 72
    b = 0
    while b * beat < tl["total"]:
        root, ch = chords[(b // 4) % 4]
        if b % 4 == 0:
            note(b * beat, hz(root - 12), 4 * beat, 0.5)
        note(b * beat, hz(ch[b % 3] + 12), 2.5, 0.28)
        if b % 2 == 1:
            note(b * beat + beat / 2, hz(ch[(b + 1) % 3] + 12), 2.0, 0.16)
        b += 1
    d = int(0.42 * sr)
    music[d:] += music[:-d] * 0.3
    music /= np.max(np.abs(music)) + 1e-9

    sfx = np.zeros(n)
    rng = np.random.default_rng(3)
    shot_at = {s["name"]: s for s in tl["shots"]}

    def at(sec, sig):
        i = int(sec * sr)
        if 0 <= i < n:
            sfx[i:i + len(sig)] += sig[: n - i]
    s = shot_at["door_close"]
    x = np.arange(int(0.5 * sr)) / sr
    thud = (np.sin(TAU * 70 * x) * 0.9 + rng.normal(0, 0.3, len(x)) * np.exp(-x * 30)) * np.exp(-x * 9)
    at(s["t0"] + 0.6 * (s["t1"] - s["t0"]), 0.8 * thud)
    s = shot_at["perk"]
    for k in range(7):  # keys jingling
        x = np.arange(int(0.25 * sr)) / sr
        sig = sum(np.sin(TAU * f * x) for f in rng.uniform(2500, 6500, 4)) * np.exp(-x * 25) / 4
        at(s["t0"] - 0.25 + k * 0.09 + rng.uniform(0, 0.03), 0.35 * sig)
    s = shot_at["enter"]
    x = np.arange(int(0.4 * sr)) / sr
    at(s["t0"] + 0.05, 0.25 * np.sin(TAU * (180 + 60 * x) * x) * np.exp(-x * 6))

    tt = np.arange(n) / sr
    fade = np.clip(tt / 0.5, 0, 1) * np.clip((tl["total"] - tt) / 1.2, 0, 1)
    mix = 0.85 * voice + 0.13 * music * fade + 0.5 * sfx
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
        for text, _ in SEGMENTS:
            n = len(text.split())
            ws = tl["words"][k:k + n]
            f.write(f"{k + 1}\n{ts(ws[0]['t0'])} --> {ts(ws[-1]['t1'])}\n{text}\n\n")
            k += n


# ============================================================================ main
def main():
    global TL
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sheet", action="store_true", help="write out/sheet.png with a frame from every shot")
    ap.add_argument("--still", type=float, help="write out/still.png at this time")
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    ensure_fonts()
    TL = build_timeline()
    nframes = int(round(TL["total"] * FPS))
    print(f"{TL['total']:.1f} s, {len(TL['shots'])} shots, {len(TL['words'])} words", file=sys.stderr)

    if args.still is not None:
        data = render_frame(int(args.still * FPS))
        cairo.ImageSurface.create_for_data(bytearray(data), cairo.FORMAT_ARGB32, W, H).write_to_png(
            os.path.join(OUT, "still.png"))
        return
    if args.sheet:
        tw, th = W // 4, H // 4
        cols = 6
        rows = math.ceil(len(TL["shots"]) / cols)
        img = cairo.ImageSurface(cairo.FORMAT_ARGB32, tw * cols, th * rows)
        c = cairo.Context(img)
        for k, s in enumerate(TL["shots"]):
            mid = (s["t0"] + s["t1"]) / 2
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
    write_srt(TL, os.path.join(OUT, "while-youre-at-work.srt"))
    video = os.path.join(OUT, "while-youre-at-work.mp4")
    enc = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                            "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-i", audio, "-c:v", "libx264", "-preset", "medium", "-crf", "19",
                            "-pix_fmt", "yuv420p", "-profile:v", "high", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "192k",
                            "-shortest", "-movflags", "+faststart", video], stdin=subprocess.PIPE)
    with Pool(args.workers) as pool:  # workers fork after TL is built
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
