#!/usr/bin/env python3
"""Why Do Cats Make Biscuits? -- a fully procedural explainer video.

Everything (the cartoon cat, backgrounds, captions, and the music bed) is
generated in code, so there are no third-party assets to license.

    pip install pycairo numpy          # FFmpeg must also be installed
    python3 make_video.py              # -> out/why-cats-make-biscuits.mp4
    python3 make_video.py --preview    # -> out/preview.png (one frame per scene)

Output: 1080x1920 (vertical, for Shorts / Reels / TikTok), 30 fps, H.264 + AAC.
"""
import argparse
import math
import os
import subprocess
import sys
import wave
from multiprocessing import Pool

import cairo
import numpy as np

W, H, FPS = 1080, 1920, 30
FONT = "DejaVu Sans"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
TAU = math.tau


def hexc(h, a=None):
    h = h.lstrip("#")
    rgb = tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return rgb if a is None else rgb + (a,)


OUTLINE = hexc("#4A2E22")
WHITE = (1, 1, 1)
PINK = hexc("#F49AAE")


# --------------------------------------------------------------------------- easing / misc
def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def ease_out(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def ease_out_back(x):
    x = clamp(x)
    c1 = 1.70158
    return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2


def rnd(i, salt=0):
    """Deterministic pseudo-random number in [0, 1) for particle layouts."""
    return (math.sin(i * 12.9898 + salt * 78.233) * 43758.5453) % 1.0


# --------------------------------------------------------------------------- drawing helpers
def set_col(ctx, c):
    if len(c) == 4:
        ctx.set_source_rgba(*c)
    else:
        ctx.set_source_rgb(*c)


def ellipse(ctx, cx, cy, rx, ry, rot=0.0):
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rot)
    ctx.scale(rx, ry)
    ctx.new_sub_path()
    ctx.arc(0, 0, 1, 0, TAU)
    ctx.restore()


