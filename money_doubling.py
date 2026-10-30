"""
money_doubling.py -- "$1 that doubles every hour: what can you buy?"

A data-driven Blender scene generator for a ~46 second vertical (1080x1920)
TikTok-style animation. Every hour H the balance is exactly 2**H dollars and a
procedural 3D model of something that balance can afford is animated into the
frame, then morphs out (shrink + spin + sparkle burst) into the next purchase.

Purchases are examples of purchasing power only: nothing is "spent", the money
keeps doubling from the original $1.

Usage
-----
  # Print the purchase / timeline table (works without Blender):
  python3 money_doubling.py --table

  # Build the scene and open it in Blender:
  blender -P money_doubling.py

  # Build + render the full MP4 headless:
  blender -b -P money_doubling.py -- --render --out //money_doubling.mp4

  # Quick low-res preview / single frame / save .blend:
  blender -b -P money_doubling.py -- --preview --render
  blender -b -P money_doubling.py -- --still 700 --out //frame_700.png
  blender -b -P money_doubling.py -- --save //money_doubling.blend

Tested with Blender 5.2 (bpy module). Written to also run on 3.6 / 4.x: every
version-specific API (EEVEE engine id, Principled socket names, layered
actions, compositor node tree, FFmpeg output) goes through a small fallback.
"""

import argparse
import math
import os
import random
import sys
from dataclasses import dataclass

try:
    import bpy
    import bmesh
    from mathutils import Matrix, Vector
except ImportError:  # allow `python3 money_doubling.py --table` without Blender
    bpy = None


# ---------------------------------------------------------------------------
# 1. CONFIG
# ---------------------------------------------------------------------------

FPS = 30
RES_X, RES_Y = 1080, 1920
OUTRO_FRAMES = 45            # end-card hold after hour 24
HUD_DIST = 1.0               # HUD text plane distance in front of the camera
LENS_MM, SENSOR_MM = 30.0, 36.0   # vertical sensor fit -> half-height = 0.6 * dist
HUD_HALF_H = HUD_DIST * (SENSOR_MM / 2) / LENS_MM
HUD_HALF_W = HUD_HALF_H * RES_X / RES_Y
SEED = 24
FONT_PATH = ""               # optional path to a bold .ttf; default Blender font otherwise
# Asset override: drop e.g. assets/private_jet.glb (named after the builder
# without "build_") to replace that procedural model with a licensed asset.
ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


# ---------------------------------------------------------------------------
# 2. PURCHASE TABLE  (the single source of truth for the whole video)
# ---------------------------------------------------------------------------
# Prices are illustrative U.S. estimates (rounded, checked against public
# listings in Oct 2026 where noted in STORYBOARD.md). They are NOT quotes.
#
# columns: hour, item shown on screen, est. price USD, model builder,
#          entrance animation, camera move, stage/environment, frames on screen
PURCHASES = [
    # --- hours 0-9: rapid-fire (0.7 - 1.0 s each) -------------------------
    (0,  "A Lollipop",          0.75,       "build_lollipop",    "pop",        "punch_in",      "table",    21),
    (1,  "A Can of Soda",       1.50,       "build_soda_can",    "drop",       "orbit",         "table",    22),
    (2,  "A Coffee",            3.50,       "build_coffee",      "drop",       "orbit_r",       "table",    23),
    (3,  "A Burger & Fries",    7.50,       "build_burger_fries", "drop",      "orbit",         "table",    24),
    (4,  "A Large Pizza",       15,         "build_pizza",       "flip",       "push_low",      "table",    25),
    (5,  "A Basketball",        30,         "build_basketball",  "drop",       "orbit_r",       "table",    26),
    (6,  "A Skateboard",        60,         "build_skateboard",  "drive_in",   "orbit",         "table",    27),
    (7,  "New Sneakers",        120,        "build_sneakers",    "drop",       "punch_in",      "pedestal", 28),
    (8,  "Wireless Headphones", 250,        "build_headphones",  "pop",        "orbit_r",       "pedestal", 29),
    (9,  "A Game Console",      500,        "build_console",     "rise",       "rise_reveal",   "pedestal", 30),
    # --- hours 10-18: medium reveals (1.6 - 2.2 s each) ---------------------
    (10, "A New Smartphone",    1_000,      "build_smartphone",  "rise",       "rise_reveal",   "pedestal", 48),
    (11, "A Gaming Laptop",     1_800,      "build_laptop",      "spin_in",    "orbit",         "pedestal", 50),
    (12, "An Electric Bike",    4_000,      "build_ebike",       "drive_in",   "tracking",      "pedestal", 52),
    (13, "A Used Car",          8_000,      "build_used_car",    "drive_in",   "tracking",      "road",     55),
    (14, "A Motorcycle",        13_000,     "build_motorcycle",  "speed_pass", "low_speed",     "road",     57),
    (15, "A Brand-New Car",     25_000,     "build_new_car",     "spin_in",    "showroom",      "road",     59),
    (16, "A Speedboat",         60_000,     "build_speedboat",   "speed_pass", "low_speed",     "ocean",    61),
    (17, "A Sports Car",        120_000,    "build_sports_car",  "speed_pass", "low_speed",     "road",     64),
    (18, "A Supercar",          250_000,    "build_supercar",    "slam",       "orbit_r",       "road",     66),
    # --- hours 19-24: dramatic reveals (2.6 - 4.1 s each) -------------------
    (19, "A Family House",      420_000,    "build_house",       "build",      "crane_up",      "lawn",     78),
    (20, "A Mansion",           1_000_000,  "build_mansion",     "build",      "crane_up",      "lawn",     84),
    (21, "A Private Island",    2_000_000,  "build_island",      "emerge",     "aerial_orbit",  "ocean",    90),
    (22, "A Helicopter",        3_500_000,  "build_helicopter",  "descend",    "heli_tilt",     "helipad",  96),
    (23, "A Private Jet",       7_000_000,  "build_private_jet", "fly_by",     "fly_by",        "sky",      104),
    (24, "A Superyacht",        15_000_000, "build_superyacht",  "emerge",     "epic_pullback", "ocean",    124),
]

# World-space size (largest bbox dimension) each model is normalised to.
# Grows with the hour so later purchases physically dominate the frame.
def display_size(hour):
    if hour <= 6:
        return 1.5
    if hour <= 12:
        return 1.7
    if hour <= 18:
        return 2.6
    return {19: 3.4, 20: 4.4, 21: 4.4, 22: 3.4, 23: 4.2, 24: 4.8}[hour]


# Camera moves: list of (fraction of slot, azimuth deg, elevation deg,
# distance multiplier, look-at height multiplier). Azimuth 0 = camera at -Y.
CAMERA_MOVES = {
    "punch_in":      [(0.0, -15, 22, 1.35, 1.0), (0.3, -20, 20, 1.00, 1.0), (1.0, -28, 20, 0.95, 1.0)],
    "orbit":         [(0.0, 20, 18, 1.05, 1.0), (1.0, -15, 22, 1.00, 1.0)],
    "orbit_r":       [(0.0, -30, 22, 1.05, 1.0), (1.0, 10, 18, 1.00, 1.0)],
    "push_low":      [(0.0, 10, 30, 1.25, 0.9), (1.0, -10, 34, 0.95, 1.0)],
    "rise_reveal":   [(0.0, 0, 2, 0.90, 0.6), (0.5, -12, 10, 1.00, 1.0), (1.0, -25, 14, 0.95, 1.0)],
    "tracking":      [(0.0, -55, 10, 1.15, 1.0), (0.45, -5, 12, 1.05, 1.0), (1.0, 30, 14, 1.00, 1.0)],
    "low_speed":     [(0.0, -70, 4, 1.00, 0.8), (0.5, -10, 6, 1.00, 0.9), (1.0, 35, 9, 0.95, 1.0)],
    "showroom":      [(0.0, 40, 15, 1.20, 1.0), (1.0, -35, 18, 1.00, 1.0)],
    "crane_up":      [(0.0, -15, 3, 0.80, 0.8), (0.55, -25, 16, 0.95, 1.0), (1.0, -38, 24, 1.00, 1.0)],
    "aerial_orbit":  [(0.0, 20, 45, 1.20, 1.0), (1.0, -40, 25, 0.95, 1.0)],
    "heli_tilt":     [(0.0, -25, 35, 1.05, 1.4), (1.0, -45, 12, 1.00, 1.0)],
    "fly_by":        [(0.0, -70, 6, 1.00, 1.0), (0.45, -35, 10, 1.00, 1.0), (1.0, 30, 12, 0.95, 1.0)],
    "epic_pullback": [(0.0, -20, 2, 0.65, 0.6), (0.5, 25, 10, 0.90, 1.0), (1.0, 40, 16, 1.00, 1.0)],
}

# Stage -> (world background colour, sun strength)
STAGE_LOOK = {
    "table":    ((0.08, 0.05, 0.12), 0.0),
    "pedestal": ((0.03, 0.02, 0.07), 0.0),
    "road":     ((0.20, 0.12, 0.22), 1.5),
    "ocean":    ((0.40, 0.62, 0.92), 3.5),
    "lawn":     ((0.36, 0.56, 0.88), 3.5),
    "helipad":  ((0.70, 0.40, 0.30), 2.5),
    "sky":      ((0.35, 0.60, 0.95), 3.5),
}


# ---------------------------------------------------------------------------
# 3. TIMELINE DATA STRUCTURE
# ---------------------------------------------------------------------------

def fmt_money(v):
    if isinstance(v, int) or float(v).is_integer():
        return f"${int(v):,}"
    return f"${v:,.2f}"


@dataclass
class HourScene:
    hour: int
    item: str
    price: float
    model_fn: str
    entrance: str
    camera_move: str
    stage: str
    frames: int
    start: int = 0
    end: int = 0

    @property
    def balance(self):
        return 2 ** self.hour

    @property
    def tier(self):
        return "rapid" if self.hour <= 9 else "medium" if self.hour <= 18 else "dramatic"

    @property
    def text(self):
        return {
            "top": f"HOUR {self.hour}",
            "center": fmt_money(self.balance),
            "bottom": f"YOU CAN NOW AFFORD: {self.item.upper()}",
        }

    @property
    def model_generator(self):
        return globals()[self.model_fn]


def build_timeline():
    scenes, frame = [], 1
    for row in PURCHASES:
        sc = HourScene(*row)
        sc.start, sc.end = frame, frame + sc.frames - 1
        frame = sc.end + 1
        assert sc.price <= sc.balance, f"hour {sc.hour}: {sc.item} costs more than {sc.balance}"
        scenes.append(sc)
    assert [s.hour for s in scenes] == list(range(25)), "need exactly hours 0..24"
    return scenes


def total_frames(scenes):
    return scenes[-1].end + OUTRO_FRAMES


def print_table(scenes):
    print(f"{'hr':>2}  {'balance':>12}  {'item':<22} {'est. price':>12}  {'frames':>11}  {'sec':>5}  "
          f"{'entrance':<10} {'camera':<13} stage")
    for s in scenes:
        print(f"{s.hour:>2}  {fmt_money(s.balance):>12}  {s.item:<22} {fmt_money(s.price):>12}  "
              f"{s.start:>4}-{s.end:<5}  {s.frames / FPS:>5.2f}  {s.entrance:<10} {s.camera_move:<13} {s.stage}")
    n = total_frames(scenes)
    print(f"total: {n} frames = {n / FPS:.1f} s @ {FPS} fps (incl. {OUTRO_FRAMES}-frame outro)")


