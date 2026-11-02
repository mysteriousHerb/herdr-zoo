# /// script
# dependencies = ["numpy", "pillow"]
# ///
"""Render Kenney's Cube Pets (CC0, https://kenney.nl/assets/cube-pets) to the zoo's
animated sprites: for each pet, one GIF per agent state from the model's own animations,
idle included, seen from the zoo tiles' isometric angle.

The models are rigid parts (body, legs, tail…) moved by keyframes, coloured from one
palette texture, so a small numpy rasterizer does it; no Blender needed.

Download the zip by hand (kenney.nl refuses scripts) into sprites/ (git-ignored), then:
  uv run scripts/render_cube_pets.py [path/to/kenney_cube-pets_1.0.zip]
  uv run scripts/render_cube_pets.py --sheet fox   # every animation of one pet, as a PNG
Writes mods/zoo/packs/cube-pets/<pet>/<animation>.gif per state and
mods/zoo/packs/cube-pets.json, then rebuilds the catalog (make_packs.py).
"""

import io
import json
import struct
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_packs import write_catalog  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "mods" / "zoo" / "packs" / "cube-pets"
# Which of the model's animations each agent state plays. Idle plays the model's own idle loop
# (the user's pick 2026-11-01, over a still: it keeps Herdr redrawing while agents sit idle).
STATES = {"work": "walk", "blocked": "gesture-negative", "done": "gesture-positive", "idle": "idle"}
STILL = "static"
# Part of every file name. Herdr caches images by path, so bump it whenever the pictures change
# (angle, light, size); picking another animation for a state needs no bump (files are named by
# animation, and the box fits all of them).
LOOK = 2
FPS = 20
SIZE = 112  # the GIF's longest side in pixels: 2x the zoo's 56 px box, for hi-DPI screens
SS = 4  # supersampling: rendered this many times larger, then shrunk (smooth edges)
YAW, PITCH = np.radians(-35), np.radians(30)  # 30° down = the 2:1 isometric of the tiles
LIGHT = np.array([-0.45, 0.8, 0.55])
LIGHT /= np.linalg.norm(LIGHT)
OUTLINE = (40, 32, 48)
NAMES = {"polar": "Polar bear"}
TILES = {"fish": "water", "crab": "water", "penguin": "water", "bee": "sky", "parrot": "sky"}


# --- glTF ------------------------------------------------------------------------------