def rrect(ctx, x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    ctx.new_sub_path()
    ctx.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    ctx.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    ctx.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    ctx.arc(x + r, y + r, r, math.pi, 1.5 * math.pi)
    ctx.close_path()


def paint(ctx, fill, stroke=OUTLINE, lw=6):
    if fill is not None:
        set_col(ctx, fill)
        if stroke is None:
            ctx.fill()
            return
        ctx.fill_preserve()
    set_col(ctx, stroke)
    ctx.set_line_width(lw)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.stroke()


def heart(ctx, x, y, s):
    ctx.move_to(x, y + s * 0.35)
    ctx.curve_to(x - s * 1.1, y - s * 0.35, x - s * 0.45, y - s * 1.05, x, y - s * 0.45)
    ctx.curve_to(x + s * 0.45, y - s * 1.05, x + s * 1.1, y - s * 0.35, x, y + s * 0.35)
    ctx.close_path()


def font(ctx, size, bold=True):
    ctx.select_font_face(FONT, cairo.FONT_SLANT_NORMAL,
                         cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL)
    ctx.set_font_size(size)


def wrap(ctx, text, max_w):
    lines, cur = [], ""
    for word in text.split():
        trial = (cur + " " + word).strip()
        if ctx.text_extents(trial).x_advance > max_w and cur:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def text_block(ctx, text, cx, top, size, max_w, fill, stroke=None, lw=0, line_h=1.18, bold=True):
    """Centered, word-wrapped text. Returns the bottom y."""
    font(ctx, size, bold)
    y = top + size
    for line in wrap(ctx, text, max_w):
        ext = ctx.text_extents(line)
        x = cx - ext.x_advance / 2
        ctx.move_to(x, y)
        ctx.text_path(line)
        if stroke:
            set_col(ctx, stroke)
            ctx.set_line_width(lw)
            ctx.set_line_join(cairo.LINE_JOIN_ROUND)
            ctx.stroke_preserve()
        set_col(ctx, fill)
        ctx.fill()
        y += size * line_h
    return y - size * line_h + size * 0.3


# --------------------------------------------------------------------------- the cat
TABBY = dict(fur=hexc("#F2A65A"), belly=hexc("#FCE6C9"), stripe=hexc("#C9722F"), blush=True)
WILD = dict(fur=hexc("#8E8070"), belly=hexc("#C9BBA8"), stripe=hexc("#5E5246"), blush=False)
KITTEN = dict(fur=hexc("#B9B4C9"), belly=hexc("#F1EEF7"), stripe=hexc("#8A84A3"), blush=True)


def draw_cat(ctx, cx, cy, s, t, look=TABBY, eyes="happy", freq=1.4, amp=55,
             hat=False, purr=False, knead=True):
    """Front-facing cartoon cat. (cx, cy) is where the paws touch the ground.
    Returns the screen positions of the two paws and how hard each is pressing."""
    phase = TAU * freq * t
    lift_l = max(0.0, math.sin(phase)) * amp if knead else 0
    lift_r = max(0.0, math.sin(phase + math.pi)) * amp if knead else 0
    sway = math.sin(phase) * 7 if knead else 0
    bob = abs(math.sin(phase)) * 6 if knead else 0

    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(s, s)

    # paw shadows / dents in whatever the cat is standing on
    for x, lift in ((-62, lift_l), (62, lift_r)):
        press = 1 - lift / max(amp, 1)
        ellipse(ctx, x, 6, 62 + 10 * press, 14 + 5 * press)
        paint(ctx, (0, 0, 0, 0.10 + 0.12 * press), None)

    # tail
    sw = math.sin(t * 2.3) * 0.25
    ctx.move_to(130, -60)
    ctx.curve_to(260, -40, 300 + 40 * sw, -200, 240 + 90 * sw, -330)
    set_col(ctx, OUTLINE)
    ctx.set_line_width(58)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.stroke_preserve()
    set_col(ctx, look["fur"])
    ctx.set_line_width(46)
    ctx.stroke()

    ctx.translate(sway, 0)
    # body + belly
    ellipse(ctx, 0, -175, 175, 195)
    paint(ctx, look["fur"])
    ellipse(ctx, 0, -160, 98, 135)
    paint(ctx, look["belly"], None)
    for i, y in enumerate((-300, -255)):
        ctx.move_to(-172 + i * 4, y)
        ctx.curve_to(-150, y + 8, -132, y + 2, -120, y + 16)
        ctx.move_to(172 - i * 4, y)
        ctx.curve_to(150, y + 8, 132, y + 2, 120, y + 16)
        paint(ctx, None, look["stripe"], 9)

    # front legs + paws
    for x, lift in ((-62, lift_l), (62, lift_r)):
        py = -24 - lift
        rrect(ctx, x - 38, -250, 76, (py + 6) + 250, 34)
        paint(ctx, look["fur"])
        press = 1 - lift / max(amp, 1)
        ellipse(ctx, x, py, 46 + 4 * press, 30)
        paint(ctx, look["belly"])
        for dx in (-14, 14):
            ctx.move_to(x + dx, py + 10)
            ctx.line_to(x + dx * (1 + 0.25 * press), py + 27)
            paint(ctx, None, OUTLINE, 4)

    # head
    ctx.translate(0, -bob)
    hx, hy = 0, -420
    for side in (-1, 1):
        ctx.move_to(hx + side * 150, hy - 20)
        ctx.line_to(hx + side * 122, hy - 160)
        ctx.line_to(hx + side * 45, hy - 105)
        ctx.close_path()
        paint(ctx, look["fur"])
        ctx.move_to(hx + side * 128, hy - 50)
        ctx.line_to(hx + side * 117, hy - 128)
        ctx.line_to(hx + side * 70, hy - 98)
        ctx.close_path()
        paint(ctx, PINK, None)
    ellipse(ctx, hx, hy, 160, 132)
    paint(ctx, look["fur"])
    ellipse(ctx, hx, hy + 52, 82, 52)
    paint(ctx, look["belly"], None)
    for dx in (-30, 0, 30):
        ctx.move_to(hx + dx, hy - 128)
        ctx.line_to(hx + dx * 0.8, hy - 88)
        paint(ctx, None, look["stripe"], 10)

    # eyes
    blink = (t % 3.4) < 0.13
    for side in (-1, 1):
        ex, ey = hx + side * 60, hy - 10
        if eyes == "happy" or blink:
            ctx.new_sub_path()
            ctx.arc(ex, ey + 8, 22, math.pi * 1.1, math.pi * 1.9)
            paint(ctx, None, OUTLINE, 8)
        else:
            iris = hexc("#F5D33C") if look is WILD else hexc("#6BBF59")
            ellipse(ctx, ex, ey, 26, 32)
            paint(ctx, iris, OUTLINE, 5)
            ellipse(ctx, ex, ey + 2, 10, 24)
            paint(ctx, hexc("#1E1410"), None)
            ellipse(ctx, ex + 7, ey - 11, 6, 6)
            paint(ctx, WHITE, None)
    if look["blush"]:
        for side in (-1, 1):
            ellipse(ctx, hx + side * 100, hy + 32, 26, 15)
            paint(ctx, PINK + (0.55,), None)
    # nose + mouth + whiskers
    ctx.move_to(hx - 15, hy + 30)
    ctx.line_to(hx + 15, hy + 30)
    ctx.line_to(hx, hy + 45)
    ctx.close_path()
    paint(ctx, PINK, OUTLINE, 4)
    ctx.move_to(hx, hy + 45)
    ctx.curve_to(hx, hy + 62, hx - 22, hy + 66, hx - 28, hy + 52)
    ctx.move_to(hx, hy + 45)
    ctx.curve_to(hx, hy + 62, hx + 22, hy + 66, hx + 28, hy + 52)
    paint(ctx, None, OUTLINE, 5)
    for side in (-1, 1):
        for k, dy in enumerate((-10, 6, 22)):
            ctx.move_to(hx + side * 95, hy + 40 + dy * 0.5)
            ctx.line_to(hx + side * 215, hy + 22 + dy * 1.6 + k * 4)
        paint(ctx, None, OUTLINE, 3.5)

    if hat:  # little baker's hat
        ctx.save()
        ctx.translate(hx + 10, hy - 120)
        ctx.rotate(0.12)
        for x, y, r in ((-55, -75, 50), (0, -100, 58), (55, -75, 50)):
            ellipse(ctx, x, y, r, r)
            paint(ctx, WHITE)
        rrect(ctx, -82, -60, 164, 62, 16)
        paint(ctx, WHITE)
        ctx.restore()

    if purr:
        a = 0.35 + 0.35 * (0.5 + 0.5 * math.sin(t * 9))
        for k in range(3):
            r = 200 + k * 34 + (t * 40) % 34
            for side in (-1, 1):
                ctx.new_sub_path()
                base = 0 if side > 0 else math.pi
                ctx.arc(hx, hy + 20, r, base - 0.35, base + 0.35)
                paint(ctx, None, OUTLINE + (a * (1 - k / 3),), 6)
    ctx.restore()
    return lift_l / max(amp, 1), lift_r / max(amp, 1)


def biscuit(ctx, x, y, r, rot):
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ellipse(ctx, 0, 0, r, r)
    paint(ctx, hexc("#E7B566"), OUTLINE, 5)
    ellipse(ctx, 0, 0, r * 0.82, r * 0.82)
    paint(ctx, None, hexc("#C98E3E"), 3)
    for k in range(5):
        a = k * TAU / 5
        ellipse(ctx, math.cos(a) * r * 0.5, math.sin(a) * r * 0.5, r * 0.09, r * 0.09)
        paint(ctx, hexc("#A86B2A"), None)
    ctx.restore()


def floating(ctx, t, n, salt, draw_one, x0=60, x1=W - 60, y_top=560, y_bot=1500, speed=0.07):
    for i in range(n):
        u = (t * speed * (0.7 + rnd(i, salt) * 0.6) + rnd(i, salt + 1)) % 1.0
        x = x0 + (x1 - x0) * rnd(i, salt + 2) + math.sin(t * 1.5 + i) * 18
        y = y_bot - (y_bot - y_top) * u
        alpha = math.sin(u * math.pi)
        draw_one(ctx, x, y, alpha, i)


# --------------------------------------------------------------------------- backgrounds / props
def background(ctx, top, bottom, t, dots=True):
    g = cairo.LinearGradient(0, 0, 0, H)
    g.add_color_stop_rgb(0, *top)
    g.add_color_stop_rgb(1, *bottom)
    ctx.set_source(g)
    ctx.paint()
    if dots:
        for row in range(14):
            for col in range(7):
                x = col * 170 + (85 if row % 2 else 0) + 30
                y = row * 150 + (t * 12) % 150 - 60
                ellipse(ctx, x, y, 9, 9)
                paint(ctx, (1, 1, 1, 0.13), None)


def cushion(ctx, cx, cy, color, w=560):
    ellipse(ctx, cx, cy + 40, w / 2, 70)
    paint(ctx, color)
    ellipse(ctx, cx, cy + 22, w / 2 - 30, 42)
    paint(ctx, (1, 1, 1, 0.18), None)


CAT_Y = 1340


# --------------------------------------------------------------------------- scenes
def sc_hook(ctx, t):
    background(ctx, hexc("#FFD9A8"), hexc("#FFB5A7"), t)
    floating(ctx, t, 9, 1, lambda c, x, y, a, i: (c.push_group(), biscuit(c, x, y, 34 + 14 * rnd(i, 9), t + i),
                                                  c.pop_group_to_source(), c.paint_with_alpha(a)))
    cushion(ctx, W / 2, CAT_Y, hexc("#7FB7E8"))
    draw_cat(ctx, W / 2, CAT_Y, 1.15, t)


def sc_define(ctx, t):
    background(ctx, hexc("#FFF0C9"), hexc("#F7D28C"), t)
    rrect(ctx, 120, CAT_Y - 10, W - 240, 120, 30)  # wooden board
    paint(ctx, hexc("#C8925A"))
    ellipse(ctx, W / 2, CAT_Y + 10, 230, 60)  # dough
    paint(ctx, hexc("#FFF6E6"))
    for k in range(10):  # flour puffs
        u = (t * 0.9 + rnd(k, 3)) % 1.0
        ellipse(ctx, W / 2 + (rnd(k, 4) - 0.5) * 520, CAT_Y - 30 - u * 120, 10 + 12 * u, 10 + 12 * u)
        paint(ctx, (1, 1, 1, 0.6 * (1 - u)), None)
    ll, lr = draw_cat(ctx, W / 2, CAT_Y, 1.1, t, hat=True)
    font(ctx, 44)
    for x, lift, label in ((W / 2 - 150, ll, "PUSH"), (W / 2 + 150, lr, "PUSH")):
        a = clamp(1 - lift * 2.2)
        if a > 0:
            ext = ctx.text_extents(label)
            ctx.move_to(x - ext.x_advance / 2, CAT_Y + 120)
            set_col(ctx, OUTLINE + (a,))
            ctx.show_text(label)


def sc_kitten(ctx, t):
    background(ctx, hexc("#E4D9FF"), hexc("#FFD6E8"), t)
    cx, cy = W / 2 + 40, CAT_Y - 200
    breathe = 1 + 0.025 * math.sin(t * 2.2)
    mom = dict(fur=hexc("#9C93B5"), belly=hexc("#E6E1F2"))
    ellipse(ctx, cx, cy + 140, 420, 50)  # rug
    paint(ctx, hexc("#C3B4E8"), None)
    ctx.move_to(cx + 300, cy + 40)  # tail
    ctx.curve_to(cx + 430, cy + 40, cx + 440, cy - 80, cx + 380, cy - 110)
    paint(ctx, None, OUTLINE, 50)
    ctx.move_to(cx + 300, cy + 40)
    ctx.curve_to(cx + 430, cy + 40, cx + 440, cy - 80, cx + 380, cy - 110)
    paint(ctx, None, mom["fur"], 38)
    ellipse(ctx, cx, cy, 320, 135 * breathe)
    paint(ctx, mom["fur"])
    ellipse(ctx, cx + 10, cy + 55, 230, 70 * breathe)
    paint(ctx, mom["belly"], None)
    hx, hy = cx - 330, cy - 80  # mom's head, eyes closed
    for side in (-1, 1):
        ctx.move_to(hx + side * 95, hy - 30)
        ctx.line_to(hx + side * 80, hy - 140)
        ctx.line_to(hx + side * 20, hy - 95)
        ctx.close_path()
        paint(ctx, mom["fur"])
    ellipse(ctx, hx, hy, 115, 100)
    paint(ctx, mom["fur"])
    for side in (-1, 1):
        ctx.new_sub_path()
        ctx.arc(hx + side * 40, hy - 4, 17, math.pi * 0.1, math.pi * 0.9)
        paint(ctx, None, OUTLINE, 7)
    ctx.move_to(hx - 11, hy + 26)
    ctx.line_to(hx + 11, hy + 26)
    ctx.line_to(hx, hy + 37)
    ctx.close_path()
    paint(ctx, PINK, OUTLINE, 4)
    draw_cat(ctx, cx + 30, cy + 150, 0.48, t, look=KITTEN, freq=1.8, amp=40)

    def hrt(c, x, y, a, i):
        heart(c, x, y, 26 + 10 * rnd(i, 5))
        paint(c, PINK + (a,), None)
    floating(ctx, t, 8, 2, hrt, x0=200, x1=W - 200, y_top=480, y_bot=1000, speed=0.18)


def sc_comfort(ctx, t):
    background(ctx, hexc("#FFE1E1"), hexc("#FFC7B8"), t)

    def hrt(c, x, y, a, i):
        heart(c, x, y, 30 + 16 * rnd(i, 6))
        paint(c, hexc("#F06A86", a * 0.85), None)
    floating(ctx, t, 10, 3, hrt, speed=0.12)
    cushion(ctx, W / 2, CAT_Y, hexc("#F6C453"))
    draw_cat(ctx, W / 2, CAT_Y, 1.1, t, purr=True)
    font(ctx, 58)
    a = 0.5 + 0.5 * math.sin(t * 4)
    for k, (x, y) in enumerate(((180, 760), (850, 700))):
        ctx.move_to(x - 70, y + 12 * math.sin(t * 3 + k))
        set_col(ctx, OUTLINE + (0.35 + 0.5 * a,))
        ctx.show_text("prrr")


def sc_scent(ctx, t):
    background(ctx, hexc("#D7F3E8"), hexc("#B9E2F5"), t)
    cx, cy = W / 2, 1030
    press = max(0.0, math.sin(TAU * 0.9 * t))
    s = 1 - 0.05 * press
    # scent particles drifting out of the pads
    for i in range(36):
        u = (t * 0.35 + rnd(i, 7)) % 1.0
        ang = rnd(i, 8) * TAU
        r = 120 + u * 380
        x, y = cx + math.cos(ang) * r, cy + 40 + math.sin(ang) * r * 0.9
        ellipse(ctx, x, y, 8 + 10 * u, 8 + 10 * u)
        paint(ctx, hexc("#A77BE0", 0.55 * math.sin(u * math.pi)), None)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(s, s)
    ellipse(ctx, 0, 0, 330, 330)
    paint(ctx, TABBY["fur"], OUTLINE, 8)
    glow = 0.35 + 0.5 * press
    pads = [(-170, -95, 50, 64, -0.35), (-62, -175, 50, 66, -0.1), (62, -175, 50, 66, 0.1), (170, -95, 50, 64, 0.35)]
    for x, y, rx, ry, rot in pads:
        ellipse(ctx, x, y, rx + 18, ry + 18, rot)
        paint(ctx, hexc("#C79BFF", glow * 0.6), None)
        ellipse(ctx, x, y, rx, ry, rot)
        paint(ctx, PINK, OUTLINE, 6)
    ctx.translate(0, 60)
    ctx.move_to(-150, 60)
    ctx.curve_to(-160, -20, -80, -70, -40, -40)
    ctx.curve_to(-20, -60, 20, -60, 40, -40)
    ctx.curve_to(80, -70, 160, -20, 150, 60)
    ctx.curve_to(145, 130, 90, 140, 50, 120)
    ctx.curve_to(20, 145, -20, 145, -50, 120)
    ctx.curve_to(-90, 140, -145, 130, -150, 60)
    ctx.close_path()
    ctx.save()
    paint(ctx, PINK, OUTLINE, 6)
    ctx.restore()
    ctx.restore()
    # "mine!" bubbles
    font(ctx, 52)
    for i, (x, y) in enumerate(((190, 690), (860, 760), (230, 1370), (840, 1340))):
        a = clamp(math.sin((t * 0.8 + i * 0.25) * math.pi) * 1.4)
        if a > 0:
            ext = ctx.text_extents("mine!")
            rrect(ctx, x - ext.x_advance / 2 - 24, y - 52, ext.x_advance + 48, 76, 38)
            paint(ctx, (1, 1, 1, 0.9 * a), OUTLINE + (a,), 4)
            ctx.move_to(x - ext.x_advance / 2, y)
            set_col(ctx, hexc("#7A4CC2", a))
            ctx.show_text("mine!")
    font(ctx, 36)
    label = "scent glands"
    ext = ctx.text_extents(label)
    ctx.move_to(cx - ext.x_advance / 2, cy - 330)
    set_col(ctx, OUTLINE)
    ctx.show_text(label)


def grass_blade(ctx, x, base, h, tilt, col):
    tx, ty = x + math.sin(tilt) * h, base - math.cos(tilt) * h
    ctx.move_to(x - 9, base)
    ctx.curve_to(x - 6, base - h * 0.5, (x + tx) / 2, (base + ty) / 2, tx, ty)
    ctx.curve_to((x + tx) / 2 + 6, (base + ty) / 2, x + 6, base - h * 0.5, x + 9, base)
    ctx.close_path()
    paint(ctx, col, None)


def sc_nest(ctx, t):
    background(ctx, hexc("#1F2A55"), hexc("#3C4B7A"), t, dots=False)
    for i in range(40):  # stars
        x, y = rnd(i, 10) * W, rnd(i, 11) * 900
        a = 0.4 + 0.6 * (0.5 + 0.5 * math.sin(t * 3 + i))
        ellipse(ctx, x, y, 3.5, 3.5)
        paint(ctx, (1, 1, 0.9, a), None)
    ellipse(ctx, 860, 640, 80, 80)
    paint(ctx, hexc("#FFF4C2"), None)
    ellipse(ctx, 890, 620, 70, 70)
    paint(ctx, hexc("#2A3664"), None)
    base = CAT_Y + 30
    rrect(ctx, -20, base - 10, W + 40, H - base + 30, 0)
    paint(ctx, hexc("#2E5A3A"), None)
    progress = ease_out(t / 5.0)
    blades = []
    for i in range(48):
        x = 30 + i * 22 + rnd(i, 12) * 10
        h = 150 + rnd(i, 13) * 110
        d = (x - W / 2) / 260
        flat = progress * clamp(1 - abs(d)) if abs(d) < 1 else 0
        tilt = math.sin(t * 1.4 + i * 0.6) * 0.08 + (1 if d >= 0 else -1) * flat * 1.25
        blades.append((x, h * (1 - 0.35 * flat), tilt, abs(d) < 1))
    for x, h, tilt, _ in blades:
        grass_blade(ctx, x, base, h, tilt, hexc("#3F7A4D"))
    ellipse(ctx, W / 2, base + 5, 260 * (0.3 + 0.7 * progress), 40)
    paint(ctx, hexc("#5E8F4A", 0.9), None)
    draw_cat(ctx, W / 2, base, 1.0, t, look=WILD, eyes="open", freq=1.2)
    for x, h, tilt, inner in blades:
        if not inner and (x < W / 2 - 300 or x > W / 2 + 300):
            grass_blade(ctx, x + 11, base + 20, h * 0.8, tilt * 1.2, hexc("#4E9A5E"))


def sc_stretch(ctx, t):
    background(ctx, hexc("#E0F0FF"), hexc("#C9D8FF"), t)
    rrect(ctx, 170, CAT_Y - 10, W - 340, 60, 30)  # yoga mat
    paint(ctx, hexc("#9B7BE0"))
    ll, lr = draw_cat(ctx, W / 2, CAT_Y, 1.1, t, freq=0.8, amp=95)
    for x, lift in ((W / 2 - 300, ll), (W / 2 + 300, lr)):
        a = 0.35 + 0.65 * lift
        set_col(ctx, OUTLINE + (a,))
        ctx.set_line_width(10)
        top, bot = CAT_Y - 260, CAT_Y - 40
        ctx.move_to(x, top)
        ctx.line_to(x, bot)
        ctx.stroke()
        for y, d in ((top, 1), (bot, -1)):
            ctx.move_to(x - 26, y + 30 * d)
            ctx.line_to(x, y)
            ctx.line_to(x + 26, y + 30 * d)
            ctx.stroke()


def sc_tips(ctx, t):
    background(ctx, hexc("#FFF3D6"), hexc("#FFDDB0"), t)
    ellipse(ctx, W / 2 - 230, CAT_Y + 120, 260, 120)  # lap (knees)
    paint(ctx, hexc("#4C6FA8"))
    ellipse(ctx, W / 2 + 230, CAT_Y + 120, 260, 120)
    paint(ctx, hexc("#4C6FA8"))
    rrect(ctx, 110, CAT_Y - 30, W - 220, 130, 50)  # thick blanket
    paint(ctx, hexc("#D9534F"))
    ctx.save()
    rrect(ctx, 110, CAT_Y - 30, W - 220, 130, 50)
    ctx.clip()
    for k in range(9):
        rrect(ctx, 130 + k * 100, CAT_Y - 40, 22, 160, 0)
        paint(ctx, (1, 1, 1, 0.3), None)
    for y in (CAT_Y + 5, CAT_Y + 55):
        rrect(ctx, 100, y, W - 200, 18, 0)
        paint(ctx, (1, 1, 1, 0.3), None)
    ctx.restore()
    draw_cat(ctx, W / 2, CAT_Y - 10, 1.0, t)


def sc_outro(ctx, t):
    background(ctx, hexc("#FFD2DC"), hexc("#FFB0C4"), t)

    def hrt(c, x, y, a, i):
        heart(c, x, y, 22 + 18 * rnd(i, 14))
        paint(c, hexc("#FF5C8A", a * 0.8), None)
    floating(ctx, t, 16, 4, hrt, speed=0.14)
    heart(ctx, W / 2, CAT_Y + 60, 330)  # heart-shaped pillow
    paint(ctx, hexc("#FF7A9C"))
    draw_cat(ctx, W / 2, CAT_Y, 1.1, t, purr=True)


# Narration / caption text lives here so the SRT and the script stay in sync.
SCENES = [
    dict(dur=5.5, fn=sc_hook, title="WHY DO CATS MAKE BISCUITS?",
         caption="Vets aren't 100% sure, but there are a few great theories."),
    dict(dur=6.0, fn=sc_define, title="WHAT IS “MAKING BISCUITS”?",
         caption="It's kneading: pushing the paws in and out, left, right, left, like a baker working dough."),
    dict(dur=7.0, fn=sc_kitten, title="1. KITTEN INSTINCT",
         caption="Nursing kittens knead mom's belly to help the milk flow. Many cats keep the habit for life."),
    dict(dur=6.5, fn=sc_comfort, title="2. COMFORT & HAPPINESS",
         caption="Adult cats seem to link kneading with the safety of kittenhood. That's why it often comes with purring."),
    dict(dur=7.0, fn=sc_scent, title="3. YOU'RE BEING CLAIMED",
         caption="Cats have scent glands in their paw pads. Each push may leave a scent that says: mine."),
    dict(dur=6.5, fn=sc_nest, title="4. MAKING THE BED",
         caption="Another theory: wild ancestors patted down grass to make a soft, safe place to sleep."),
    dict(dur=5.5, fn=sc_stretch, title="5. A GOOD STRETCH",
         caption="Pushing and pulling may also stretch the paws and legs, like mini cat yoga."),
    dict(dur=7.0, fn=sc_tips, title="CLAWS OUT? TRY THIS",
         items=[(True, "Put a thick blanket on your lap"), (True, "Keep their nails trimmed"),
                (False, "Never punish it: it's a sign of trust")]),
    dict(dur=6.5, fn=sc_outro, title="IF YOUR CAT MAKES BISCUITS ON YOU...",
         punch="...IT'S A COMPLIMENT.", caption="Sources: PetMD, Live Science"),
]
TRANS = 0.4
STARTS = []
_acc = 0.0
for _s in SCENES:
    STARTS.append(_acc)
    _acc += _s["dur"]
TOTAL = _acc
NFRAMES = int(round(TOTAL * FPS))


def overlay(ctx, scene, t):
    """Headline, caption card and progress bar."""
    pop = ease_out_back(t / 0.45)
    ctx.save()
    ctx.translate(W / 2, 330)
    ctx.scale(pop, pop)
    ctx.translate(-W / 2, -330)
    bottom = text_block(ctx, scene["title"], W / 2, 190, 82, 940, WHITE, OUTLINE, 16)
    ctx.restore()
    if "punch" in scene:
        p = ease_out_back((t - 2.2) / 0.5)
        if p > 0:
            ctx.save()
            ctx.translate(W / 2, bottom + 70)
            ctx.scale(p, p)
            ctx.rotate(-0.04)
            ctx.translate(-W / 2, -(bottom + 70))
            text_block(ctx, scene["punch"], W / 2, bottom + 10, 92, 980, hexc("#FFE45C"), OUTLINE, 18)
            ctx.restore()

    a = ease_out((t - 0.3) / 0.45)
    if a <= 0:
        return
    dy = (1 - a) * 50
    ctx.push_group()
    if "items" in scene:
        top, row = 1470, 105
        rrect(ctx, 70, top + dy, W - 140, row * len(scene["items"]) + 50, 40)
        paint(ctx, (1, 1, 1, 0.93), OUTLINE, 6)
        for k, (ok, label) in enumerate(scene["items"]):
            ka = ease_out((t - 0.5 - k * 0.6) / 0.4)
            y = top + dy + 40 + k * row + 30
            ix = 140
            ctx.save()
            ctx.push_group()
            ellipse(ctx, ix, y, 30, 30)
            paint(ctx, hexc("#4CAF50") if ok else hexc("#E5484D"), None)
            set_col(ctx, WHITE)
            ctx.set_line_width(8)
            if ok:
                ctx.move_to(ix - 13, y + 1)
                ctx.line_to(ix - 3, y + 12)
                ctx.line_to(ix + 15, y - 11)
            else:
                ctx.move_to(ix - 11, y - 11)
                ctx.line_to(ix + 11, y + 11)
                ctx.move_to(ix + 11, y - 11)
                ctx.line_to(ix - 11, y + 11)
            ctx.stroke()
            font(ctx, 39)
            ctx.move_to(ix + 52, y + 15)
            set_col(ctx, OUTLINE)
            ctx.show_text(label)
            ctx.pop_group_to_source()
            ctx.paint_with_alpha(ka)
            ctx.restore()
    elif scene.get("punch"):
        font(ctx, 38, bold=False)
        ext = ctx.text_extents(scene["caption"])
        ctx.move_to(W / 2 - ext.x_advance / 2, 1810 + dy)
        set_col(ctx, OUTLINE + (0.75,))
        ctx.show_text(scene["caption"])
    else:
        font(ctx, 50)
        lines = wrap(ctx, scene["caption"], 880)
        box_h = len(lines) * 62 + 70
        top = 1500
        rrect(ctx, 70, top + dy, W - 140, box_h, 40)
        paint(ctx, (1, 1, 1, 0.93), OUTLINE, 6)
        text_block(ctx, scene["caption"], W / 2, top + dy + 22, 50, 880, OUTLINE, line_h=1.24)
    ctx.pop_group_to_source()
    ctx.paint_with_alpha(a)


def draw_scene(ctx, idx, t):
    ctx.save()
    SCENES[idx]["fn"](ctx, t)
    overlay(ctx, SCENES[idx], t)
    ctx.restore()


def render_frame(i):
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    ctx = cairo.Context(surf)
    gt = i / FPS
    idx = max(k for k, s in enumerate(STARTS) if s <= gt + 1e-9)
    t = gt - STARTS[idx]
    if idx > 0 and t < TRANS:
        draw_scene(ctx, idx - 1, SCENES[idx - 1]["dur"] + t)
        ctx.push_group()
        draw_scene(ctx, idx, t)
        ctx.pop_group_to_source()
        ctx.paint_with_alpha(ease_out(t / TRANS))
    else:
        draw_scene(ctx, idx, t)
    # progress bar
    rrect(ctx, 60, 70, W - 120, 14, 7)
    paint(ctx, (1, 1, 1, 0.45), None)
    rrect(ctx, 60, 70, max(14, (W - 120) * gt / TOTAL), 14, 7)
    paint(ctx, OUTLINE + (0.8,), None)
    surf.flush()
    return bytes(surf.get_data())


# --------------------------------------------------------------------------- music (original, synthesized)
def make_music(path, seconds, sr=44100):
    n = int(seconds * sr)
    out = np.zeros(n)
    tt = np.arange(n) / sr
    bpm = 92
    beat = 60 / bpm
    chords = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]]  # Fmaj7 Em7 Dm7 Cmaj7

    def hz(m):
        return 440 * 2 ** ((m - 69) / 12)

    def add(start, sig):
        i = int(start * sr)
        if i >= n:
            return
        j = min(n, i + len(sig))
        out[i:j] += sig[: j - i]

    bar = 4 * beat
    nbars = int(seconds / bar) + 1
    for b in range(nbars):
        chord = chords[b % 4]
        t0 = b * bar
        L = int(bar * 1.15 * sr)
        x = np.arange(L) / sr
        env = np.minimum(1, x / 0.35) * np.exp(-x * 0.5)
        for m in chord:  # warm pad
            f = hz(m)
            add(t0, 0.035 * env * (np.sin(TAU * f * x) + 0.4 * np.sin(TAU * f * 1.003 * x)
                                   + 0.15 * np.sin(TAU * 2 * f * x)))
        for k in (0, 2):  # bass
            x2 = np.arange(int(beat * 1.8 * sr)) / sr
            add(t0 + k * beat, 0.16 * np.exp(-x2 * 2.2) * np.minimum(1, x2 / 0.01)
                * np.sin(TAU * hz(chord[0] - 12) * x2))
        pattern = [0, 1, 2, 3, 2, 1, 3, 2]
        for k, p in enumerate(pattern):  # plucky arpeggio (music-box feel)
            if b == 0 and k < 4:
                continue
            x3 = np.arange(int(0.9 * sr)) / sr
            f = hz(chord[p] + 12)
            sig = np.minimum(1, x3 / 0.004) * (np.sin(TAU * f * x3) * np.exp(-x3 * 5)
                                               + 0.25 * np.sin(TAU * 3 * f * x3) * np.exp(-x3 * 11))
            add(t0 + k * beat / 2, 0.075 * sig)
        rng = np.random.default_rng(b)
        for k in range(4):  # soft shaker on the off-beats
            x4 = np.arange(int(0.08 * sr)) / sr
            noise = np.diff(rng.standard_normal(len(x4) + 1))
            add(t0 + (k + 0.5) * beat, 0.012 * noise * np.exp(-x4 * 45))
    # echo
    d = int(0.33 * sr)
    wet = np.zeros(n)
    wet[d:] = out[:-d] * 0.28
    wet[2 * d:] += out[:-2 * d] * 0.1
    out += wet
    # a soft "pop" at each new scene
    for s in STARTS[1:]:
        x5 = np.arange(int(0.12 * sr)) / sr
        f = 500 + 900 * (x5 / 0.12)
        add(s, 0.12 * np.sin(TAU * np.cumsum(f) / sr) * np.exp(-x5 * 30))
    fade_in = np.minimum(1, tt / 0.8)
    fade_out = np.clip((seconds - tt) / 2.0, 0, 1)
    out *= fade_in * fade_out
    out = out / (np.max(np.abs(out)) + 1e-9) * 0.8
    pcm = (out * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


# --------------------------------------------------------------------------- outputs
def srt_time(s):
    ms = int(round(s * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def write_srt(path):
    with open(path, "w") as f:
        for k, (s, sc) in enumerate(zip(STARTS, SCENES), 1):
            body = sc.get("caption", "")
            if "items" in sc:
                body = " / ".join(label for _, label in sc["items"])
            if "punch" in sc:
                body = sc["punch"].title()
            f.write(f"{k}\n{srt_time(s)} --> {srt_time(s + sc['dur'])}\n{sc['title'].title()}\n{body}\n\n")


def frame_to_png(data, path):
    surf = cairo.ImageSurface.create_for_data(bytearray(data), cairo.FORMAT_ARGB32, W, H)
    surf.write_to_png(path)


def preview(path):
    cols = len(SCENES)
    tw, th = W // 4, H // 4
    sheet = cairo.ImageSurface(cairo.FORMAT_ARGB32, tw * cols, th)
    ctx = cairo.Context(sheet)
    for k, s in enumerate(SCENES):
        frame = int((STARTS[k] + min(s["dur"] - 0.3, 3.0)) * FPS)
        img = cairo.ImageSurface.create_for_data(bytearray(render_frame(frame)), cairo.FORMAT_ARGB32, W, H)
        ctx.save()
        ctx.translate(k * tw, 0)
        ctx.scale(0.25, 0.25)
        ctx.set_source_surface(img, 0, 0)
        ctx.paint()
        ctx.restore()
    sheet.write_to_png(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preview", action="store_true", help="only write out/preview.png")
    ap.add_argument("--still", type=float, help="write a single frame at this time (seconds)")
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    args = ap.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)

    if args.preview:
        preview(os.path.join(OUT_DIR, "preview.png"))
        print("wrote out/preview.png")
        return
    if args.still is not None:
        frame_to_png(render_frame(int(args.still * FPS)), os.path.join(OUT_DIR, "still.png"))
        print("wrote out/still.png")
        return

    audio = os.path.join(OUT_DIR, "music.wav")
    make_music(audio, TOTAL)
    write_srt(os.path.join(OUT_DIR, "why-cats-make-biscuits.srt"))
    video = os.path.join(OUT_DIR, "why-cats-make-biscuits.mp4")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgra", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-i", audio,
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
           "-profile:v", "high", "-c:a", "aac", "-b:a", "160k", "-shortest",
           "-movflags", "+faststart", video]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    with Pool(args.workers) as pool:
        for i, data in enumerate(pool.imap(render_frame, range(NFRAMES), chunksize=4)):
            enc.stdin.write(data)
            if i % 150 == 0:
                print(f"frame {i}/{NFRAMES}", file=sys.stderr)
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit("ffmpeg failed")
    print(f"wrote {video} ({TOTAL:.1f} s, {NFRAMES} frames)")


if __name__ == "__main__":
    main()