# ---------------------------------------------------------------------------
# 4. MATERIALS
# ---------------------------------------------------------------------------
# name: (base rgb, metallic, roughness, emission strength, coat)
PALETTE = {
    "white":      ((0.85, 0.85, 0.85), 0.0, 0.35, 0, 0),
    "offwhite":   ((0.80, 0.76, 0.68), 0.0, 0.50, 0, 0),
    "black":      ((0.02, 0.02, 0.02), 0.0, 0.40, 0, 0),
    "rubber":     ((0.015, 0.015, 0.015), 0.0, 0.85, 0, 0),
    "steel":      ((0.70, 0.70, 0.72), 1.0, 0.25, 0, 0),
    "chrome":     ((0.90, 0.90, 0.92), 1.0, 0.08, 0, 0),
    "gunmetal":   ((0.10, 0.10, 0.11), 0.9, 0.30, 0, 0),
    "titanium":   ((0.30, 0.29, 0.28), 1.0, 0.30, 0, 0),
    "gold":       ((1.00, 0.70, 0.20), 1.0, 0.18, 0, 0),
    "rosegold":   ((0.90, 0.55, 0.45), 1.0, 0.25, 0, 0),
    "glass":      ((0.01, 0.015, 0.02), 0.0, 0.04, 0, 0),
    "droplet":    ((0.90, 0.90, 0.95), 0.0, 0.02, 0, 1),
    "wood":       ((0.30, 0.15, 0.06), 0.0, 0.50, 0, 0),
    "maple":      ((0.75, 0.55, 0.32), 0.0, 0.50, 0, 0),
    "teak":       ((0.45, 0.25, 0.10), 0.0, 0.60, 0, 0),
    "cardboard":  ((0.60, 0.42, 0.24), 0.0, 0.80, 0, 0),
    "candy_pink": ((0.95, 0.15, 0.45), 0.0, 0.15, 0, 0),
    "soda_red":   ((0.75, 0.02, 0.03), 0.6, 0.25, 0, 0),
    "kraft":      ((0.45, 0.28, 0.14), 0.0, 0.80, 0, 0),
    "bun":        ((0.80, 0.45, 0.15), 0.0, 0.50, 0, 0),
    "patty":      ((0.18, 0.08, 0.04), 0.0, 0.70, 0, 0),
    "cheese":     ((1.00, 0.65, 0.05), 0.0, 0.40, 0, 0),
    "lettuce":    ((0.25, 0.65, 0.10), 0.0, 0.50, 0, 0),
    "tomato":     ((0.85, 0.08, 0.05), 0.0, 0.30, 0, 0),
    "fries":      ((1.00, 0.75, 0.20), 0.0, 0.50, 0, 0),
    "sesame":     ((0.95, 0.88, 0.70), 0.0, 0.50, 0, 0),
    "dough":      ((0.85, 0.65, 0.35), 0.0, 0.70, 0, 0),
    "crust":      ((0.70, 0.40, 0.15), 0.0, 0.60, 0, 0),
    "mozzarella": ((1.00, 0.85, 0.45), 0.0, 0.40, 0, 0),
    "pepperoni":  ((0.60, 0.06, 0.04), 0.0, 0.40, 0, 0),
    "ball_orange": ((0.85, 0.30, 0.05), 0.0, 0.70, 0, 0),
    "teal":       ((0.05, 0.60, 0.60), 0.0, 0.30, 0, 0),
    "red":        ((0.80, 0.03, 0.03), 0.0, 0.30, 0, 0),
    "blue":       ((0.05, 0.20, 0.80), 0.0, 0.30, 0, 0),
    "leather":    ((0.05, 0.04, 0.04), 0.0, 0.60, 0, 0),
    "paint_beige": ((0.55, 0.45, 0.32), 0.3, 0.55, 0, 0),
    "primer":     ((0.40, 0.40, 0.42), 0.0, 0.80, 0, 0),
    "paint_blue": ((0.03, 0.12, 0.45), 0.6, 0.20, 0, 1),
    "paint_red":  ((0.75, 0.01, 0.01), 0.5, 0.18, 0, 1),
    "paint_lime": ((0.85, 0.65, 0.00), 0.5, 0.18, 0, 1),
    "paint_moto": ((0.05, 0.25, 0.70), 0.5, 0.20, 0, 1),
    "carbon":     ((0.02, 0.02, 0.025), 0.3, 0.30, 0, 1),
    "battery":    ((0.10, 0.70, 0.40), 0.4, 0.30, 0, 0),
    "wall":       ((0.85, 0.80, 0.70), 0.0, 0.80, 0, 0),
    "wall_white": ((0.92, 0.90, 0.86), 0.0, 0.70, 0, 0),
    "roof":       ((0.15, 0.13, 0.13), 0.0, 0.70, 0, 0),
    "roof_red":   ((0.45, 0.12, 0.06), 0.0, 0.70, 0, 0),
    "brick":      ((0.45, 0.15, 0.08), 0.0, 0.85, 0, 0),
    "door_red":   ((0.55, 0.05, 0.05), 0.0, 0.40, 0, 0),
    "stone":      ((0.60, 0.58, 0.55), 0.0, 0.80, 0, 0),
    "grass":      ((0.12, 0.40, 0.08), 0.0, 0.90, 0, 0),
    "hedge":      ((0.05, 0.25, 0.05), 0.0, 0.90, 0, 0),
    "bark":       ((0.30, 0.20, 0.12), 0.0, 0.90, 0, 0),
    "frond":      ((0.10, 0.45, 0.10), 0.0, 0.60, 0, 0),
    "sand":       ((0.90, 0.78, 0.55), 0.0, 0.90, 0, 0),
    "asphalt":    ((0.04, 0.04, 0.045), 0.0, 0.70, 0, 0),
    "ground":     ((0.06, 0.06, 0.07), 0.0, 0.90, 0, 0),
    "floor_gloss": ((0.01, 0.01, 0.015), 0.0, 0.12, 0, 0),
    "pedestal":   ((0.02, 0.02, 0.025), 0.2, 0.15, 0, 0),
    "water":      ((0.01, 0.10, 0.22), 0.0, 0.05, 0, 0),
    "navy":       ((0.02, 0.04, 0.12), 0.3, 0.25, 0, 1),
    "hull_white": ((0.92, 0.92, 0.94), 0.0, 0.15, 0, 1),
    "jet_white":  ((0.90, 0.90, 0.92), 0.1, 0.20, 0, 1),
    "heli_black": ((0.015, 0.015, 0.02), 0.6, 0.15, 0, 1),
    "cloud":      ((0.95, 0.95, 1.00), 0.0, 0.90, 0.25, 0),
    # emissive
    "glow_warm":  ((1.00, 0.70, 0.35), 0.0, 0.30, 3.0, 0),
    "glow_white": ((1.00, 1.00, 1.00), 0.0, 0.30, 4.0, 0),
    "glow_red":   ((1.00, 0.05, 0.03), 0.0, 0.30, 4.0, 0),
    "glow_blue":  ((0.10, 0.50, 1.00), 0.0, 0.30, 5.0, 0),
    "glow_cyan":  ((0.20, 0.90, 1.00), 0.0, 0.30, 6.0, 0),
    "glow_gold":  ((1.00, 0.75, 0.25), 0.0, 0.30, 6.0, 0),
    "screen":     ((0.20, 0.10, 0.60), 0.0, 0.10, 2.0, 0),
    "screen_game": ((0.80, 0.25, 0.60), 0.0, 0.10, 2.0, 0),
    "pool":       ((0.05, 0.65, 0.85), 0.0, 0.05, 1.2, 0),
    "lagoon":     ((0.10, 0.80, 0.75), 0.0, 0.05, 0.6, 0),
    "steam":      ((0.90, 0.90, 0.90), 0.0, 0.50, 0.8, 0),
    "sparkle":    ((1.00, 0.80, 0.30), 1.0, 0.20, 8.0, 0),
    "coin":       ((1.00, 0.72, 0.18), 1.0, 0.15, 0.4, 0),
    # HUD
    "hud_white":  ((1.00, 1.00, 1.00), 0.0, 0.50, 1.6, 0),
    "hud_gold":   ((1.00, 0.78, 0.15), 0.0, 0.50, 2.0, 0),
    "hud_green":  ((0.30, 1.00, 0.45), 0.0, 0.50, 1.8, 0),
    "hud_grey":   ((0.75, 0.75, 0.75), 0.0, 0.50, 1.0, 0),
    "hud_red":    ((1.00, 0.20, 0.15), 0.0, 0.50, 2.0, 0),
    "hud_shadow": ((0.00, 0.00, 0.00), 0.0, 1.00, 0.0, 0),
    "hud_plate":  ((0.00, 0.00, 0.00), 0.0, 1.00, 0.0, 0),
}
ALPHA = {"hud_plate": 0.5}
_MATS = {}


def _set_input(node, names, value):
    for n in names:
        if n in node.inputs:
            node.inputs[n].default_value = value
            return


def M(name):
    if name in _MATS:
        return _MATS[name]
    if name.startswith("hue:"):  # procedural RGB key colours, e.g. "hue:0.33"
        h = float(name[4:])
        rgb = hsv_to_rgb(h, 0.9, 1.0)
        spec = (rgb, 0.0, 0.3, 4.0, 0)
    else:
        spec = PALETTE[name]
    rgb, metal, rough, emit, coat = spec
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    mat.diffuse_color = (*rgb, 1)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        _set_input(bsdf, ["Base Color"], (*rgb, 1))
        _set_input(bsdf, ["Metallic"], metal)
        _set_input(bsdf, ["Roughness"], rough)
        if emit:
            _set_input(bsdf, ["Emission Color", "Emission"], (*rgb, 1))
            _set_input(bsdf, ["Emission Strength"], emit)
        if coat:
            _set_input(bsdf, ["Coat Weight", "Clearcoat"], 1.0)
            _set_input(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.05)
        if name in ALPHA:
            _set_input(bsdf, ["Alpha"], ALPHA[name])
            for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
                try:
                    setattr(mat, attr, val)
                    break
                except (AttributeError, TypeError):
                    continue
    _MATS[name] = mat
    return mat


def hsv_to_rgb(h, s, v):
    i = int(h * 6) % 6
    f = h * 6 - int(h * 6)
    p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
    return [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]


# ---------------------------------------------------------------------------
# 5. GEOMETRY TOOLKIT  (all procedural, no external assets)
# ---------------------------------------------------------------------------
_PARENT = [None]  # current parent for builder helpers


def _link(ob):
    bpy.context.collection.objects.link(ob)


def _finish(ob, loc, rot, mat, parent, bevel=0.0, seg=3):
    ob.location = loc
    ob.rotation_euler = [math.radians(a) for a in rot]
    if mat is not None:
        ob.data.materials.append(M(mat) if isinstance(mat, str) else mat)
    if bevel > 0:
        mod = ob.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = seg
        mod.limit_method = "ANGLE"
    ob.parent = parent if parent is not None else _PARENT[0]
    return ob


def _bake(ob, size, twist=0.0):
    """Bake size (and an optional pre-rotation about Z) into the mesh so that
    bevel widths stay in real units and object scale stays 1 for animation."""
    m = Matrix.Diagonal((size[0], size[1], size[2], 1.0))
    if twist:
        m = m @ Matrix.Rotation(math.radians(twist), 4, "Z")
    ob.data.transform(m)


def _smooth(ob, mode):
    for p in ob.data.polygons:
        p.use_smooth = mode == "all" or (mode == "sides" and abs(p.normal.z) < 0.7)


def box(loc, size, mat, rot=(0, 0, 0), bevel=0.0, parent=None, seg=3):
    bpy.ops.mesh.primitive_cube_add(size=1)
    ob = bpy.context.active_object
    _bake(ob, size)
    return _finish(ob, loc, rot, mat, parent, bevel, seg)


def cyl(loc, d, h, mat, rot=(0, 0, 0), verts=32, top=1.0, bevel=0.0, parent=None, twist=0.0):
    """Cylinder / frustum along local Z. d = diameter (or (dx, dy)), h = height,
    top = top radius as a fraction of the bottom radius."""
    dx, dy = (d, d) if not isinstance(d, (tuple, list)) else d
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=0.5, radius2=0.5 * top, depth=1)
    ob = bpy.context.active_object
    _bake(ob, (dx, dy, h), twist)
    _smooth(ob, "sides" if verts > 8 else "none")
    return _finish(ob, loc, rot, mat, parent, bevel)