COMP = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Model:
    def __init__(self, glb: bytes, texture: Image.Image):
        n = struct.unpack_from("<I", glb, 12)[0]
        self.j = json.loads(glb[20 : 20 + n])
        off = 20 + n
        blen = struct.unpack_from("<I", glb, off)[0]
        self.bin = glb[off + 8 : off + 8 + blen]
        self.tex = np.asarray(texture.convert("RGB"), dtype=np.float32) / 255
        self.nodes = self.j["nodes"]
        self.parent = {c: i for i, nd in enumerate(self.nodes) for c in nd.get("children", [])}
        self.anims = {a["name"]: a for a in self.j.get("animations", [])}
        self.meshes = {}
        for i, nd in enumerate(self.nodes):
            if "mesh" in nd:
                parts = []
                for p in self.j["meshes"][nd["mesh"]]["primitives"]:
                    pos = self.acc(p["attributes"]["POSITION"])
                    uv = self.acc(p["attributes"]["TEXCOORD_0"])
                    idx = self.acc(p["indices"]).astype(np.int64).reshape(-1, 3)
                    parts.append((pos, uv, idx))
                self.meshes[i] = parts

    def acc(self, k):
        a = self.j["accessors"][k]
        bv = self.j["bufferViews"][a["bufferView"]]
        dt = COMP[a["componentType"]]
        w = WIDTH[a["type"]]
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", 0)
        if stride and stride != w * np.dtype(dt).itemsize:
            raw = np.frombuffer(self.bin, np.uint8, a["count"] * stride, start).reshape(-1, stride)
            return raw[:, : w * np.dtype(dt).itemsize].copy().view(dt).reshape(a["count"], w)
        arr = np.frombuffer(self.bin, dt, a["count"] * w, start)
        return arr.reshape(a["count"], w) if w > 1 else arr

    def duration(self, name):
        a = self.anims[name]
        return max(float(self.acc(s["input"]).max()) for s in a["samplers"])

    def pose(self, name, t):
        """Each node's (translation, rotation, scale) at time t of animation `name`."""
        trs = {}
        for i, nd in enumerate(self.nodes):
            trs[i] = [np.array(nd.get("translation", [0, 0, 0]), float),
                      np.array(nd.get("rotation", [0, 0, 0, 1]), float),
                      np.array(nd.get("scale", [1, 1, 1]), float)]
        a = self.anims.get(name)
        if a:
            for ch in a["channels"]:
                s = a["samplers"][ch["sampler"]]
                times = self.acc(s["input"]).astype(float)
                vals = self.acc(s["output"]).astype(float)
                path = ch["target"]["path"]
                if path == "weights":
                    continue
                k = np.searchsorted(times, t, side="right") - 1
                if k < 0:
                    v = vals[0]
                elif k >= len(times) - 1 or s.get("interpolation") == "STEP":
                    v = vals[min(k, len(vals) - 1)]
                else:
                    f = (t - times[k]) / (times[k + 1] - times[k])
                    v0, v1 = vals[k], vals[k + 1]
                    if path == "rotation":
                        if np.dot(v0, v1) < 0:
                            v1 = -v1
                        v = v0 * (1 - f) + v1 * f
                        v /= np.linalg.norm(v)
                    else:
                        v = v0 * (1 - f) + v1 * f
                trs[ch["target"]["node"]][["translation", "rotation", "scale"].index(path)] = v
        return trs

    def world(self, trs):
        local = {i: mat(*v) for i, v in trs.items()}
        out = {}

        def get(i):
            if i not in out:
                out[i] = get(self.parent[i]) @ local[i] if i in self.parent else local[i]
            return out[i]

        for i in range(len(self.nodes)):
            get(i)
        return out

    def triangles(self, name, t):
        """World-space triangles (N,3,3) and their texture colours (N,3,3 per vertex uv→rgb)."""
        w = self.world(self.pose(name, t))
        tris, uvs = [], []
        for i, parts in self.meshes.items():
            m = w[i]
            for pos, uv, idx in parts:
                p = pos @ m[:3, :3].T + m[:3, 3]
                tris.append(p[idx])
                uvs.append(uv[idx])
        return np.concatenate(tris), np.concatenate(uvs)


def mat(t, q, s):
    x, y, z, w = q
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    m = np.eye(4)
    m[:3, :3] = r * s
    m[:3, 3] = t
    return m


# --- rendering ---------------------------------------------------------------------------

def view_matrix():
    cy, sy = np.cos(YAW), np.sin(YAW)
    cp, sp = np.cos(PITCH), np.sin(PITCH)
    yaw = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    pitch = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    return pitch @ yaw  # view: x right, y up, z toward the camera


VIEW = view_matrix()


def project(tris):
    return tris @ VIEW.T


