#!/usr/bin/env python3
"""Generate path-based SVG lockups from the attached PNG marks + fonts."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]
LOGOS = ROOT / "public" / "logos"
FONT_DIR = Path("/tmp/logo-fonts")
LATO_BOLD = ROOT / "public" / "fonts" / "Lato-Bold.ttf"
LATO_REG = ROOT / "public" / "fonts" / "Lato-Regular.ttf"
LATO_LIGHT = FONT_DIR / "Lato-Light.ttf"
PLAYFAIR = FONT_DIR / "PlayfairDisplay-Bold.ttf"

PURPLE = "#62006E"
CHARCOAL = "#504E50"
BEIGE = "#E5E2DA"
INK = "#1a1916"


def load_playfair(weight: float = 700) -> TTFont:
    font = TTFont(PLAYFAIR)
    if "fvar" in font:
        instantiateVariableFont(font, {"wght": weight}, inplace=True)
    return font


def glyph_path(font: TTFont, char: str, x: float, y: float, size: float) -> tuple[str, float]:
    cmap = font.getBestCmap()
    upem = font["head"].unitsPerEm
    scale = size / upem
    name = cmap.get(ord(char))
    if not name:
        return "", font["hmtx"].metrics[".notdef"][0] * scale
    glyph_set = font.getGlyphSet()
    glyph = glyph_set[name]
    pen = SVGPathPen(glyph_set)
    # SVG y-down: flip glyph y around baseline at `y`
    tp = TransformPen(pen, (scale, 0, 0, -scale, x, y))
    glyph.draw(tp)
    advance = font["hmtx"].metrics[name][0] * scale
    return pen.getCommands(), advance


def text_paths(
    font: TTFont,
    text: str,
    size: float,
    *,
    tracking: float = 0,
    x: float = 0,
    y: float = 0,
) -> tuple[list[str], float]:
    paths = []
    cursor = x
    for i, ch in enumerate(text):
        if ch == " ":
            cursor += size * 0.33 + tracking
            continue
        d, adv = glyph_path(font, ch, cursor, y, size)
        if d:
            paths.append(d)
        cursor += adv + tracking
        if ch == " " or i == len(text) - 1:
            pass
    return paths, cursor - x


def paths_to_el(paths: list[str], fill: str) -> str:
    body = " ".join(paths)
    return f'<path fill="{fill}" d="{body}"/>'


def center_text(
    font: TTFont,
    text: str,
    size: float,
    cx: float,
    y: float,
    fill: str,
    tracking: float = 0,
) -> tuple[str, float]:
    paths, width = text_paths(font, text, size, tracking=tracking, x=0, y=y)
    shift = cx - width / 2
    shifted = []
    for d in paths:
        # naive: wrap in transform group instead of rewriting path
        shifted.append(d)
    el = (
        f'<g transform="translate({shift:.2f} 0)">'
        f"{paths_to_el(shifted, fill)}</g>"
    )
    return el, width


def tracking_to_match(font: TTFont, text: str, size: float, target_width: float) -> float:
    letters = [ch for ch in text if ch != " "]
    spaces = text.count(" ")
    base, _ = text_paths(font, text, size, tracking=0)
    # width with 0 tracking
    width0 = text_paths(font, text, size, tracking=0)[1]
    gaps = max(1, len(text) - 1)
    # include spaces as gaps already in width0
    extra = target_width - width0
    return extra / gaps


def flood_background(mask: list[list[bool]]) -> list[list[bool]]:
    """mask True = likely background-colored. Flood from edges; return interior snow as False remaining? 
    Returns `background` True where reachable white from edges."""
    h = len(mask)
    w = len(mask[0])
    bg = [[False] * w for _ in range(h)]
    stack = []
    for x in range(w):
        if mask[0][x]:
            stack.append((x, 0))
        if mask[h - 1][x]:
            stack.append((x, h - 1))
    for y in range(h):
        if mask[y][0]:
            stack.append((0, y))
        if mask[y][w - 1]:
            stack.append((w - 1, y))
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or bg[y][x] or not mask[y][x]:
            continue
        bg[y][x] = True
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return bg


def rdp(points: list[tuple[float, float]], epsilon: float) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points

    def dist(p, a, b):
        (x, y), (x1, y1), (x2, y2) = p, a, b
        dx, dy = x2 - x1, y2 - y1
        if dx == 0 and dy == 0:
            return math.hypot(x - x1, y - y1)
        t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
        return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))

    max_d, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        d = dist(points[i], points[0], points[-1])
        if d > max_d:
            max_d, idx = d, i
    if max_d > epsilon:
        left = rdp(points[: idx + 1], epsilon)
        right = rdp(points[idx:], epsilon)
        return left[:-1] + right
    return [points[0], points[-1]]


def trace_contour(binary: list[list[bool]]) -> list[list[tuple[int, int]]]:
    """Moore-neighbor outer contours. binary True = solid."""
    h = len(binary)
    w = len(binary[0])
    visited = [[False] * w for _ in range(h)]
    dirs = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]

    def inside(x, y):
        return 0 <= x < w and 0 <= y < h and binary[y][x]

    contours = []
    for y in range(h):
        for x in range(w):
            if not binary[y][x] or visited[y][x]:
                continue
            if inside(x - 1, y):
                continue
            # start of a contour
            contour = []
            cx, cy = x, y
            prev_dir = 0
            start = (x, y)
            for _ in range(w * h * 2):
                contour.append((cx, cy))
                visited[cy][cx] = True
                found = False
                for k in range(8):
                    di = (prev_dir + 5 + k) % 8
                    nx, ny = cx + dirs[di][0], cy + dirs[di][1]
                    if inside(nx, ny):
                        cx, cy = nx, ny
                        prev_dir = di
                        found = True
                        break
                if not found or ((cx, cy) == start and len(contour) > 3):
                    break
            if len(contour) >= 8:
                contours.append(contour)
    return contours


def poly_path(points: list[tuple[float, float]], scale_x: float, scale_y: float, ox: float, oy: float) -> str:
    if not points:
        return ""
    cmds = []
    for i, (x, y) in enumerate(points):
        px, py = ox + x * scale_x, oy + y * scale_y
        cmds.append(("M" if i == 0 else "L") + f"{px:.2f},{py:.2f}")
    cmds.append("Z")
    return " ".join(cmds)


def extract_layers(img: Image.Image, crop: tuple[int, int, int, int], purple_fn, white_fn):
    x0, y0, x1, y1 = crop
    crop_img = img.crop(crop).convert("RGBA")
    w, h = crop_img.size
    px = crop_img.load()
    whiteish = [[False] * w for _ in range(h)]
    purple = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if white_fn(r, g, b, a):
                whiteish[y][x] = True
            if purple_fn(r, g, b, a):
                purple[y][x] = True
    background = flood_background(whiteish)
    mountain = [[False] * w for _ in range(h)]
    snow = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if background[y][x]:
                continue
            if purple[y][x]:
                mountain[y][x] = True
            elif whiteish[y][x]:
                snow[y][x] = True
                mountain[y][x] = True
    return mountain, snow, w, h


def layer_paths(binary, epsilon, sx, sy, ox, oy):
    out = []
    for contour in trace_contour(binary):
        simplified = rdp([(float(x), float(y)) for x, y in contour], epsilon)
        if len(simplified) < 4:
            continue
        d = poly_path(simplified, sx, sy, ox, oy)
        if d:
            out.append(d)
    return out


def generate_pinnacle() -> str:
    img = Image.open(LOGOS / "pinnacle.png")
    mountain, snow, mw, mh = extract_layers(
        img,
        (0, 0, img.width, 98),
        purple_fn=lambda r, g, b, a: a > 20 and b > g + 15 and r > g + 10 and r > 40,
        white_fn=lambda r, g, b, a: a > 20 and r > 220 and g > 220 and b > 220,
    )
    # Fit mountains into 1000x280 box centered at 600, with base at y=300
    target_w, target_h = 980, 290
    sx, sy = target_w / mw, target_h / mh
    ox, oy = (1200 - target_w) / 2, 36
    m_paths = layer_paths(mountain, 1.35, sx, sy, ox, oy)
    s_paths = layer_paths(snow, 1.1, sx, sy, ox, oy)

    playfair = load_playfair(700)
    lato = TTFont(str(LATO_LIGHT if LATO_LIGHT.exists() else LATO_REG))

    cx = 600
    serif_size = 72
    serif_el, serif_w = center_text(playfair, "PINNACLE GROUP", serif_size, cx, 400, CHARCOAL, tracking=1.2)
    track = tracking_to_match(lato, "FINANCIAL SERVICES", 22, serif_w)
    sans_el, _ = center_text(lato, "FINANCIAL SERVICES", 22, cx, 448, PURPLE, tracking=track)

    mountain_el = paths_to_el(m_paths, PURPLE)
    snow_el = paths_to_el(s_paths, "#FFFFFF") if s_paths else ""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="520" viewBox="0 0 1200 520" role="img" aria-label="Pinnacle Group Financial Services">
  <title>Pinnacle Group Financial Services</title>
  <rect width="1200" height="520" fill="#FFFFFF"/>
  {mountain_el}
  {snow_el}
  {serif_el}
  {sans_el}
</svg>
"""