def ball(loc, size, mat, rot=(0, 0, 0), parent=None, verts=32):
    s = (size, size, size) if not isinstance(size, (tuple, list)) else size
    bpy.ops.mesh.primitive_uv_sphere_add(segments=verts, ring_count=max(8, verts // 2), radius=0.5)
    ob = bpy.context.active_object
    _bake(ob, s)
    _smooth(ob, "all")
    return _finish(ob, loc, rot, mat, parent)


def ring(loc, d, thick, mat, rot=(0, 0, 0), parent=None, verts=48, squash=1.0):
    """Torus: d = centre-line diameter, thick = tube diameter."""
    bpy.ops.mesh.primitive_torus_add(major_radius=d / 2, minor_radius=thick / 2,
                                     major_segments=verts, minor_segments=12)
    ob = bpy.context.active_object
    if squash != 1.0:
        _bake(ob, (1, 1, squash))
    _smooth(ob, "all")
    return _finish(ob, loc, rot, mat, parent)


def tube(points, radius, mat, parent=None, smooth=True, res=10):
    """A swept tube along a polyline (NURBS when smooth) - handles, rails, frames."""
    cu = bpy.data.curves.new("tube", "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = 3
    cu.use_fill_caps = True
    cu.resolution_u = res
    sp = cu.splines.new("NURBS" if smooth and len(points) > 2 else "POLY")
    sp.points.add(len(points) - 1)
    for p, co in zip(sp.points, points):
        p.co = (co[0], co[1], co[2], 1.0)
    if sp.type == "NURBS":
        sp.order_u = min(4, len(points))
        sp.use_endpoint_u = True
    ob = bpy.data.objects.new("tube", cu)
    _link(ob)
    return _finish(ob, (0, 0, 0), (0, 0, 0), mat, parent)


def extrude(points, depth, mat, plane="XZ", offset=0.0, bevel=0.0, parent=None, name="prism"):
    """Extrude a 2D polygon. plane 'XZ' -> along Y, 'YZ' -> along X, 'XY' -> along Z
    (for 'XY', offset is the bottom z; otherwise it is the centre of the extrusion)."""
    def to3(u, v, w):
        if plane == "XZ":
            return (u, w, v)
        if plane == "YZ":
            return (w, u, v)
        return (u, v, w)
    w0, w1 = (offset - depth / 2, offset + depth / 2) if plane != "XY" else (offset, offset + depth)
    bm = bmesh.new()
    a = [bm.verts.new(to3(u, v, w0)) for u, v in points]
    b = [bm.verts.new(to3(u, v, w1)) for u, v in points]
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    n = len(points)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    _link(ob)
    return _finish(ob, (0, 0, 0), (0, 0, 0), mat, parent, bevel)


def hull(L, B, keel, deck, mat, sheer=0.25, bow_start=0.55, sections=32, parent=None):
    """Lofted V-hull along +X (bow at +X). Waterline is z = 0."""
    bm = bmesh.new()
    rows = []
    for i in range(sections + 1):
        t = i / sections
        x = -L / 2 + t * L
        taper = 1.0 if t < bow_start else math.sqrt(max(0.0, 1 - ((t - bow_start) / (1 - bow_start)) ** 2))
        b = B / 2 * max(taper, 0.02)
        zd = deck + sheer * t * t
        zk = keel + (deck * 0.6 - keel) * max(0.0, (t - 0.72) / 0.28) ** 2
        zc = zk + (zd - zk) * 0.35
        sec = [(-b, zd), (-b * 0.92, zc), (0, zk), (b * 0.92, zc), (b, zd)]
        rows.append([bm.verts.new((x, y, z)) for y, z in sec])
    for i in range(sections):
        for j in range(4):
            bm.faces.new((rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]))
    bm.faces.new(rows[0])  # transom
    bm.faces.new([r[0] for r in rows] + [r[4] for r in reversed(rows)])  # deck
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("hull")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new("hull", me)
    _link(ob)
    return _finish(ob, (0, 0, 0), (0, 0, 0), mat, parent)


def empty(name, loc=(0, 0, 0), parent=None, rot=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 0.3
    _link(ob)
    ob.location = loc
    ob.rotation_euler = [math.radians(a) for a in rot]
    ob.parent = parent if parent is not None else _PARENT[0]
    return ob


class group:
    """`with group(empty): ...` - parent everything built inside to `empty`."""
    def __init__(self, ob):
        self.ob = ob

    def __enter__(self):
        self.prev = _PARENT[0]
        _PARENT[0] = self.ob
        return self.ob

    def __exit__(self, *a):
        _PARENT[0] = self.prev


def seg_rot_y(p0, p1):
    """Y rotation (deg) that aligns a box's local X axis with the XZ segment p0->p1."""
    return -math.degrees(math.atan2(p1[1] - p0[1], p1[0] - p0[0]))


def text_obj(body, size, mat, loc=(0, 0, 0), rot=(0, 0, 0), parent=None, extrude_=0.0, bold=0.0):
    cu = bpy.data.curves.new("txt", "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = extrude_
    cu.offset = bold
    if FONT_PATH and os.path.exists(FONT_PATH):
        cu.font = bpy.data.fonts.load(FONT_PATH, check_existing=True)
    ob = bpy.data.objects.new("txt", cu)
    _link(ob)
    return _finish(ob, loc, rot, mat, parent)


# --- reusable sub-assemblies ------------------------------------------------

def wheel(center, radius, width, tire="rubber", rim="steel", spokes=5, outward=1, parent=None):
    """Car-style wheel whose hub empty spins about Y (role='wheel')."""
    hub = empty("wheel", center, parent)
    hub["role"] = "wheel"
    hub["radius"] = radius
    with group(hub):
        cyl((0, 0, 0), radius * 2, width, tire, rot=(90, 0, 0), bevel=radius * 0.18)
        cyl((0, 0, 0), radius * 1.3, width + 0.02, rim, rot=(90, 0, 0))
        yo = outward * (width / 2 + 0.012)
        for k in range(spokes):
            a = k * 360 / spokes
            r = radius * 0.32
            box((r * math.cos(math.radians(a)), yo, r * math.sin(math.radians(a))),
                (radius * 0.55, 0.02, radius * 0.12), "chrome", rot=(0, -a, 0))
        cyl((0, yo, 0), radius * 0.25, 0.03, "chrome", rot=(90, 0, 0))
    return hub


def spoke_wheel(center, radius, parent=None):
    """Bicycle wheel (role='wheel')."""
    hub = empty("wheel", center, parent)
    hub["role"] = "wheel"
    hub["radius"] = radius
    with group(hub):
        ring((0, 0, 0), radius * 2 - 0.07, 0.07, "rubber", rot=(90, 0, 0))
        ring((0, 0, 0), radius * 2 - 0.16, 0.035, "steel", rot=(90, 0, 0))
        cyl((0, 0, 0), 0.09, 0.12, "steel", rot=(90, 0, 0))
        for k in range(16):
            a = math.radians(k * 22.5)
            side = 0.05 if k % 2 else -0.05
            tube([(0, side, 0), (math.cos(a) * (radius - 0.08), 0, math.sin(a) * (radius - 0.08))],
                 0.006, "chrome", smooth=False)
    return hub


def palm(x, y, h, z0=0.0):
    tube([(x, y, z0), (x + 0.15 * h, y, z0 + h * 0.5), (x + 0.35 * h, y + 0.05 * h, z0 + h)],
         0.05 * h + 0.04, "bark")
    top = (x + 0.35 * h, y + 0.05 * h, z0 + h)
    for k in range(7):
        a = k * 360 / 7 + 10
        ar = math.radians(a)
        ball((top[0] + math.cos(ar) * 0.45 * h, top[1] + math.sin(ar) * 0.45 * h, top[2] - 0.08 * h),
             (0.95 * h, 0.2 * h, 0.03 * h), "frond", rot=(0, 22, a))
    for k in range(3):
        ball((top[0] + 0.06 * h * math.cos(k * 2.1), top[1] + 0.06 * h * math.sin(k * 2.1), top[2] - 0.06 * h),
             0.09 * h, "bark")


def tree(x, y, h):
    cyl((x, y, h * 0.3), h * 0.1, h * 0.6, "bark")
    ball((x, y, h * 0.75), (h * 0.6, h * 0.6, h * 0.7), "hedge")


def hip_roof(cx, cy, z0, w, d, h, mat="roof", top=0.35):
    # 4-sided frustum: twist 45 so the square base is axis-aligned, then scale.
    cyl((cx, cy, z0 + h / 2), (w * math.sqrt(2), d * math.sqrt(2)), h, mat, verts=4, top=top, twist=45)


def window(x, y, z, w, h, face=-1, glow="glow_warm", frame="wall_white"):
    """Window on a wall whose outward normal is `face` * Y."""
    box((x, y + face * 0.02, z), (w + 0.15, 0.06, h + 0.15), frame)
    box((x, y + face * 0.055, z), (w, 0.02, h), glow)
    box((x, y + face * 0.07, z), (0.04, 0.02, h), frame)


# ---------------------------------------------------------------------------
# 6. PRODUCT MODEL BUILDERS
# ---------------------------------------------------------------------------
# Each builder models in "natural" units around the origin with its front
# facing -Y (vehicles face +X). The pipeline then normalises the model to
# display_size(hour). Return meta: yaw (deg), waterline (keep z), spin (deg).

def build_lollipop():
    tube([(0, 0, 0), (0, 0, 1.55)], 0.04, "white", smooth=False)
    cyl((0, 0, 1.95), 1.0, 0.22, "candy_pink", rot=(90, 0, 0), bevel=0.09)
    for side in (-1, 1):
        pts = []
        turns = 3.0
        for i in range(60):
            t = i / 59 * turns * 2 * math.pi
            r = 0.04 + 0.4 * t / (turns * 2 * math.pi)
            pts.append((r * math.cos(t) * side, side * 0.112, 1.95 + r * math.sin(t)))
        tube(pts, 0.03, "white")
    tube([(-0.07, 0, 1.45), (0.0, 0, 1.5), (0.07, 0, 1.45)], 0.02, "glow_gold", smooth=False)
    return {"spin": 40}


def build_soda_can():
    cyl((0, 0, 0.62), 0.66, 1.1, "soda_red", bevel=0.02)
    cyl((0, 0, 1.2), 0.66, 0.06, "steel", top=0.88)
    cyl((0, 0, 0.04), 0.58, 0.08, "steel", top=1.12)
    ring((0, 0, 1.23), 0.56, 0.035, "steel")
    cyl((0, 0, 1.235), 0.54, 0.01, "steel")
    box((0.08, 0, 1.25), (0.18, 0.1, 0.015), "chrome", bevel=0.01)
    for z, hgt in ((0.62, 0.13), (0.5, 0.04)):
        cyl((0, 0, z), 0.667, hgt, "white")
    rnd = random.Random(3)
    for _ in range(14):  # condensation droplets
        a = rnd.uniform(-2.4, -0.6)
        z = rnd.uniform(0.15, 1.1)
        ball((0.335 * math.cos(a), 0.335 * math.sin(a), z), rnd.uniform(0.025, 0.05), "droplet", verts=12)
    return {"spin": 40}


def build_coffee():
    cyl((0, 0, 0.7), 0.9, 1.4, "white", top=1.28)
    cyl((0, 0, 0.66), 1.02, 0.5, "kraft", top=1.1)
    cyl((0, 0, 1.43), 1.24, 0.08, "white", bevel=0.03)
    cyl((0, 0, 1.51), 1.12, 0.1, "white", top=0.85)
    box((0.3, -0.12, 1.565), (0.16, 0.05, 0.012), "black")
    for k, x in enumerate((-0.18, 0.05, 0.25)):
        pts = [(x + 0.07 * math.sin(i * 1.3 + k), -0.05 * k, 1.65 + i * 0.16) for i in range(6)]
        tube(pts, 0.03 - 0.004 * k, "steam")
    return {"spin": 40}


def build_burger_fries():
    bx = -0.7
    cyl((bx, 0, 0.15), 1.7, 0.3, "bun", bevel=0.1)
    cyl((bx, 0, 0.4), 1.82, 0.24, "patty", bevel=0.08)
    box((bx, 0, 0.545), (1.42, 1.42, 0.05), "cheese", rot=(0, 0, 45))
    cyl((bx, 0, 0.6), 1.86, 0.05, "lettuce", verts=12)
    ring((bx, 0, 0.6), 1.7, 0.12, "lettuce", squash=0.6)
    cyl((bx, 0, 0.68), 1.5, 0.1, "tomato")
    ball((bx, 0, 0.72), (1.8, 1.8, 1.1), "bun")
    rnd = random.Random(5)
    for _ in range(22):
        a = rnd.uniform(0, 2 * math.pi)
        el = math.radians(rnd.uniform(25, 75))
        ball((bx + 0.9 * math.cos(el) * math.cos(a), 0.9 * math.cos(el) * math.sin(a), 0.72 + 0.55 * math.sin(el)),
             (0.08, 0.04, 0.03), "sesame", rot=(0, -math.degrees(el), math.degrees(a)), verts=8)
    fx = 1.0
    cyl((fx, 0, 0.5), 0.8, 1.0, "red", verts=4, top=1.35, twist=45)
    for i in range(14):
        ox = rnd.uniform(-0.3, 0.3)
        oy = rnd.uniform(-0.2, 0.2)
        box((fx + ox, oy, 1.05 + rnd.uniform(0, 0.25)), (0.09, 0.09, 0.8), "fries",
            rot=(rnd.uniform(-12, 12), rnd.uniform(-12, 12), rnd.uniform(0, 90)))
    ring((fx, -0.4, 0.55), 0.35, 0.05, "fries", rot=(90, 0, 0), verts=24)  # carton emblem
    return {"spin": 30}


def build_pizza():
    box((0, 0, 0.06), (2.6, 2.6, 0.12), "cardboard", bevel=0.01)
    a = math.radians(80)
    box((0, 1.3 + 1.3 * math.cos(a), 0.12 + 1.3 * math.sin(a)), (2.6, 2.6, 0.04), "cardboard", rot=(80, 0, 0))
    cyl((0, 0, 0.15), 2.3, 0.06, "dough")
    cyl((0, 0, 0.18), 2.12, 0.05, "mozzarella")
    ring((0, 0, 0.19), 2.18, 0.17, "crust", verts=64)
    for k in range(4):
        box((0, 0, 0.21), (2.15, 0.015, 0.015), "patty", rot=(0, 0, k * 45))
    rnd = random.Random(8)
    for i in range(11):
        r = 0.25 + 0.6 * ((i * 0.618) % 1)
        t = i * 2.4
        cyl((r * math.cos(t), r * math.sin(t), 0.215), 0.3, 0.03, "pepperoni", bevel=0.01)
    for i in range(6):
        t = i * 1.05 + 0.4
        ball((0.55 * math.cos(t), 0.55 * math.sin(t), 0.225), (0.18, 0.09, 0.02), "lettuce",
             rot=(0, 0, rnd.uniform(0, 180)), verts=12)
    return {"spin": 25}


def build_basketball():
    ball((0, 0, 1), 2.0, "ball_orange", verts=48)
    ring((0, 0, 1), 2.01, 0.03, "black", verts=64)
    ring((0, 0, 1), 2.01, 0.03, "black", rot=(90, 0, 0), verts=64)
    for s in (-1, 1):
        ring((s * 0.6, 0, 1), 1.61, 0.03, "black", rot=(0, 90, 0), verts=64)
    return {"spin": 45}


def build_skateboard():
    top = []
    for i in range(21):
        x = -1.6 + i * 0.16
        z = 0.38 + 0.2 * max(0.0, (abs(x) - 1.15) / 0.45) ** 1.5
        top.append((x, z))
    poly = top + [(x, z - 0.05) for x, z in reversed(top)]
    extrude(poly, 0.8, "maple", bevel=0.02)
    extrude([(x, z + 0.008) for x, z in top] + [(x, z - 0.002) for x, z in reversed(top)], 0.76, "black")
    for x in (-0.95, 0.95):
        box((x, 0, 0.31), (0.25, 0.3, 0.05), "steel", bevel=0.01)
        box((x, 0, 0.24), (0.14, 0.62, 0.08), "steel", bevel=0.02)
        cyl((x, 0, 0.2), 0.04, 0.86, "chrome", rot=(90, 0, 0))
        for y in (-0.38, 0.38):
            hub = empty("wheel", (x, y, 0.12))
            hub["role"], hub["radius"] = "wheel", 0.12
            with group(hub):
                cyl((0, 0, 0), 0.24, 0.12, "teal", rot=(90, 0, 0), bevel=0.03)
    return {"yaw": 0, "spin": 25}


def _sneaker(accent):
    pts = []
    for i in range(32):
        t = i / 32 * 2 * math.pi
        x = math.cos(t)
        y = 0.36 * math.sin(t) * (1 - 0.18 * math.cos(t)) * (1 + 0.1 * math.cos(2 * t))
        pts.append((x, y))
    extrude(pts, 0.22, "white", plane="XY", offset=0.0, bevel=0.05)
    extrude([(x * 1.01, y * 1.03) for x, y in pts], 0.05, accent, plane="XY", offset=0.17)
    cx, cz, rx, rz = -0.15, 0.55, 0.95, 0.375

    def ztop(x):
        return cz + rz * math.sqrt(max(0.0, 1 - ((x - cx) / rx) ** 2))

    def yside(x, z):
        return 0.36 * math.sqrt(max(0.0, 1 - ((x - cx) / rx) ** 2 - ((z - cz) / rz) ** 2))

    ball((cx, 0, cz), (rx * 2, 0.72, rz * 2), "white")
    ball((0.68, 0, 0.33), (0.62, 0.66, 0.4), "white")
    ball((-0.8, 0, 0.45), (0.42, 0.68, 0.6), accent)
    cyl((-0.5, 0, 0.88), (0.6, 0.46), 0.05, "black", rot=(0, -10, 0))
    box((-0.98, 0, 0.82), (0.06, 0.16, 0.22), accent, rot=(0, -15, 0), bevel=0.02)
    box((-0.22, 0, ztop(-0.22) + 0.02), (0.32, 0.26, 0.04), "white", rot=(0, -18, 0), bevel=0.015)
    for x in (0.35, 0.22, 0.09, -0.04, -0.17):
        z = ztop(x) + 0.01
        tube([(x, -0.2, z - 0.06), (x, 0, z + 0.02), (x, 0.2, z - 0.06)], 0.018, "white")
    for s in (-1, 1):
        stripe = []
        for i in range(8):
            x = 0.35 - i * 0.12
            z = 0.32 + 0.22 * math.sin(i / 7 * math.pi * 0.9)
            stripe.append((x, s * (yside(x, z) + 0.006), z))
        tube(stripe, 0.035, accent)


def build_sneakers():
    with group(empty("shoe_a", (0, -0.45, 0), rot=(0, 0, -8))):
        _sneaker("red")
    with group(empty("shoe_b", (0.45, 0.85, 0), rot=(0, 0, 14))):
        _sneaker("red")
    return {"spin": 35}


def build_headphones():
    band = [(1.0 * math.cos(math.radians(a)), 0, 0.55 + 1.05 * math.sin(math.radians(a))) for a in range(0, 181, 15)]
    tube(band, 0.07, "titanium")
    inner = [(0.93 * math.cos(math.radians(a)), 0, 0.55 + 0.97 * math.sin(math.radians(a))) for a in range(40, 141, 10)]
    tube(inner, 0.09, "leather")
    for s in (-1, 1):
        cyl((s * 1.05, 0, 0.5), 0.95, 0.32, "black", rot=(0, 90, 0), bevel=0.08)
        cyl((s * 1.22, 0, 0.5), 0.78, 0.04, "rosegold", rot=(0, 90, 0))
        ring((s * 0.86, 0, 0.5), 0.68, 0.2, "leather", rot=(0, 90, 0))
        box((s * 1.0, 0, 1.0), (0.06, 0.12, 0.42), "chrome", bevel=0.02)
    return {"spin": 40}


def build_console():
    box((0, 0, 1.3), (0.5, 1.9, 2.6), "black", bevel=0.03)
    panel = [(-1.0, 0.05), (0.95, 0.05), (1.08, 1.25), (0.92, 2.78), (-0.92, 2.72), (-1.08, 1.3)]
    for s in (-1, 1):
        extrude(panel, 0.12, "white", plane="YZ", offset=s * 0.31, bevel=0.04)
    box((0, -0.955, 1.35), (0.42, 0.02, 2.3), "glow_blue")
    cyl((0, 0, 0.03), (0.9, 1.4), 0.06, "black")
    # controller in front
    y0 = -1.85
    ball((0, y0, 0.22), (1.2, 0.55, 0.3), "white")
    for s in (-1, 1):
        ball((s * 0.47, y0 - 0.22, 0.2), (0.42, 0.75, 0.3), "white", rot=(0, 0, s * 20))
        cyl((s * 0.22, y0 - 0.12, 0.38), 0.17, 0.1, "black")
    box((0, y0 + 0.08, 0.37), (0.46, 0.24, 0.03), "black", bevel=0.01)
    for (dx, dy), c in zip(((0, 0.08), (0.08, 0), (0, -0.08), (-0.08, 0)), ("glow_cyan", "glow_red", "glow_white", "glow_blue")):
        ball((0.42 + dx, y0 + dy, 0.36), 0.06, c, verts=12)
    box((-0.42, y0, 0.36), (0.18, 0.05, 0.03), "black")
    box((-0.42, y0, 0.36), (0.05, 0.18, 0.03), "black")
    box((0, y0 + 0.26, 0.33), (0.32, 0.03, 0.03), "glow_blue")
    return {"spin": 30}


def build_smartphone():
    box((0, 0, 1.0), (0.95, 0.09, 2.0), "titanium", bevel=0.1, seg=6)
    box((0, -0.046, 1.0), (0.84, 0.004, 1.88), "black")
    box((0, -0.048, 1.0), (0.8, 0.004, 1.84), "screen")
    rnd = random.Random(11)
    for row in range(5):
        for col in range(4):
            box((-0.27 + col * 0.18, -0.052, 1.45 - row * 0.2), (0.12, 0.004, 0.12),
                M(f"hue:{rnd.random():.2f}"), bevel=0.0)
    box((0, -0.051, 0.22), (0.72, 0.004, 0.18), "hud_grey")
    for col in range(4):
        box((-0.27 + col * 0.18, -0.054, 0.22), (0.12, 0.004, 0.12), M(f"hue:{col * 0.22 + 0.05:.2f}"))
    box((0, -0.052, 1.84), (0.22, 0.004, 0.06), "black")
    text_obj("12:00", 0.16, "hud_white", loc=(0, -0.053, 1.65), rot=(90, 0, 0))
    box((0.22, 0.06, 1.6), (0.38, 0.04, 0.48), "titanium", bevel=0.06)
    for (dx, dz) in ((0.12, 0.12), (0.12, -0.1), (-0.06, 0.01)):
        cyl((0.22 + dx * 0.8, 0.09, 1.6 + dz), 0.15, 0.04, "glass", rot=(90, 0, 0))
        ring((0.22 + dx * 0.8, 0.105, 1.6 + dz), 0.15, 0.02, "steel", rot=(90, 0, 0), verts=24)
    for s, z in ((1, 1.45), (-1, 1.55), (-1, 1.3)):
        box((s * 0.48, 0, z), (0.02, 0.05, 0.18), "titanium", bevel=0.008)
    return {"spin": 30}


def build_laptop():
    box((0, 0, 0.05), (2.4, 1.6, 0.1), "gunmetal", bevel=0.03)
    for row in range(5):
        for col in range(14):
            box((-1.0 + col * 0.154, 0.42 - row * 0.15, 0.115), (0.13, 0.12, 0.03),
                M(f"hue:{(col / 14 + row * 0.03) % 1:.2f}"), bevel=0.008)
    box((0, -0.52, 0.102), (0.75, 0.42, 0.006), "titanium")
    a = math.radians(70)
    c = (0, 0.8 + 0.8 * math.cos(a), 0.1 + 0.8 * math.sin(a))
    box(c, (2.4, 1.6, 0.06), "gunmetal", rot=(70, 0, 0), bevel=0.02)
    n = (0, -math.sin(a), math.cos(a))
    box((c[0] + n[0] * 0.032, c[1] + n[1] * 0.032, c[2] + n[2] * 0.032), (2.25, 1.45, 0.005), "screen_game", rot=(70, 0, 0))
    # stylised game on screen: a neon skyline drawn in the lid plane
    up = (0, math.cos(a), math.sin(a))
    for i in range(9):
        h = 0.25 + 0.5 * ((i * 0.37) % 1)
        x = -0.95 + i * 0.235
        v = -0.7 + h / 2
        box((c[0] + x, c[1] + n[1] * 0.036 + up[1] * v, c[2] + n[2] * 0.036 + up[2] * v), (0.18, h, 0.004),
            "glow_cyan" if i % 2 else "glow_blue", rot=(70, 0, 0))
    v = 0.35
    box((c[0] + 0.6, c[1] + n[1] * 0.036 + up[1] * v, c[2] + n[2] * 0.036 + up[2] * v), (0.22, 0.22, 0.004), "glow_gold", rot=(70, 0, 0))
    for s in (-1, 1):
        box((s * 0.9, 0.81, 0.05), (0.4, 0.02, 0.05), "glow_red")
    return {"spin": 25}


def build_ebike():
    R, F = (-0.95, 0, 0.62), (0.95, 0, 0.62)
    spoke_wheel(R, 0.62)
    spoke_wheel(F, 0.62)
    BB, ST, H1, H2 = (-0.1, 0, 0.45), (-0.3, 0, 1.28), (0.68, 0, 1.42), (0.76, 0, 1.12)
    frame = "paint_moto"
    tube([BB, H2], 0.055, frame, smooth=False)
    tube([ST, H1], 0.04, frame, smooth=False)
    tube([BB, ST], 0.04, frame, smooth=False)
    for y in (-0.06, 0.06):
        tube([(BB[0], y, BB[2]), (R[0], y, R[2])], 0.025, frame, smooth=False)
        tube([(ST[0], y, ST[2] - 0.05), (R[0], y, R[2])], 0.022, frame, smooth=False)
        tube([(H2[0], y, H2[2]), (F[0], y, F[2])], 0.03, "steel", smooth=False)
    tube([H1, H2], 0.05, frame, smooth=False)
    mid = ((BB[0] + H2[0]) / 2, 0, (BB[2] + H2[2]) / 2)
    box((mid[0], 0, mid[2] + 0.05), (0.62, 0.15, 0.16), "battery", rot=(0, seg_rot_y((BB[0], BB[2]), (H2[0], H2[2])), 0), bevel=0.03)
    tube([H1, (0.64, 0, 1.6)], 0.03, "steel", smooth=False)
    tube([(0.6, -0.36, 1.63), (0.64, 0, 1.6), (0.6, 0.36, 1.63)], 0.022, "black")
    for s in (-1, 1):
        cyl((0.6, s * 0.36, 1.63), 0.06, 0.14, "rubber", rot=(90, 0, 0))
    tube([ST, (-0.36, 0, 1.42)], 0.025, "steel", smooth=False)
    ball((-0.4, 0, 1.46), (0.5, 0.2, 0.1), "leather")
    cyl(R, 0.26, 0.16, "black", rot=(90, 0, 0))
    ring((BB[0], 0.1, BB[2]), 0.38, 0.03, "steel", rot=(90, 0, 0))
    for s in (-1, 1):
        tube([(BB[0], s * 0.12, BB[2]), (BB[0] + s * 0.15, s * 0.12, BB[2] - s * 0.15)], 0.02, "steel", smooth=False)
    box((0.78, 0, 1.32), (0.1, 0.12, 0.08), "glow_white")
    return {"yaw": 0, "spin": 10}


CAR_STYLES = {
    # body side profile (x, z), window profiles, colours, wheel radius/positions
    "used": dict(
        body=[(-2.3, 0.3), (2.3, 0.3), (2.36, 0.55), (2.28, 0.82), (1.05, 0.95), (0.4, 1.45),
              (-1.0, 1.47), (-1.7, 1.0), (-2.32, 0.95), (-2.38, 0.55)],
        windows=[[(0.98, 0.99), (0.43, 1.39), (-0.22, 1.40), (-0.22, 0.99)],
                 [(-0.34, 0.99), (-0.34, 1.40), (-0.95, 1.41), (-1.58, 1.02)]],
        windshield=((1.05, 0.95), (0.4, 1.45)), rear=((-1.0, 1.47), (-1.7, 1.0)),
        paint="paint_beige", rim="steel", wr=0.33, wx=1.45, width=1.75, spoiler=None),
    "new": dict(
        body=[(-2.3, 0.28), (2.3, 0.28), (2.38, 0.5), (2.25, 0.75), (1.0, 0.92), (0.3, 1.4),
              (-0.9, 1.42), (-1.85, 1.0), (-2.32, 0.93), (-2.4, 0.5)],
        windows=[[(0.95, 0.96), (0.35, 1.35), (-0.25, 1.36), (-0.25, 0.96)],
                 [(-0.37, 0.96), (-0.37, 1.36), (-0.86, 1.37), (-1.7, 1.01)]],
        windshield=((1.0, 0.92), (0.3, 1.4)), rear=((-0.9, 1.42), (-1.85, 1.0)),
        paint="paint_blue", rim="chrome", wr=0.35, wx=1.45, width=1.82, spoiler=None),
    "sports": dict(
        body=[(-2.25, 0.25), (2.25, 0.25), (2.32, 0.45), (2.2, 0.6), (0.75, 0.8), (-0.05, 1.18),
              (-0.8, 1.2), (-2.0, 0.9), (-2.28, 0.85), (-2.34, 0.45)],
        windows=[[(0.68, 0.83), (-0.02, 1.13), (-0.78, 1.15), (-1.35, 0.87)]],
        windshield=((0.75, 0.8), (-0.05, 1.18)), rear=((-0.8, 1.2), (-2.0, 0.9)),
        paint="paint_red", rim="gunmetal", wr=0.35, wx=1.42, width=1.9, spoiler="lip"),
    "super": dict(
        body=[(-2.3, 0.22), (2.3, 0.22), (2.4, 0.35), (2.2, 0.5), (0.6, 0.74), (-0.25, 1.07),
              (-0.95, 1.08), (-2.15, 0.85), (-2.38, 0.75), (-2.4, 0.4)],
        windows=[[(0.55, 0.77), (-0.22, 1.02), (-0.92, 1.03), (-1.3, 0.85)]],
        windshield=((0.6, 0.74), (-0.25, 1.07)), rear=((-0.95, 1.08), (-2.15, 0.85)),
        paint="paint_lime", rim="carbon", wr=0.37, wx=1.45, width=2.0, spoiler="wing"),
}


def build_car(style):
    st = CAR_STYLES[style]
    W = st["width"]
    extrude(st["body"], W, st["paint"], bevel=0.07)
    for win in st["windows"]:
        for s in (-1, 1):
            extrude(win, 0.01, "glass", offset=s * (W / 2 + 0.002))
    for (p0, p1), inset in ((st["windshield"], 0.86), (st["rear"], 0.82)):
        dx, dz = p1[0] - p0[0], p1[1] - p0[1]
        ln = math.hypot(dx, dz)
        nx, nz = dz / ln, -dx / ln
        if p0[0] < p1[0]:
            nx, nz = -nx, -nz
        box(((p0[0] + p1[0]) / 2 + nx * 0.012, 0, (p0[1] + p1[1]) / 2 + nz * 0.012),
            (ln * 0.9, W * inset, 0.02), "glass", rot=(0, seg_rot_y(p0, p1), 0))
    wr, wx = st["wr"], st["wx"]
    for x in (-wx, wx):
        for s in (-1, 1):
            cyl((x, s * (W / 2 + 0.001), wr), wr * 2.35, 0.01, "black", rot=(90, 0, 0))
            wheel((x, s * (W / 2 - 0.08), wr), wr, 0.26, rim=st["rim"], outward=s)
    front = st["body"][2][0]
    rear = st["body"][-1][0]
    for s in (-1, 1):
        box((front - 0.03, s * W * 0.33, 0.6 if style in ("used", "new") else 0.48), (0.08, W * 0.22, 0.1), "glow_white", bevel=0.02)
        box((rear + 0.02, s * W * 0.34, 0.75 if style in ("used", "new") else 0.6), (0.06, W * 0.2, 0.08), "glow_red")
        box((0.0 if style != "sports" else -0.4, s * (W / 2 + 0.01), 0.8), (0.18, 0.03, 0.04), "chrome")
        mx = st["windshield"][0][0] - 0.1
        box((mx, s * (W / 2 + 0.1), st["windshield"][0][1] + 0.05), (0.14, 0.16, 0.09), st["paint"], bevel=0.03)
    box((front, 0, 0.42), (0.06, W * 0.45, 0.16), "black")
    box((rear - 0.01, 0, 0.45), (0.04, 0.5, 0.14), "white")
    if style == "used":  # mismatched replacement door: it's a used car!
        box((0.2, -(W / 2 + 0.004), 0.68), (0.95, 0.01, 0.5), "primer")
    if st["spoiler"] == "lip":
        box((rear + 0.15, 0, 0.9), (0.3, W * 0.85, 0.03), st["paint"], rot=(0, 8, 0))
    if st["spoiler"] == "wing":
        for s in (-1, 1):
            box((rear + 0.35, s * 0.55, 0.98), (0.1, 0.04, 0.3), "carbon")
            box((0.6, s * (W / 2 + 0.01), 0.42), (0.9, 0.02, 0.18), "black", rot=(0, -6, 0))
        box((rear + 0.3, 0, 1.15), (0.45, W * 0.95, 0.04), "carbon", rot=(0, -6, 0))
    return {"yaw": 0, "spin": 12}


def build_used_car():
    return build_car("used")


def build_new_car():
    return build_car("new")


def build_sports_car():
    return build_car("sports")


def build_supercar():
    return build_car("super")


def build_motorcycle():
    wheel((-0.78, 0, 0.33), 0.33, 0.16, rim="gunmetal", spokes=3)
    wheel((0.78, 0, 0.33), 0.33, 0.14, rim="gunmetal", spokes=3)
    for x in (-0.78, 0.78):
        cyl((x, 0.09, 0.33), 0.36, 0.015, "steel", rot=(90, 0, 0))
    extrude([(-0.25, 0.55), (0.85, 0.6), (1.02, 0.85), (0.72, 1.18), (0.3, 1.12), (-0.25, 0.95)], 0.38, "paint_moto", bevel=0.05)
    ball((0.25, 0, 1.1), (0.75, 0.46, 0.34), "paint_moto")
    extrude([(-0.75, 1.0), (-0.1, 1.02), (0.05, 1.1), (-0.2, 1.14), (-0.9, 1.18), (-1.0, 1.1)], 0.3, "leather", bevel=0.04)
    extrude([(-0.75, 0.96), (-1.18, 1.16), (-1.12, 1.22), (-0.6, 1.1)], 0.24, "paint_moto", bevel=0.03)
    box((-1.12, 0, 1.12), (0.04, 0.16, 0.05), "glow_red")
    for s in (-1, 1):
        tube([(0.78, s * 0.09, 0.33), (0.6, s * 0.09, 1.08)], 0.035, "chrome", smooth=False)
        tube([(-0.05, s * 0.1, 0.5), (-0.78, s * 0.1, 0.33)], 0.035, "black", smooth=False)
        box((0.5, s * 0.4, 1.32), (0.04, 0.12, 0.07), "black")
    tube([(0.52, -0.36, 1.2), (0.58, 0, 1.15), (0.52, 0.36, 1.2)], 0.022, "black")
    ball((1.0, 0, 0.82), (0.08, 0.2, 0.12), "glow_white", verts=16)
    box((0.85, 0, 1.18), (0.25, 0.3, 0.02), "glass", rot=(0, -55, 0))
    box((0.1, 0, 0.52), (0.5, 0.34, 0.4), "gunmetal", bevel=0.05)
    tube([(0.25, 0.18, 0.4), (-0.3, 0.22, 0.38), (-0.7, 0.22, 0.6)], 0.05, "chrome")
    cyl((-0.82, 0.22, 0.66), 0.14, 0.4, "chrome", rot=(0, -70, 0))
    return {"yaw": 0, "spin": 10}


def build_speedboat():
    hull(6.0, 2.2, -0.35, 0.6, "hull_white", sheer=0.2)
    for s in (-1, 1):
        box((0.0, s * 1.115, 0.45), (5.0, 0.02, 0.12), "red")
    box((-0.2, 0, 0.75), (2.4, 1.6, 0.3), "white", bevel=0.05)
    box((0.95, 0, 1.08), (0.06, 1.7, 0.45), "glass", rot=(0, -35, 0))
    for y in (-0.4, 0.4):
        box((0.2, y, 1.0), (0.5, 0.5, 0.2), "leather", bevel=0.05)
        box((-0.05, y, 1.25), (0.12, 0.5, 0.45), "leather", bevel=0.04)
    box((-1.6, 0, 0.95), (0.9, 1.7, 0.2), "leather", bevel=0.05)
    for y in (-0.45, 0.45):
        box((-3.15, y, 0.9), (0.4, 0.35, 0.6), "black", bevel=0.06)
        box((-3.25, y, 0.25), (0.15, 0.1, 0.8), "black")
    for s in (-1, 1):
        tube([(1.3, s * 0.9, 0.9), (2.3, s * 0.7, 1.0), (2.9, s * 0.2, 1.05)], 0.02, "chrome")
    return {"yaw": 0, "waterline": True, "spin": 8}


def build_house():
    box((0, 0, 1.3), (6, 4, 2.6), "wall", bevel=0.03)
    extrude([(-2.35, 2.55), (2.35, 2.55), (0, 4.1)], 6.5, "roof", plane="YZ", bevel=0.02)
    box((1.6, 0.6, 3.6), (0.5, 0.5, 1.4), "brick")
    box((4.3, 0.3, 1.1), (2.6, 3.4, 2.2), "wall", bevel=0.03)
    extrude([(-1.9, 2.15), (1.9, 2.15), (0, 3.0)], 2.9, "roof", plane="YZ", offset=4.3)
    box((4.3, -1.42, 0.95), (2.0, 0.05, 1.8), "white")
    for z in (0.5, 0.9, 1.3, 1.7):
        box((4.3, -1.45, z), (2.0, 0.02, 0.03), "stone")
    box((-0.3, -2.02, 1.0), (0.9, 0.06, 2.0), "door_red")
    ball((0.0, -2.07, 1.0), 0.08, "gold")
    box((-0.3, -2.5, 2.25), (1.6, 1.0, 0.1), "roof")
    for x in (-0.95, 0.35):
        cyl((x, -2.9, 1.1), 0.12, 2.2, "white")
    for x in (-2.0, 1.4):
        window(x, -2.0, 1.45, 1.1, 1.0)
    box((-0.3, -3.6, 0.01), (0.9, 2.2, 0.02), "stone")
    for i in range(2):
        box((-0.3, -2.2 - i * 0.3, 0.1 + i * -0.05), (1.2, 0.3, 0.2 - i * 0.1), "stone")
    for x in (-2.6, -1.4, 1.0, 2.0):
        ball((x, -2.35, 0.3), (0.8, 0.6, 0.6), "hedge")
    tree(-4.0, 1.2, 3.2)
    tree(6.4, 1.8, 2.6)
    box((-3.6, -3.4, 0.03), (1.9, 2.7, 0.04), "stone")
    box((-3.6, -3.4, 0.05), (1.6, 2.4, 0.04), "pool")
    for i in range(9):
        x = 1.3 + i * 0.45
        box((x, -4.3, 0.35), (0.08, 0.05, 0.7), "white")
    box((3.1, -4.3, 0.5), (3.7, 0.04, 0.06), "white")
    box((3.1, -4.3, 0.25), (3.7, 0.04, 0.06), "white")
    return {"spin": 12}


def build_mansion():
    box((0, 0, 2.4), (7, 5, 4.8), "wall_white", bevel=0.04)
    hip_roof(0, 0, 4.8, 7.6, 5.6, 1.6, "roof")
    for s in (-1, 1):
        box((s * 6.6, 0.8, 1.8), (6.2, 4.6, 3.6), "wall_white", bevel=0.04)
        hip_roof(s * 6.6, 0.8, 3.6, 6.8, 5.2, 1.3, "roof")
        for x in (-2.0, -0.6, 0.8, 2.2):
            for z in (1.1, 2.7):
                window(s * 6.6 + x, -1.5, z, 0.8, 1.1)
        box((s * 6.6, -1.8, 3.65), (6.4, 0.5, 0.12), "wall_white")
    for x in (-2.9, 2.9):
        for z in (1.4, 3.6):
            window(x, -2.5, z, 0.9, 1.3)
    box((0, -3.2, 0.1), (6.4, 1.8, 0.2), "stone")
    for i in range(3):
        box((0, -4.2 - i * 0.35, 0.1 - i * 0.03), (4.0 + i * 0.6, 0.35, 0.2 - i * 0.06), "stone")
    for x in (-2.5, -1.5, -0.5, 0.5, 1.5, 2.5):
        cyl((x, -3.4, 2.1), 0.38, 3.8, "wall_white", verts=24)
        box((x, -3.4, 0.28), (0.55, 0.55, 0.16), "wall_white")
        box((x, -3.4, 4.0), (0.55, 0.55, 0.16), "wall_white")
    box((0, -3.2, 4.25), (6.6, 1.8, 0.35), "wall_white")
    extrude([(-3.4, 4.42), (3.4, 4.42), (0, 5.5)], 1.8, "wall_white", offset=-3.2)
    box((0, -2.52, 1.3), (1.3, 0.06, 2.4), "wood")
    box((0, -2.53, 2.75), (1.3, 0.05, 0.4), "glow_warm")
    for x in (-1.6, -0.9, 0.9, 1.6):
        window(x, -2.5, 3.6, 0.5, 1.1)
    # fountain + circular drive
    ring((0, -9.0, 0.01), 7.0, 1.8, "stone", squash=0.02, verts=64)
    cyl((0, -9.0, 0.25), 3.0, 0.5, "stone", verts=48)
    cyl((0, -9.0, 0.48), 2.7, 0.05, "pool", verts=48)
    cyl((0, -9.0, 0.9), 0.3, 1.2, "stone")
    cyl((0, -9.0, 1.5), 1.2, 0.2, "stone", top=1.4)
    ball((0, -9.0, 1.8), (0.5, 0.5, 0.7), "pool")
    box((0, -5.6, 0.01), (2.0, 3.0, 0.02), "stone")
    for s in (-1, 1):
        for i in range(4):
            box((s * (4.5 + i * 2.2), -2.6, 0.45), (1.8, 0.7, 0.9), "hedge", bevel=0.1)
        for i in range(3):
            tube([(s * 3.0, -6.0 - i * 2.2, 0), (s * 3.0, -6.0 - i * 2.2, 1.2)], 0.04, "black", smooth=False)
            ball((s * 3.0, -6.0 - i * 2.2, 1.3), 0.25, "glow_warm", verts=12)
        palm(s * 10.5, -5.5, 4.2)
        palm(s * 11.5, -1.0, 3.6)
    box((11.0, -9.5, 0.03), (3.4, 5.4, 0.05), "stone")
    box((11.0, -9.5, 0.06), (3.0, 5.0, 0.05), "pool")
    return {"spin": 10}


def build_island():
    ball((0, 0, -0.6), (9.0, 7.0, 2.0), "sand", verts=48)
    ball((0.2, 0.4, -0.3), (7.0, 5.0, 1.6), "grass", verts=48)
    ring((0, 0, 0.0), 10.4, 2.4, "lagoon", squash=0.01, verts=64)
    box((0.8, 0.9, 0.95), (2.6, 1.8, 0.9), "wall_white", bevel=0.03)
    box((0.8, 0.9, 1.45), (3.1, 2.3, 0.1), "wall_white")
    box((0.8, -0.02, 0.95), (2.4, 0.04, 0.7), "glow_warm")
    box((0.8, -0.8, 0.52), (2.4, 1.2, 0.06), "pool")
    box((-2.3, -4.0, 0.25), (0.8, 3.2, 0.08), "teak")
    for y in (-2.6, -3.6, -4.6, -5.5):
        for x in (-2.65, -1.95):
            cyl((x, y, 0.0), 0.1, 0.6, "teak")
    for (x, y, h) in ((-2.6, 0.8, 2.0), (-1.8, 2.0, 2.4), (2.9, 1.9, 2.2), (3.4, -0.6, 1.8), (-0.8, -1.6, 1.7), (1.4, 2.4, 2.0)):
        palm(x, y, h, z0=0.3)
    for x in (2.2, 2.8):
        box((x, -2.3, 0.42), (0.35, 0.8, 0.06), "white", rot=(12, 0, 0))
    tube([(2.5, -2.9, 0.3), (2.5, -2.9, 1.2)], 0.025, "white", smooth=False)
    cyl((2.5, -2.9, 1.25), 1.0, 0.2, "red", top=0.05, verts=16)
    return {"waterline": True, "spin": 15}


def build_helicopter():
    ball((0, 0, 1.3), (3.6, 1.5, 1.7), "heli_black")
    ball((0.85, 0, 1.45), (1.9, 1.32, 1.25), "glass")
    tube([(-1.3, 0, 1.5), (-4.6, 0, 1.75)], 0.18, "heli_black", smooth=False)
    extrude([(-4.2, 1.6), (-4.8, 1.6), (-5.15, 2.7), (-4.75, 2.7)], 0.08, "heli_black")
    box((-4.2, 0, 1.75), (0.4, 1.4, 0.05), "heli_black")
    box((-0.2, 0, 2.05), (1.6, 0.8, 0.35), "gold", bevel=0.08)
    for s in (-1, 1):
        box((0.0, s * 0.75, 1.15), (2.6, 0.02, 0.07), "gold")
        tube([(-1.3, s * 0.78, 0.05), (1.4, s * 0.78, 0.05), (1.75, s * 0.78, 0.25)], 0.045, "steel")
        for x in (-0.7, 0.7):
            tube([(x, s * 0.78, 0.05), (x * 0.9, s * 0.5, 0.75)], 0.035, "steel", smooth=False)
    cyl((0, 0, 2.35), 0.16, 0.45, "steel")
    rotor = empty("main_rotor", (0, 0, 2.55))
    rotor["role"], rotor["axis"] = "rotor", 2
    with group(rotor):
        cyl((0, 0, 0), 0.4, 0.15, "steel")
        for k in range(4):
            a = math.radians(k * 90)
            box((1.65 * math.cos(a), 1.65 * math.sin(a), 0), (3.3, 0.22, 0.035), "black", rot=(0, 0, k * 90))
    trot = empty("tail_rotor", (-4.75, 0.12, 2.15))
    trot["role"], trot["axis"] = "rotor", 1
    with group(trot):
        for k in range(2):
            box((0, 0, 0), (0.08, 0.02, 0.95), "black", rot=(0, k * 90, 0))
    return {"yaw": 0, "spin": 12}


def build_private_jet():
    cyl((0.5, 0, 0), 1.6, 9.0, "jet_white", rot=(0, 90, 0))
    ball((5.0, 0, 0), (3.6, 1.6, 1.6), "jet_white")
    ball((5.5, 0, 0.32), (1.5, 1.28, 0.7), "glass")
    cyl((-5.5, 0, 0.12), 1.6, 3.0, "jet_white", rot=(0, -90, 0), top=0.25)
    wing = [(1.6, 0.6), (-0.6, 0.6), (-2.6, 5.8), (-1.6, 5.8)]
    for s in (-1, 1):
        extrude([(x, s * y) for x, y in wing], 0.16, "jet_white", plane="XY", offset=-0.5, bevel=0.03)
        extrude([(-1.6, -0.45), (-2.6, -0.45), (-3.0, 0.65), (-2.55, 0.65)], 0.08, "jet_white", offset=s * 5.8)
        extrude([(-6.7, s * 0.05), (-7.6, s * 0.05), (-8.3, s * 2.2), (-7.8, s * 2.2)], 0.1, "jet_white", plane="XY", offset=2.55)
        y = s * 1.38
        cyl((-4.6, y, 0.55), 0.85, 2.2, "jet_white", rot=(0, 90, 0), bevel=0.04)
        ring((-3.5, y, 0.55), 0.78, 0.09, "chrome", rot=(0, 90, 0))
        cyl((-3.49, y, 0.55), 0.7, 0.05, "black", rot=(0, 90, 0))
        cyl((-5.72, y, 0.55), 0.6, 0.06, "black", rot=(0, 90, 0))
        box((-4.6, s * 0.9, 0.48), (1.2, 0.6, 0.14), "jet_white")
        for i in range(6):
            ball((3.2 - i * 0.95, s * 0.79, 0.22), (0.28, 0.04, 0.36), "glass", verts=12)
        box((0.5, s * 0.8, -0.12), (9.0, 0.02, 0.07), "gold")
        ball((-2.55, s * 5.8, -0.42), 0.08, "glow_red" if s < 0 else "glow_white", verts=8)
    extrude([(-5.2, 0.5), (-6.9, 0.5), (-7.8, 2.65), (-7.0, 2.65)], 0.14, "jet_white", bevel=0.02)
    extrude([(-6.0, 0.9), (-6.6, 0.9), (-7.45, 2.4), (-7.2, 2.4)], 0.145, "gold")
    return {"yaw": 0, "spin": 8}


def build_superyacht():
    L, B = 12.0, 2.5
    hull(L, B, -0.5, 0.9, "hull_white", sheer=0.3)
    for s in (-1, 1):
        for i in range(9):
            box((-4.6 + i * 0.85, s * (B / 2 + 0.003), 0.55), (0.55, 0.02, 0.14), "glass")
        box((-0.5, s * (B / 2 + 0.002), 0.12), (10.5, 0.02, 0.06), "gold")
    decks = [
        ([(-5.2, -1.08), (1.8, -1.08), (3.2, -0.6), (3.6, 0), (3.2, 0.6), (1.8, 1.08), (-5.2, 1.08)], 0.9, 0.8),
        ([(-4.2, -0.98), (1.0, -0.98), (2.3, -0.5), (2.6, 0), (2.3, 0.5), (1.0, 0.98), (-4.2, 0.98)], 1.7, 0.7),
        ([(-2.8, -0.82), (0.2, -0.82), (1.3, -0.36), (1.5, 0), (1.3, 0.36), (0.2, 0.82), (-2.8, 0.82)], 2.4, 0.6),
    ]
    for plan, z0, h in decks:
        extrude(plan, h, "hull_white", plane="XY", offset=z0, bevel=0.03)
        extrude([(x * 1.012, y * 1.03) for x, y in plan], h * 0.42, "glass", plane="XY", offset=z0 + h * 0.3)
        extrude([(x * 1.04 + 0.1, y * 1.08) for x, y in plan], 0.06, "hull_white", plane="XY", offset=z0 + h)
    box((-1.2, 0, 3.35), (0.2, 1.3, 0.35), "hull_white", bevel=0.05)
    for y in (-0.4, 0.4):
        ball((-1.2, y, 3.65), 0.32, "white")
    tube([(-1.2, 0, 3.4), (-1.2, 0, 4.2)], 0.03, "steel", smooth=False)
    cyl((4.3, 0, 1.15), 1.5, 0.03, "black", verts=48)
    ring((4.3, 0, 1.17), 1.35, 0.04, "gold", verts=48)
    box((4.3, 0, 1.18), (0.08, 0.6, 0.01), "white")
    for y in (-0.2, 0.2):
        box((4.3, y, 1.18), (0.5, 0.08, 0.01), "white")
    box((-6.35, 0, 0.18), (0.8, 2.2, 0.08), "teak")
    cyl((-4.6, 0, 1.0), 1.0, 0.12, "pool")
    for s in (-1, 1):
        pts = []
        for i in range(14):
            t = 0.04 + i / 13 * 0.88
            x = -L / 2 + t * L
            taper = 1.0 if t < 0.55 else math.sqrt(max(0.0, 1 - ((t - 0.55) / 0.45) ** 2))
            pts.append((x, s * (B / 2 * max(taper, 0.02) - 0.06), 0.9 + 0.3 * t * t + 0.28))
        tube(pts, 0.018, "chrome")
    for i in range(6):
        ball((-5.95 + i * 0.0, (i - 2.5) * 0.36, -0.15), 0.12, "glow_cyan", verts=8)
    return {"yaw": 0, "waterline": True, "spin": 10}


# ---------------------------------------------------------------------------
# 7. KEYFRAME UTILITIES  (works with legacy and layered actions)
# ---------------------------------------------------------------------------

def fcurves_of(idblock):
    ad = idblock.animation_data
    if ad is None or ad.action is None:
        return []
    act = ad.action
    if hasattr(act, "layers") and len(act.layers) and getattr(ad, "action_slot", None):
        out = []
        for layer in act.layers:
            for strip in layer.strips:
                cb = strip.channelbag(ad.action_slot)
                if cb:
                    out.extend(cb.fcurves)
        return out
    return list(getattr(act, "fcurves", []))


def _set_interp(idblock, paths, frame, interp, easing):
    for fc in fcurves_of(idblock):
        if fc.data_path in paths:
            for kp in fc.keyframe_points:
                if abs(kp.co[0] - frame) < 0.5:
                    kp.interpolation = interp
                    if interp not in ("BEZIER", "CONSTANT", "LINEAR"):
                        kp.easing = easing


def key(ob, frame, loc=None, rot=None, scale=None, interp="BEZIER", easing="AUTO"):
    """Insert loc/rot(deg)/scale keys at `frame`; `interp` shapes the curve to the NEXT key."""
    paths = []
    if loc is not None:
        ob.location = loc
        ob.keyframe_insert("location", frame=frame)
        paths.append("location")
    if rot is not None:
        ob.rotation_euler = [math.radians(a) for a in rot]
        ob.keyframe_insert("rotation_euler", frame=frame)
        paths.append("rotation_euler")
    if scale is not None:
        ob.scale = (scale,) * 3 if isinstance(scale, (int, float)) else scale
        ob.keyframe_insert("scale", frame=frame)
        paths.append("scale")
    _set_interp(ob, paths, frame, interp, easing)


def descendants(ob):
    out = []
    for c in ob.children:
        out.append(c)
        out.extend(descendants(c))
    return out


def visible_ranges(ob, ranges, first, last):
    """Keyframe hide_render/hide_viewport so `ob` and all children render only in ranges."""
    for o in [ob] + descendants(ob):
        for prop in ("hide_render", "hide_viewport"):
            if ranges[0][0] > first:
                setattr(o, prop, True)
                o.keyframe_insert(prop, frame=first)
            for a, b in ranges:
                setattr(o, prop, False)
                o.keyframe_insert(prop, frame=a)
                if b < last:
                    setattr(o, prop, True)
                    o.keyframe_insert(prop, frame=b + 1)
            for fc in fcurves_of(o):
                if fc.data_path == prop:
                    for kp in fc.keyframe_points:
                        kp.interpolation = "CONSTANT"


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ---------------------------------------------------------------------------
# 8. SCENE SETUP: render, world, lights, camera rig, HUD
# ---------------------------------------------------------------------------

def setup_render(scene, args, n_frames):
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    if args.engine == "CYCLES":
        scene.render.engine = "CYCLES"
        scene.cycles.samples = args.samples or 64
        scene.cycles.use_denoising = True
    else:
        try:
            scene.eevee.taa_render_samples = args.samples or 64
        except AttributeError:
            pass
    scene.render.resolution_x, scene.render.resolution_y = RES_X, RES_Y
    scene.render.resolution_percentage = 50 if args.preview else 100
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 1, n_frames
    scene.render.use_motion_blur = True
    try:
        scene.render.motion_blur_shutter = 0.5
    except AttributeError:
        pass
    for vt in ("AgX", "Filmic"):
        try:
            scene.view_settings.view_transform = vt
            break
        except TypeError:
            continue
    for look in ("AgX - Punchy", "Punchy"):
        try:
            scene.view_settings.look = look
            break
        except TypeError:
            continue
    setup_glare(scene)


def setup_glare(scene):
    """Bloom-like glow on emissive HUD/sparkles via compositor Glare (optional)."""
    try:
        scene.render.compositor_device = "CPU"  # 4.2+: also works on headless render nodes
    except AttributeError:
        pass
    try:
        if hasattr(scene, "compositing_node_group"):  # Blender 5.x
            ng = bpy.data.node_groups.new("Comp", "CompositorNodeTree")
            scene.compositing_node_group = ng
            ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            rl = ng.nodes.new("CompositorNodeRLayers")
            out = ng.nodes.new("NodeGroupOutput")
        else:
            scene.use_nodes = True
            ng = scene.node_tree
            rl = ng.nodes.get("Render Layers") or ng.nodes.new("CompositorNodeRLayers")
            out = ng.nodes.get("Composite") or ng.nodes.new("CompositorNodeComposite")
        gl = ng.nodes.new("CompositorNodeGlare")
        if "Type" in gl.inputs:  # 5.x: menu socket
            for val in ("Bloom", "Fog Glow"):
                try:
                    gl.inputs["Type"].default_value = val
                    break
                except (TypeError, ValueError):
                    continue
        for attr, val in (("glare_type", "BLOOM"), ("glare_type", "FOG_GLOW")):
            try:
                setattr(gl, attr, val)
                break
            except (TypeError, AttributeError):
                continue
        for name, val in (("Threshold", 1.0), ("Strength", 0.5), ("Size", 0.5)):
            if name in gl.inputs:
                gl.inputs[name].default_value = val
        if hasattr(gl, "threshold"):
            gl.threshold = 1.0
        ng.links.new(rl.outputs["Image"], gl.inputs["Image"])
        ng.links.new(gl.outputs["Image"], out.inputs[0])
    except Exception as e:  # compositor API differs across versions; glow is optional
        print("[money_doubling] glare disabled:", e)


def setup_world(scene, scenes):
    world = bpy.data.worlds.new("World")
    scene.world = world
    try:
        world.use_nodes = True
    except Exception:
        pass
    bg = world.node_tree.nodes.get("Background")
    sock = bg.inputs["Color"]
    prev = None
    for sc in scenes:
        col, _ = STAGE_LOOK[sc.stage]
        if sc.stage != prev:
            if prev is not None:
                sock.keyframe_insert("default_value", frame=sc.start - 6)
            sock.default_value = (*col, 1)
            sock.keyframe_insert("default_value", frame=sc.start)
            prev = sc.stage
    return world


def setup_lights(scene, scenes):
    def area(name, loc, power, size, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy, ld.size, ld.color = power, size, color
        ob = bpy.data.objects.new(name, ld)
        _link(ob)
        ob.location = loc
        d = Vector((0, 0, 1.0)) - Vector(loc)
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        return ob
    area("Key", (-5, -6, 7), 2500, 5)
    area("Rim", (6, 6, 5), 1800, 4, (1.0, 0.85, 0.6))
    area("Fill", (6, -5, 2), 600, 6, (0.7, 0.8, 1.0))
    sd = bpy.data.lights.new("Sun", "SUN")
    sd.angle = math.radians(3)
    sun = bpy.data.objects.new("Sun", sd)
    _link(sun)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    prev = None
    for sc in scenes:
        _, strength = STAGE_LOOK[sc.stage]
        if strength != prev:
            if prev is not None:
                sd.keyframe_insert("energy", frame=sc.start - 6)
            sd.energy = strength
            sd.keyframe_insert("energy", frame=sc.start)
            prev = strength


def setup_camera(scene):
    pivot = empty("CameraPivot", (0, 0, 0.6), parent=None)
    cd = bpy.data.cameras.new("Camera")
    cd.lens = LENS_MM
    cd.sensor_fit = "VERTICAL"
    cd.sensor_height = SENSOR_MM
    cd.clip_start = 0.05
    cd.clip_end = 1000
    cam = bpy.data.objects.new("Camera", cd)
    _link(cam)
    cam.parent = pivot
    con = cam.constraints.new("TRACK_TO")
    con.target = pivot
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"
    scene.camera = cam
    return pivot, cam


def key_camera(pivot, cam, frame, az, el, dist, tz, interp="BEZIER"):
    e = math.radians(el)
    key(pivot, frame, loc=(0, 0, tz), rot=(0, 0, az), interp=interp)
    key(cam, frame, loc=(0, -dist * math.cos(e), dist * math.sin(e)), interp=interp)


def hud_text(parent, body, y, size, mat, max_w, x=0.0):
    """Centered HUD line with drop shadow, auto-shrunk to fit max_w."""
    g = empty("hud_line", (x, y, 0), parent)
    t = text_obj(body, size, mat, parent=g, bold=size * 0.025, extrude_=size * 0.02)
    sh = text_obj(body, size, "hud_shadow", loc=(size * 0.05, -size * 0.05, -0.002), parent=g, bold=size * 0.025)
    bpy.context.view_layer.update()
    w = t.dimensions.x
    if w > max_w:
        g.scale = (max_w / w,) * 3
    return g, t, sh


def build_hud(cam, sc, last_frame, first, label_override=None):
    """TOP: HOUR n / CENTER: $balance / BOTTOM: YOU CAN NOW AFFORD: item."""
    grp = empty(f"HUD_{sc.hour:02d}", (0, 0, -HUD_DIST), parent=cam)
    with group(grp):
        mw = HUD_HALF_W * 1.6
        hud_text(grp, sc.text["top"], 0.465, 0.042, "hud_white", mw)
        _, bal, _ = hud_text(grp, sc.text["center"], 0.385, 0.085, "hud_gold" if sc.hour < 20 else "hud_green", mw)
        if sc.hour > 0 and label_override is None:
            badge, _, _ = hud_text(grp, "×2", 0.47, 0.034, "hud_red", mw, x=HUD_HALF_W * 0.62)
            key(badge, sc.start, scale=0.001, rot=(0, 0, -40), interp="BACK", easing="EASE_OUT")
            key(badge, sc.start + 6, scale=1.0, rot=(0, 0, 0))
        box((0, -0.385, -0.01), (HUD_HALF_W * 1.85, 0.15, 0.001), "hud_plate", bevel=0.0)
        box((0, 0.42, -0.01), (HUD_HALF_W * 1.4, 0.17, 0.001), "hud_plate", bevel=0.0)
        lines = label_override or ("YOU CAN NOW AFFORD:", sc.item.upper(), f"EST. PRICE ~{fmt_money(sc.price)}")
        hud_text(grp, lines[0], -0.335, 0.026, "hud_white", mw)
        hud_text(grp, lines[1], -0.385, 0.05, "hud_gold", mw)
        hud_text(grp, lines[2], -0.43, 0.02, "hud_grey", mw)
    # pop-in
    s0 = sc.start
    key(grp, s0, scale=0.6, interp="BACK", easing="EASE_OUT")
    key(grp, s0 + 5, scale=1.0)
    return grp


# ---------------------------------------------------------------------------
# 9. STAGES / ENVIRONMENTS
# ---------------------------------------------------------------------------

def stage_table():
    cyl((0, 0, -0.06), 3.6, 0.12, "wood", verts=64, bevel=0.03)
    cyl((0, 0, -2.0), 30, 0.1, "floor_gloss", verts=64)


def stage_pedestal():
    cyl((0, 0, -0.25), 2.4, 0.5, "pedestal", verts=64, bevel=0.02)
    ring((0, 0, -0.005), 2.38, 0.03, "glow_cyan", verts=96)
    ring((0, 0, -0.45), 2.6, 0.04, "glow_gold", verts=96)
    cyl((0, 0, -0.55), 40, 0.1, "floor_gloss", verts=64)


def stage_road():
    box((0, 0, -0.03), (80, 4.0, 0.06), "asphalt")
    for i in range(30):
        box((-39 + i * 2.7, 0, 0.002), (1.3, 0.1, 0.01), "white")
    for s in (-1, 1):
        box((0, s * 2.2, 0.05), (80, 0.4, 0.2), "stone")
        box((0, s * 2.15, 0.003), (80, 0.06, 0.01), "white")
    box((0, 0, -0.08), (120, 80, 0.05), "ground")
    for i in range(7):
        x = -12 + i * 4
        tube([(x, 3.0, 0), (x, 3.0, 3.2), (x, 2.4, 3.4)], 0.06, "gunmetal")
        ball((x, 2.3, 3.32), 0.25, "glow_warm", verts=12)


def stage_lawn():
    cyl((0, 0, -0.05), 26, 0.1, "grass", verts=64)
    for i in range(10):
        a = i * 0.63 + 0.3
        tree(9 * math.cos(a) + 1.5, 9 * math.sin(a) + 5, 2.5 + (i % 3) * 0.6)


def stage_helipad():
    cyl((0, 0, -0.1), 3.6, 0.2, "gunmetal", verts=64)
    ring((0, 0, 0.002), 2.6, 0.08, "cheese", squash=0.05, verts=64)
    box((-0.35, 0, 0.003), (0.15, 1.1, 0.01), "white")
    box((0.35, 0, 0.003), (0.15, 1.1, 0.01), "white")
    box((0, 0, 0.003), (0.7, 0.15, 0.01), "white")
    for k in range(16):
        a = k * 2 * math.pi / 16
        ball((1.75 * math.cos(a), 1.75 * math.sin(a), 0.02), 0.07, "glow_gold", verts=8)
    cyl((0, 0, -3.0), (5.0, 5.0), 5.6, "gunmetal", verts=8)


def stage_ocean():
    bpy.ops.mesh.primitive_plane_add(size=80)
    ob = bpy.context.active_object
    _finish(ob, (0, 0, 0), (0, 0, 0), "water", None)
    try:
        mod = ob.modifiers.new("Ocean", "OCEAN")
        mod.geometry_mode = "GENERATE"
        mod.spatial_size = 40
        mod.size = 2.0
        mod.resolution = 7
        try:
            mod.viewport_resolution = 4
        except AttributeError:
            pass
        mod.wave_scale = 0.35
        mod.choppiness = 0.8
        mod.wind_velocity = 12
    except Exception as e:
        print("[money_doubling] ocean modifier unavailable, using flat water:", e)
    return ob


def stage_sky():
    rnd = random.Random(9)
    clouds = []
    for i in range(14):
        c = empty("cloud", (rnd.uniform(-20, 20), rnd.uniform(-6, 25), rnd.uniform(-6, -1.5)))
        with group(c):
            for _ in range(6):
                ball((rnd.uniform(-1.6, 1.6), rnd.uniform(-0.8, 0.8), rnd.uniform(-0.3, 0.4)),
                     (rnd.uniform(1.6, 2.6), rnd.uniform(1.4, 2.0), rnd.uniform(0.9, 1.4)), "cloud", verts=16)
        clouds.append(c)
    return clouds


STAGE_BUILDERS = {
    "table": stage_table, "pedestal": stage_pedestal, "road": stage_road, "lawn": stage_lawn,
    "helipad": stage_helipad, "ocean": stage_ocean, "sky": stage_sky,
}


# ---------------------------------------------------------------------------
# 10. PRODUCT PIPELINE: build -> normalise -> animate
# ---------------------------------------------------------------------------

def use_collection(name):
    coll = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(coll)
    lc = bpy.context.view_layer.layer_collection.children[coll.name]
    bpy.context.view_layer.active_layer_collection = lc
    return coll


def world_bbox(obs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in obs:
        if o.type not in ("MESH", "CURVE", "FONT"):
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def import_asset(model_fn):
    """Use assets/<name>.glb|.gltf|.fbx|.obj instead of the procedural builder if present.
    Assets should face -Y (vehicles: +X); they are auto-scaled and grounded."""
    name = model_fn[len("build_"):]
    importers = {
        ".glb": lambda f: bpy.ops.import_scene.gltf(filepath=f),
        ".gltf": lambda f: bpy.ops.import_scene.gltf(filepath=f),
        ".fbx": lambda f: bpy.ops.import_scene.fbx(filepath=f),
        ".obj": lambda f: bpy.ops.wm.obj_import(filepath=f),
    }
    for ext, imp in importers.items():
        path = os.path.join(ASSET_DIR, name + ext)
        if os.path.exists(path):
            before = set(bpy.data.objects)
            imp(path)
            for o in set(bpy.data.objects) - before:
                if o.parent is None:
                    o.parent = _PARENT[0]
            print(f"[money_doubling] using asset {path}")
            return {"spin": 12, "waterline": name in ("superyacht", "speedboat", "island")}
    return None


def build_product(sc):
    use_collection(f"H{sc.hour:02d}_{sc.model_fn[6:]}")
    root = empty(f"H{sc.hour:02d}_root", parent=None)
    model = empty(f"H{sc.hour:02d}_model", parent=root)
    _PARENT[0] = model
    meta = import_asset(sc.model_fn) or sc.model_generator() or {}
    _PARENT[0] = None
    bpy.context.view_layer.update()
    lo, hi = world_bbox(descendants(model))
    dims = hi - lo
    s = display_size(sc.hour) / max(dims)
    model.scale = (s, s, s)
    cx, cy = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2
    z_off = 0.0 if meta.get("waterline") else -lo.z * s
    model.location = (-cx * s, -cy * s, z_off)
    bpy.context.view_layer.update()
    wlo, whi = world_bbox(descendants(model))
    meta["scale"] = s
    meta["W"] = max(whi.x - wlo.x, whi.y - wlo.y)
    meta["H"] = whi.z - max(wlo.z, 0.0)
    meta["top"] = whi.z
    return root, model, meta


def animate_product(sc, root, model, meta, is_last, end_frame):
    f0 = sc.start
    E = int(clamp(round(sc.frames * (0.45 if sc.entrance == "build" else 0.38)), 7, 46))
    X = 0 if is_last else int(clamp(round(sc.frames * 0.16), 4, 12))
    f1 = end_frame if is_last else sc.end
    fE, fX = f0 + E, f1 - X
    yaw = meta.get("yaw", 0)
    spin = meta.get("spin", 20)
    H = meta["H"]
    rest = (0, 0, 0)
    travel = 0.0
    ent = sc.entrance
    if ent == "pop":
        key(root, f0, loc=rest, rot=(0, 0, yaw - 180), scale=0.001, interp="BACK", easing="EASE_OUT")
    elif ent == "spin_in":
        key(root, f0, loc=(0, 0, H * 0.4), rot=(0, 0, yaw - 540), scale=0.001, interp="EXPO", easing="EASE_OUT")
    elif ent == "drop":
        key(root, f0, loc=(0, 0, H * 2.5 + 1.5), rot=(12, -8, yaw - 120), scale=1.0, interp="BOUNCE", easing="EASE_OUT")
    elif ent == "flip":
        key(root, f0, loc=(0, 0, H * 2.0 + 1.0), rot=(-360, 0, yaw - 90), scale=0.3, interp="BACK", easing="EASE_OUT")
    elif ent == "slam":
        key(root, f0, loc=(0, 0, 8.0), rot=(0, 0, yaw - 30), scale=1.0, interp="EXPO", easing="EASE_IN")
        key(root, fE - 4, loc=rest, rot=(0, 0, yaw), scale=(1.08, 1.08, 0.82), interp="BACK", easing="EASE_OUT")
    elif ent == "rise":
        key(root, f0, loc=(0, 0, -H * 1.1), rot=(0, 0, yaw - 360), scale=1.0, interp="EXPO", easing="EASE_OUT")
    elif ent == "drive_in":
        travel = 9.0 + meta["W"] * 2
        key(root, f0, loc=(-travel, 0, 0), rot=(0, 0, yaw), scale=1.0, interp="BACK", easing="EASE_OUT")
    elif ent == "speed_pass":
        travel = 16.0 + meta["W"] * 2
        key(root, f0, loc=(-travel, 0, 0), rot=(0, -2, yaw), scale=1.0, interp="EXPO", easing="EASE_OUT")
        key(root, f0 + int(E * 0.7), loc=(0.35, 0, 0), rot=(0, 1.5, yaw - 4), scale=1.0)
    elif ent == "build":
        key(root, f0, loc=rest, rot=(0, 0, yaw), scale=1.0)
        animate_build(model, f0, E, meta["scale"])
    elif ent == "emerge":
        key(root, f0, loc=(0, 0, -H * 1.3 - 1), rot=(10, 0, yaw - 25), scale=1.0, interp="EXPO", easing="EASE_OUT")
    elif ent == "descend":
        key(root, f0, loc=(0, 0, H * 3 + 2), rot=(0, 12, yaw + 60), scale=1.0, interp="EXPO", easing="EASE_OUT")
    elif ent == "fly_by":
        key(root, f0, loc=(-10, -12, 2.5), rot=(-30, 0, yaw + 40), scale=1.0, interp="BEZIER")
        key(root, f0 + int(E * 0.55), loc=(-1.5, -2.5, 0.8), rot=(-18, 0, yaw + 25), scale=1.0)
    else:
        raise ValueError(f"unknown entrance {ent!r}")
    key(root, fE, loc=rest, rot=(0, 0, yaw), scale=1.0)

    # hold: slow turntable (+ bob for floating things)
    floaty = ent in ("emerge", "descend", "fly_by")
    if floaty:
        n = max(1, (fX - fE) // 24)
        for i in range(1, n + 1):
            f = fE + int((fX - fE) * i / (n + 1))
            key(root, f, loc=(0, 0, (0.08 if i % 2 else -0.05) * H), rot=(1.5 if i % 2 else -1.5, 0, yaw + spin * i / (n + 1)))
    key(root, fX, loc=rest, rot=(0, 0, yaw + spin), scale=1.0, interp="BACK", easing="EASE_IN")
    if not is_last:  # exit: shrink + spin + lift into the transition burst
        key(root, f1, loc=(0, 0, H * 0.45), rot=(0, 0, yaw + spin + 160), scale=0.001)

    # wheels roll with the entrance distance; rotors spin for the whole slot
    s = meta["scale"]
    for ob in descendants(model):
        role = ob.get("role")
        if role == "wheel" and travel:
            ang = math.degrees(travel / (ob["radius"] * s))
            key(ob, f0, rot=(0, 0, 0), interp="EXPO" if ent == "speed_pass" else "BACK", easing="EASE_OUT")
            key(ob, fE, rot=(0, ang, 0))
        elif role == "rotor":
            ax = int(ob["axis"])
            r0, r1 = [0, 0, 0], [0, 0, 0]
            r1[ax] = 360 * 4.5 * (f1 - f0) / FPS
            key(ob, f0, rot=tuple(r0), interp="LINEAR")
            key(ob, f1, rot=tuple(r1), interp="LINEAR")
    return f1


def animate_build(model, f0, E, s):
    """Mansion/house assemble themselves bottom-up, part by part."""
    parts = list(model.children)
    bpy.context.view_layer.update()

    def zmin(o):
        lo, _ = world_bbox([o] + descendants(o))
        return lo.z if lo.z < 1e8 else o.matrix_world.translation.z
    parts.sort(key=zmin)
    n = len(parts)
    lift = 1.2 / s
    for i, p in enumerate(parts):
        t0 = f0 + int(i / n * E * 0.85)
        base = tuple(p.location)
        if t0 > f0:
            key(p, f0, loc=(base[0], base[1], base[2] + lift), scale=0.001, interp="CONSTANT")
        key(p, t0, loc=(base[0], base[1], base[2] + lift), scale=0.001, interp="BACK", easing="EASE_OUT")
        key(p, t0 + 7, loc=base, scale=1.0)


# ---------------------------------------------------------------------------
# 11. FX: sparkle bursts, flash ring, coin shower, clouds, ocean
# ---------------------------------------------------------------------------

class FX:
    def __init__(self):
        use_collection("FX")
        self.rnd = random.Random(SEED)
        self.sparks = [ball((0, 0, 0), 0.1, "sparkle", verts=8, parent=None) for _ in range(40)]
        for sp in self.sparks:
            key(sp, 1, scale=0.0)
        self.flash = ring((0, 0, 0), 1.0, 0.04, "glow_gold", verts=64, parent=None)
        key(self.flash, 1, scale=0.0)
        self.coins = [cyl((0, 0, 0), 0.32, 0.04, "coin", verts=24, bevel=0.01, parent=None) for _ in range(48)]
        for c in self.coins:
            key(c, 1, scale=0.0)

    def burst(self, frame, center, radius, count, dur=14):
        for sp in self.sparks[:count]:
            d = Vector((self.rnd.uniform(-1, 1), self.rnd.uniform(-1, 1), self.rnd.uniform(-0.3, 1))).normalized()
            size = self.rnd.uniform(0.6, 1.4) * radius * 0.12
            key(sp, frame - 1, scale=0.0, loc=center, interp="CONSTANT")
            key(sp, frame, scale=size, loc=center, interp="EXPO", easing="EASE_OUT")
            key(sp, frame + dur, scale=0.0, loc=tuple(Vector(center) + d * radius * self.rnd.uniform(0.8, 1.4)))
        key(self.flash, frame - 1, scale=0.0, loc=center, rot=(90, 0, 0), interp="CONSTANT")
        key(self.flash, frame, scale=0.2 * radius, loc=center, rot=(90, 0, 0), interp="EXPO", easing="EASE_OUT")
        key(self.flash, frame + 8, scale=2.2 * radius, loc=center, rot=(90, 0, 0), interp="EXPO", easing="EASE_IN")
        key(self.flash, frame + 12, scale=0.0, loc=center, rot=(90, 0, 0))

    def coin_shower(self, f0, width, height, count=48):
        for c in self.coins[:count]:
            t = f0 + self.rnd.randint(0, 24)
            x = self.rnd.uniform(-width, width)
            y = self.rnd.uniform(0.3, 1.5) * width * 0.5
            fall = self.rnd.randint(22, 34)
            key(c, t - 1, scale=0.0, loc=(x, y, height), interp="CONSTANT")
            sc_ = width * 0.2
            key(c, t, scale=sc_, loc=(x, y, height), rot=(0, 0, 0), interp="LINEAR")
            key(c, t + fall, scale=sc_, loc=(x, y, -1.0), rot=(self.rnd.uniform(400, 900), self.rnd.uniform(200, 600), 0), interp="CONSTANT")
            key(c, t + fall + 1, scale=0.0)


def animate_stage(objs, ranges, first, last):
    for ob in objs:
        visible_ranges(ob, ranges, first, last)


# ---------------------------------------------------------------------------
# 12. MAIN BUILD
# ---------------------------------------------------------------------------

def stage_ranges(scenes, last_frame):
    out = {}
    for i, sc in enumerate(scenes):
        end = last_frame if i == len(scenes) - 1 else sc.end
        rs = out.setdefault(sc.stage, [])
        if rs and rs[-1][1] == sc.start - 1:
            rs[-1] = (rs[-1][0], end)
        else:
            rs.append((sc.start, end))
    return out


def build_scene(args):
    random.seed(SEED)
    scenes = build_timeline()
    n_frames = total_frames(scenes)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _MATS.clear()
    scene = bpy.context.scene
    setup_render(scene, args, n_frames)
    setup_world(scene, scenes)
    use_collection("Rig")
    setup_lights(scene, scenes)
    pivot, cam = setup_camera(scene)

    # stages
    ranges = stage_ranges(scenes, n_frames)
    for name, rs in ranges.items():
        coll = use_collection(f"Stage_{name}")
        made = STAGE_BUILDERS[name]()
        tops = [o for o in coll.objects if o.parent is None]
        animate_stage(tops, rs, 1, n_frames)
        if name == "ocean" and "Ocean" in made.modifiers:
            mod = made.modifiers["Ocean"]
            for f, t in ((1, 0.0), (n_frames, n_frames / FPS)):
                mod.time = t
                made.keyframe_insert('modifiers["Ocean"].time', frame=f)
            for fc in fcurves_of(made):
                if "Ocean" in fc.data_path:
                    for kp in fc.keyframe_points:
                        kp.interpolation = "LINEAR"
        if name == "sky":
            for c in made:  # clouds stream past -> sense of flight speed
                a, b = rs[0]
                x = c.location.x
                key(c, a, loc=(x + 14, c.location.y, c.location.z), interp="LINEAR")
                key(c, b, loc=(x - 14, c.location.y, c.location.z), interp="LINEAR")

    fx = FX()
    use_collection("HUD")
    hud_lc = bpy.context.view_layer.active_layer_collection
    for i, sc in enumerate(scenes):
        is_last = i == len(scenes) - 1
        root, model, meta = build_product(sc)
        f1 = animate_product(sc, root, model, meta, is_last, n_frames)
        visible_ranges(root, [(sc.start, f1)], 1, n_frames)
        sc.meta = meta

        # camera: whip from previous framing during the first `lead` frames
        fill = 0.70 + 0.22 * sc.hour / 24
        dist = max(meta["W"] / (2 * HUD_HALF_W / HUD_DIST * fill), meta["H"] / (0.52 * 2 * HUD_HALF_H / HUD_DIST * fill))
        lead = 0 if i == 0 else int(clamp(sc.frames * 0.2, 4, 10))
        span = sc.end - (sc.start + lead)
        for frac, az, el, dm, tm in CAMERA_MOVES[sc.camera_move]:
            f = sc.start + lead + int(frac * span)
            key_camera(pivot, cam, f, az, el, dist * dm, meta["H"] * 0.45 * tm)

        # FX
        center = (0, 0, meta["H"] * 0.5)
        if i > 0:
            count = {"rapid": 16, "medium": 26, "dramatic": 40}[sc.tier]
            fx.burst(sc.start, center, max(1.0, meta["W"] * 0.6), count)
        if sc.tier == "dramatic":
            fx.coin_shower(sc.start + 4, meta["W"] * 0.9, meta["top"] + 4)

        # HUD
        bpy.context.view_layer.active_layer_collection = hud_lc
        hud = build_hud(cam, sc, n_frames, 1)
        visible_ranges(hud, [(sc.start, sc.end)], 1, n_frames)

    # outro: camera rises & pulls back, finale fireworks, end card
    last = scenes[-1]
    o0 = last.end + 1
    final_dist = last.meta["W"] / (2 * HUD_HALF_W) * 1.15
    key_camera(pivot, cam, n_frames, 70, 22, final_dist, last.meta["H"] * 0.5)
    for k, (dx, dz) in enumerate(((-2.5, 4.0), (2.5, 5.0), (0.0, 6.0))):
        fx.burst(o0 + k * 10, (dx, 2.0, dz), 2.2, 40, dur=20)
    bpy.context.view_layer.active_layer_collection = hud_lc
    outro = HourScene(24, last.item, last.price, last.model_fn, "", "", last.stage, OUTRO_FRAMES, o0, n_frames)
    hud = build_hud(cam, outro, n_frames, 1, label_override=(
        "FROM $1 TO $16.7 MILLION", "IN JUST 24 HOURS", "THE POWER OF DOUBLING"))
    visible_ranges(hud, [(o0, n_frames)], 1, n_frames)

    scene.frame_set(1)
    return scenes


def parse_args(argv):
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    elif bpy is not None:
        argv = []
    else:
        argv = argv[1:]
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--table", action="store_true", help="print the purchase/timeline table and exit")
    p.add_argument("--render", action="store_true", help="render the animation")
    p.add_argument("--still", type=int, default=None, help="render a single frame")
    p.add_argument("--out", default="//money_doubling.mp4")
    p.add_argument("--save", default=None, help="save the generated .blend")
    p.add_argument("--engine", choices=["EEVEE", "CYCLES"], default="EEVEE")
    p.add_argument("--samples", type=int, default=0)
    p.add_argument("--preview", action="store_true", help="50%% resolution")
    return p.parse_args(argv)


def main():
    args = parse_args(sys.argv)
    scenes = build_timeline()
    if args.table or bpy is None:
        print_table(scenes)
        if bpy is None and not args.table:
            print("\n(bpy not available: run inside Blender to build the scene)")
        return
    build_scene(args)
    scene = bpy.context.scene
    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=bpy.path.abspath(args.save))
    if args.still is not None:
        scene.frame_set(args.still)
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = bpy.path.abspath(args.out)
        bpy.ops.render.render(write_still=True)
    elif args.render:
        im = scene.render.image_settings
        if hasattr(im, "media_type"):
            im.media_type = "VIDEO"
        im.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.codec = "H264"
        scene.render.ffmpeg.constant_rate_factor = "HIGH"
        scene.render.filepath = bpy.path.abspath(args.out)
        bpy.ops.render.render(animation=True)


if __name__ == "__main__":
    main()