def raster(model, tris, uvs, box, scale, w, h):
    """Z-buffered render of view-space triangles into an RGBA float image (h, w, 4)."""
    img = np.zeros((h, w, 4), np.float32)
    depth = np.full((h, w), -np.inf, np.float32)
    x0, y1 = box[0], box[3]
    sx = (tris[..., 0] - x0) * scale
    sy = (y1 - tris[..., 1]) * scale
    sz = tris[..., 2]
    # Flat shading from each face's normal (in view space, so the light sits with the camera).
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    n[n[:, 2] < 0] *= -1  # double-sided: face the camera
    light = VIEW @ LIGHT
    shade = 0.5 + 0.62 * np.clip(n @ light, 0, 1)
    th, tw = model.tex.shape[:2]
    for k in range(len(tris)):
        xs, ys = sx[k], sy[k]
        ax, bx_ = int(max(np.floor(xs.min()), 0)), int(min(np.ceil(xs.max()) + 1, w))
        ay, by = int(max(np.floor(ys.min()), 0)), int(min(np.ceil(ys.max()) + 1, h))
        if ax >= bx_ or ay >= by:
            continue
        px, py = np.meshgrid(np.arange(ax, bx_) + 0.5, np.arange(ay, by) + 0.5)
        (x0_, x1_, x2_), (y0_, y1_, y2_) = xs, ys
        d = (y1_ - y2_) * (x0_ - x2_) + (x2_ - x1_) * (y0_ - y2_)
        if abs(d) < 1e-9:
            continue
        l0 = ((y1_ - y2_) * (px - x2_) + (x2_ - x1_) * (py - y2_)) / d
        l1 = ((y2_ - y0_) * (px - x2_) + (x0_ - x2_) * (py - y2_)) / d
        l2 = 1 - l0 - l1
        inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
        if not inside.any():
            continue
        z = l0 * sz[k, 0] + l1 * sz[k, 1] + l2 * sz[k, 2]
        sub = depth[ay:by, ax:bx_]
        win = inside & (z > sub)
        if not win.any():
            continue
        u = l0 * uvs[k, 0, 0] + l1 * uvs[k, 1, 0] + l2 * uvs[k, 2, 0]
        v = l0 * uvs[k, 0, 1] + l1 * uvs[k, 1, 1] + l2 * uvs[k, 2, 1]
        tx = np.clip((u * tw).astype(int), 0, tw - 1)
        ty = np.clip((v * th).astype(int), 0, th - 1)
        col = model.tex[ty, tx] * shade[k]
        sub[win] = z[win]
        tile = img[ay:by, ax:bx_]
        tile[win, :3] = np.clip(col[win], 0, 1)
        tile[win, 3] = 1
    return img


def frames_of(model, name):
    if name == STILL:
        return [0.0]
    dur = model.duration(name)
    count = max(1, round(dur * FPS))
    return [dur * i / count for i in range(count)]


def bounds(model, names):
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for name in names:
        for t in frames_of(model, name):
            p = project(model.triangles(name, t)[0]).reshape(-1, 3)
            lo, hi = np.minimum(lo, p.min(0)), np.maximum(hi, p.max(0))
    return lo[0], lo[1], hi[0], hi[1]


def outline(im: Image.Image) -> Image.Image:
    """A 1 px dark line around the sprite, so it reads on any background."""
    a = np.asarray(im)[..., 3] > 127
    grow = a.copy()
    grow[1:] |= a[:-1]
    grow[:-1] |= a[1:]
    grow[:, 1:] |= a[:, :-1]
    grow[:, :-1] |= a[:, 1:]
    rgba = np.asarray(im).copy()
    ring = grow & ~a
    rgba[ring] = (*OUTLINE, 255)
    rgba[~grow, 3] = 0
    rgba[a, 3] = 255
    return Image.fromarray(rgba)


def render(model, name, t, box, size):
    w, h = size
    scale = (w - 2) * SS / (box[2] - box[0])
    tris, uvs = model.triangles(name, t)
    img = raster(model, project(tris), uvs, box, scale, w * SS, h * SS)
    # Shift by the 1 px outline margin, then shrink with alpha-weighted averaging.
    big = Image.fromarray((img * 255).astype(np.uint8), "RGBA")
    canvas = Image.new("RGBA", (w * SS, h * SS))
    canvas.paste(big, (SS, SS))
    small = canvas.resize((w, h), Image.Resampling.BOX)
    return outline(small)


def sprite_size(box):
    bw, bh = box[2] - box[0], box[3] - box[1]
    inner = SIZE - 2
    s = inner / max(bw, bh)
    return max(int(np.ceil(bw * s)) + 2, 4), max(int(np.ceil(bh * s)) + 2, 4)