def hexagon_points(cx, cy, w, h) -> str:
    # Pointy-top vertical hexagon
    pts = [
        (cx, cy - h / 2),
        (cx + w / 2, cy - h / 4),
        (cx + w / 2, cy + h / 4),
        (cx, cy + h / 2),
        (cx - w / 2, cy + h / 4),
        (cx - w / 2, cy - h / 4),
    ]
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in pts)


def generate_entertainment() -> str:
    img = Image.open(LOGOS / "pinball-land.png")
    # mountains roughly y 280-365
    mountain, snow, mw, mh = extract_layers(
        img,
        (80, 278, 420, 368),
        purple_fn=lambda r, g, b, a: a > 20 and r > 50 and b > 50 and r > g + 10 and b > g,
        white_fn=lambda r, g, b, a: a > 20 and r > 210 and g > 210 and b > 210,
    )
    sx, sy = 620 / mw, 170 / mh
    ox, oy = 190, 575
    m_paths = layer_paths(mountain, 1.4, sx, sy, ox, oy)
    s_paths = layer_paths(snow, 1.1, sx, sy, ox, oy)

    lato_bold = TTFont(str(LATO_BOLD))
    lato = TTFont(str(LATO_REG))

    # PINNACLE with Lambda for A
    pin_text = "PINN" + "\u039B" + "CLE"
    pin_el, pin_w = center_text(lato_bold, pin_text, 92, 500, 430, CHARCOAL, tracking=4)
    track = tracking_to_match(lato, "ENTERTAINMENT CENTER", 18, pin_w * 0.98)
    sub_el, sub_w = center_text(lato, "ENTERTAINMENT CENTER", 18, 500, 478, CHARCOAL, tracking=track)

    cal_el, _ = center_text(lato_bold, "CALIFORNIA", 22, 500, 820, BEIGE, tracking=6)

    outer = hexagon_points(500, 500, 760, 940)
    inner = hexagon_points(500, 500, 700, 870)
    inner2 = hexagon_points(500, 500, 668, 830)

    # footer: charcoal triangle clipped to hex — polygon covering bottom point
    footer = f"{500:.2f},{500 + 870/2:.2f} {500 + 700/2:.2f},{500 + 870/4:.2f} {500 - 700/2:.2f},{500 + 870/4:.2f}"
    # Better footer: a band across lower hex
    footer_pts = "155,718 845,718 500,935"

    mountain_el = paths_to_el(m_paths, PURPLE)
    snow_el = paths_to_el(s_paths, "#FFFFFF") if s_paths else ""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000" role="img" aria-label="Pinnacle Entertainment Center California">
  <title>Pinnacle Entertainment Center</title>
  <polygon points="{outer}" fill="none" stroke="{CHARCOAL}" stroke-width="6"/>
  <polygon points="{inner}" fill="{BEIGE}" stroke="{CHARCOAL}" stroke-width="14"/>
  <polygon points="{inner2}" fill="{BEIGE}" stroke="{CHARCOAL}" stroke-width="3"/>

  <!-- pinball -->
  <circle cx="500" cy="210" r="28" fill="{PURPLE}"/>
  <g fill="{PURPLE}">
    <path d="M338 318 L470 248 L482 268 L362 348 Z"/>
    <path d="M662 318 L530 248 L518 268 L638 348 Z"/>
  </g>

  {pin_el}
  <!-- hairline rules flanking subtitle -->
  <line x1="200" y1="468" x2="{500 - sub_w/2 - 16:.1f}" y2="468" stroke="{CHARCOAL}" stroke-width="2"/>
  <line x1="{500 + sub_w/2 + 16:.1f}" y1="468" x2="800" y2="468" stroke="{CHARCOAL}" stroke-width="2"/>
  {sub_el}

  {mountain_el}
  {snow_el}

  <polygon points="{footer_pts}" fill="{CHARCOAL}"/>
  {cal_el}
  <circle cx="470" cy="860" r="5" fill="{BEIGE}"/>
  <circle cx="500" cy="860" r="5" fill="{BEIGE}"/>
  <circle cx="530" cy="860" r="5" fill="{BEIGE}"/>
</svg>
"""


def main():
    pinnacle = generate_pinnacle()
    (LOGOS / "pinnacle.svg").write_text(pinnacle, encoding="utf-8")
    print("wrote", LOGOS / "pinnacle.svg", "bytes", len(pinnacle))
    ent = generate_entertainment()
    (LOGOS / "pinball-land.svg").write_text(ent, encoding="utf-8")
    print("wrote", LOGOS / "pinball-land.svg", "bytes", len(ent))


if __name__ == "__main__":
    main()
