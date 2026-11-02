# /// script
# dependencies = ["pillow"]
# ///
"""Draw the isometric ground tiles the zoo's characters stand on, into mods/zoo/tiles/
(grass.png, water.png, sky.png; original pixel art, shareable).

Run: uv run scripts/make_tiles.py
"""

import random
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "mods" / "zoo" / "tiles"
W, H, DEPTH = 40, 20, 5  # the top diamond (2:1, isometric) and how thick the block is
SCALE = 2  # drawn at 2x with nearest neighbour, so the pixels stay crisp

TILES = {
    "grass": {
        "top": (120, 192, 80), "light": (152, 216, 104), "dark": (88, 152, 64), "rim": (64, 120, 48),
        "left": [(80, 136, 56), (136, 96, 56), (120, 84, 48)], "right": [(64, 112, 48), (112, 76, 44), (96, 64, 40)],
    },
    "water": {
        "top": (88, 144, 232), "light": (176, 212, 248), "dark": (72, 120, 208), "rim": (48, 88, 168),
        "left": [(64, 112, 200), (56, 96, 176), (48, 84, 160)], "right": [(52, 92, 176), (44, 80, 152), (40, 72, 136)],
    },
}


def inside(x, y):
    return abs(x + 0.5 - W / 2) / (W / 2) + abs(y + 0.5 - H / 2) / (H / 2) <= 1


def draw(name, c):
    rnd = random.Random(name)
    im = Image.new("RGBA", (W, H + DEPTH))
    px = im.load()
    for y in range(H + DEPTH):
        for x in range(W):
            if inside(x, y):
                edge = not all(inside(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
                color = c["rim"] if edge else c["top"]
                if not edge:
                    r = rnd.random()
                    if name == "grass" and r < 0.10:
                        color = c["light"]
                    elif name == "grass" and r < 0.18:
                        color = c["dark"]
                    elif name == "water" and y % 4 == 1 and (x + y) % 9 < 3:
                        color = c["light"]
                px[x, y] = (*color, 255)
                continue
            # The block's sides: the diamond pushed down, one row at a time.
            k = next((k for k in range(1, DEPTH + 1) if inside(x, y - k)), None)
            if k is not None and y >= H / 2:
                side = c["left"] if x < W / 2 else c["right"]
                px[x, y] = (*side[0 if k == 1 else 1 if k < DEPTH else 2], 255)
    return im.resize((W * SCALE, (H + DEPTH) * SCALE), Image.NEAREST)


# A cloud: a few puffs (circles seen at the same 2:1 angle), white on top, bluish below.
PUFFS = [(20, 8, 9), (11, 10, 7), (29, 10, 7), (15, 13, 6), (25, 13, 6), (20, 5, 6)]


def puffy(x, y):
    return any(((x + 0.5 - cx) / r) ** 2 + ((y + 0.5 - cy) / (r / 2)) ** 2 <= 1 for cx, cy, r in PUFFS)


def cloud():
    rnd = random.Random("sky")
    im = Image.new("RGBA", (W, H + DEPTH))
    px = im.load()
    for y in range(H + DEPTH):
        for x in range(W):
            if puffy(x, y):
                edge = not all(puffy(x + dx, y + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
                color = (196, 214, 240) if edge else (232, 240, 252) if rnd.random() < 0.12 else (250, 252, 255)
                px[x, y] = (*color, 255)
            elif any(puffy(x, y - k) for k in (1, 2, 3)):
                px[x, y] = (*((176, 198, 232) if x < W / 2 else (156, 180, 220)), 255)
    return im.resize((W * SCALE, (H + DEPTH) * SCALE), Image.NEAREST)


OUT.mkdir(parents=True, exist_ok=True)
for name, colors in TILES.items():
    draw(name, colors).save(OUT / f"{name}.png")
    print(OUT / f"{name}.png")
cloud().save(OUT / "sky.png")
print(OUT / "sky.png")