def to_gif(frames, path):
    """GIF has 1-bit transparency: pixels under half alpha drop out, the rest are opaque."""
    pal = []
    for f in frames:
        rgba = np.asarray(f)
        rgb = Image.fromarray(rgba[..., :3]).convert("RGB")
        q = rgb.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        data = np.asarray(q).copy()
        data[rgba[..., 3] < 128] = 255
        p = Image.fromarray(data, "P")
        palette = q.getpalette()[: 255 * 3] + [0, 0, 0]
        palette += [0] * (768 - len(palette))
        p.putpalette(palette)
        p.info["transparency"] = 255
        pal.append(p)
    pal[0].save(path, save_all=True, append_images=pal[1:], duration=round(1000 / FPS),
                loop=0, disposal=2, transparency=255, optimize=False)


def load(zip_path):
    z = zipfile.ZipFile(zip_path)
    names = z.namelist()
    tex_name = next(n for n in names if n.endswith("GLB format/Textures/colormap.png"))
    tex = Image.open(io.BytesIO(z.read(tex_name)))
    pets = {}
    for n in names:
        if "GLB format/" in n and n.endswith(".glb"):
            pets[Path(n).stem.removeprefix("animal-")] = z.read(n)
    return pets, tex


def build(args):
    pet, glb, tex_bytes = args
    model = Model(glb, Image.open(io.BytesIO(tex_bytes)))
    used = list(model.anims)  # all of them: the size stays put when a state gets another one
    box = bounds(model, used)
    size = sprite_size(box)
    d = OUT / pet
    d.mkdir(parents=True, exist_ok=True)
    for state, anim in STATES.items():
        to_gif([render(model, anim, t, box, size) for t in frames_of(model, anim)], d / f"{anim}-{LOOK}.gif")
    return pet, size


def sheet(zip_path, pet):
    pets, tex = load(zip_path)
    model = Model(pets[pet], tex)
    names = list(model.anims)
    box = bounds(model, names)
    size = sprite_size(box)
    rows = [[render(model, n, t, box, size) for t in frames_of(model, n)[::2]] for n in names]
    cols = max(len(r) for r in rows)
    out = Image.new("RGBA", (cols * size[0], len(rows) * size[1]), (34, 38, 46, 255))
    for y, r in enumerate(rows):
        for x, f in enumerate(r):
            out.alpha_composite(f, (x * size[0], y * size[1]))
    path = Path.cwd() / f"cube-pets-{pet}-sheet.png"
    out.save(path)
    print(path, names)


def main():
    args = [a for i, a in enumerate(sys.argv[1:], 1) if not a.startswith("--") and sys.argv[i - 1] != "--sheet"]
    found = sorted(Path(__file__).resolve().parent.parent.glob("sprites/kenney_cube-pets*.zip"))
    if not args and not found:
        sys.exit(__doc__)
    zip_path = Path(args[0]).expanduser() if args else found[-1]
    if "--sheet" in sys.argv:
        return sheet(zip_path, sys.argv[sys.argv.index("--sheet") + 1])
    pets, tex = load(zip_path)
    buf = io.BytesIO()
    tex.save(buf, "PNG")
    jobs = [(p, glb, buf.getvalue()) for p, glb in sorted(pets.items())]
    sprites = []
    with ProcessPoolExecutor() as ex:
        for pet, (w, h) in ex.map(build, jobs):
            # Shown at half the file's size: sharp on 2x screens.
            sprites.append({"id": pet, "name": NAMES.get(pet, pet.capitalize()), "w": w // 2, "h": h // 2,
                            "tile": TILES.get(pet, "grass")})
            print(pet, w, h)
    pack = {
        "id": "cube-pets",
        "name": "Cube Pets",
        "credit": "Cube Pets by Kenney, kenney.nl (CC0)",
        "files": {s: f"mods/zoo/packs/cube-pets/{{id}}/{a}-{LOOK}.gif" for s, a in STATES.items()},
        "bob": False,
        "sprites": sprites,
    }
    (OUT.parent / "cube-pets.json").write_text(json.dumps(pack, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    write_catalog()


if __name__ == "__main__":
    main()
