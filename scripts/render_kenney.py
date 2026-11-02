# /// script
# dependencies = ["numpy", "pillow"]
# ///
"""Render Kenney's animated 3D packs (CC0, kenney.nl) to the zoo's sprites: for each model,
one GIF per agent state from the model's own animations, idle included, seen
from the zoo tiles' isometric angle. Packs (PACKS below): Blocky Characters, Mini
Characters. (Cube Pets has its own script, render_cube_pets.py, from which this one grew.)

The models are parts moved by keyframes (Blocky) or meshes on a skeleton (Mini
Characters: linear blend skinning), coloured from a texture, so a small numpy rasterizer
does it; no Blender needed.

Download the zips by hand (kenney.nl refuses scripts) into sprites/ (git-ignored), then:
  uv run scripts/render_kenney.py                 # every pack whose zip is in sprites/
  uv run scripts/render_kenney.py blocky          # one pack
  uv run scripts/render_kenney.py blocky --sheet a   # every animation of one model, as a PNG
Writes mods/zoo/packs/<pack>/<id>/{work,blocked,done,idle}-<LOOK>.gif and
mods/zoo/packs/<pack>.json, then rebuilds the catalog (make_packs.py).
"""

import io
import json
import posixpath
import struct
import sys
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_packs import write_catalog  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
PACKS_DIR = REPO / "mods" / "zoo" / "packs"

# Each pack: its zip in sprites/, which models (file stem prefix), the animation each agent
# state plays, names, tiles. Idle plays the model's own idle loop (the user's pick 2026-11-01,
# over a still: it keeps Herdr redrawing while agents sit idle).
PACKS = {
    "blocky": {
        "name": "Blocky", "zip": "kenney_blocky-characters*.zip", "prefix": "character-",
        "credit": "Blocky Characters by Kenney, kenney.nl (CC0)",
        "states": {"work": "walk", "blocked": "emote-no", "done": "emote-yes", "idle": "idle"},
        # By look (Kenney only letters them).
        "names": dict(zip("abcdefghijklmnopqr", ["Ben", "Ruby", "Cal", "Hazmat", "Eli", "Finn", "Robot", "Robo",
                                                 "Doctor", "Police", "Kat", "Zombie", "Max", "Nurse", "Orc", "Pat",
                                                 "Agent", "Ninja"])),
        "tiles": {},
    },
    "mini": {
        "name": "Mini", "zip": "kenney_mini-characters*.zip", "prefix": "character-",
        "credit": "Mini Characters by Kenney, kenney.nl (CC0)",
        "states": {"work": "walk", "blocked": "emote-no", "done": "jump", "idle": "idle"},
        "names": {f"{g}-{c}": n for g, ns in (("female", ["Ava", "Bea", "Cora", "Dot", "Eve", "Fay"]),
                                               ("male", ["Al", "Bo", "Officer", "Dan", "Ed", "Finn"]))
                  for c, n in zip("abcdef", ns)},
        "tiles": {},
    },
}
STILL = "static"
FPS = 20
# Bumped whenever the look changes: the files are <state>-<LOOK>.gif, because Herdr caches
# images by path (misses too), so a changed picture needs a new name.
LOOK = 1
SIZE = 112  # the GIF's longest side in pixels: 2x the zoo's box, for hi-DPI screens
SS = 4  # supersampling: rendered this many times larger, then shrunk (smooth edges)
YAW, PITCH = np.radians(-35), np.radians(30)  # 30° down = the 2:1 isometric of the tiles
LIGHT = np.array([-0.45, 0.8, 0.55])
LIGHT /= np.linalg.norm(LIGHT)
OUTLINE = (40, 32, 48)


# --- glTF ------------------------------------------------------------------------------

COMP = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


class Model:
    def __init__(self, glb: bytes, textures: dict):
        """textures: image uri (as the model names it) → PNG bytes."""
        n = struct.unpack_from("<I", glb, 12)[0]
        self.j = json.loads(glb[20 : 20 + n])
        off = 20 + n
        blen = struct.unpack_from("<I", glb, off)[0]
        self.bin = glb[off + 8 : off + 8 + blen]
        self.texs = []
        for img in self.j.get("images", []):
            if "uri" in img:
                data = textures[img["uri"]]
            else:
                bv = self.j["bufferViews"][img["bufferView"]]
                data = self.bin[bv.get("byteOffset", 0) : bv.get("byteOffset", 0) + bv["byteLength"]]
            self.texs.append(np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.float32) / 255)
        self.nodes = self.j["nodes"]
        self.parent = {c: i for i, nd in enumerate(self.nodes) for c in nd.get("children", [])}
        self.anims = {a["name"]: a for a in self.j.get("animations", [])}
        # Each mesh part: (node, positions, uvs, triangle indices, texture, skin or None).
        self.parts = []
        for i, nd in enumerate(self.nodes):
            if "mesh" not in nd:
                continue
            skin = None
            if "skin" in nd:
                sk = self.j["skins"][nd["skin"]]
                inv = self.acc(sk["inverseBindMatrices"]).astype(float).reshape(-1, 4, 4).transpose(0, 2, 1)
                skin = (sk["joints"], inv)
            for p in self.j["meshes"][nd["mesh"]]["primitives"]:
                a = p["attributes"]
                pos = self.acc(a["POSITION"]).astype(float)
                uv = self.acc(a["TEXCOORD_0"]).astype(float)
                idx = self.acc(p["indices"]).astype(np.int64).reshape(-1, 3)
                tex = self.texture_of(p.get("material"))
                weights = None
                if skin and "JOINTS_0" in a:
                    weights = (self.acc(a["JOINTS_0"]).astype(np.int64), self.weights(a["WEIGHTS_0"]))
                self.parts.append((i, pos, uv, idx, tex, skin, weights))

    def texture_of(self, material):
        if material is None or not self.texs:
            return 0
        info = self.j["materials"][material].get("pbrMetallicRoughness", {}).get("baseColorTexture")
        return self.j["textures"][info["index"]]["source"] if info else 0

    def weights(self, k):
        a = self.j["accessors"][k]
        w = self.acc(k).astype(float)
        if a["componentType"] == 5121:
            w /= 255
        elif a["componentType"] == 5123:
            w /= 65535
        return w

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
            if "matrix" in nd:
                m = np.array(nd["matrix"], float).reshape(4, 4).T
                trs[i] = m
                continue
            trs[i] = [np.array(nd.get("translation", [0, 0, 0]), float),
                      np.array(nd.get("rotation", [0, 0, 0, 1]), float),
                      np.array(nd.get("scale", [1, 1, 1]), float)]
        a = self.anims.get(name)
        if a:
            for ch in a["channels"]:
                node = ch["target"].get("node")
                path = ch["target"]["path"]
                if node is None or path == "weights" or not isinstance(trs[node], list):
                    continue
                s = a["samplers"][ch["sampler"]]
                times = self.acc(s["input"]).astype(float)
                vals = self.acc(s["output"]).astype(float)
                cubic = s.get("interpolation") == "CUBICSPLINE"
                if cubic:  # (in-tangent, value, out-tangent) per key: keep the values
                    vals = vals.reshape(len(times), 3, -1)[:, 1]
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
                trs[node][["translation", "rotation", "scale"].index(path)] = v
        return trs

    def world(self, trs):
        local = {i: (v if isinstance(v, np.ndarray) else mat(*v)) for i, v in trs.items()}
        out = {}

        def get(i):
            if i not in out:
                out[i] = get(self.parent[i]) @ local[i] if i in self.parent else local[i]
            return out[i]

        for i in range(len(self.nodes)):
            get(i)
        return out

    def triangles(self, name, t):
        """World-space triangles (N,3,3), their uvs (N,3,2) and texture index (N,)."""
        w = self.world(self.pose(name, t))
        tris, uvs, texs = [], [], []
        for node, pos, uv, idx, tex, skin, weights in self.parts:
            if skin and weights is not None:
                joints, inv = skin
                jm = np.stack([w[j] @ inv[k] for k, j in enumerate(joints)])  # (J,4,4)
                ji, wt = weights
                m = np.einsum("vk,vkab->vab", wt, jm[ji])  # each vertex's blended matrix
                p = np.einsum("vab,vb->va", m[:, :3, :3], pos) + m[:, :3, 3]
            else:
                m = w[node]
                p = pos @ m[:3, :3].T + m[:3, 3]
            tris.append(p[idx])
            uvs.append(uv[idx])
            texs.append(np.full(len(idx), tex))
        return np.concatenate(tris), np.concatenate(uvs), np.concatenate(texs)


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


def raster(model, tris, uvs, texs, box, scale, w, h):
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
    blank = np.ones((1, 1, 3), np.float32) * 0.8
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
        tex = model.texs[texs[k]] if model.texs else blank
        th, tw = tex.shape[:2]
        u = l0 * uvs[k, 0, 0] + l1 * uvs[k, 1, 0] + l2 * uvs[k, 2, 0]
        v = l0 * uvs[k, 0, 1] + l1 * uvs[k, 1, 1] + l2 * uvs[k, 2, 1]
        tx = np.clip((np.mod(u, 1) * tw).astype(int), 0, tw - 1)
        ty = np.clip((np.mod(v, 1) * th).astype(int), 0, th - 1)
        col = tex[ty, tx] * shade[k]
        sub[win] = z[win]
        tile = img[ay:by, ax:bx_]
        tile[win, :3] = np.clip(col[win], 0, 1)
        tile[win, 3] = 1
    return img


def frames_of(model, name):
    if name == STILL or name not in model.anims:
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
    tris, uvs, texs = model.triangles(name, t)
    img = raster(model, project(tris), uvs, texs, box, scale, w * SS, h * SS)
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


def zip_of(pack):
    found = sorted(REPO.glob(f"sprites/{PACKS[pack]['zip']}"))
    return found[-1] if found else None


def load(pack):
    """{id: (glb bytes, {texture uri: png bytes})} for the pack's models."""
    cfg = PACKS[pack]
    z = zipfile.ZipFile(zip_of(pack))
    names = z.namelist()
    models = {}
    for n in names:
        if "GLB format/" not in n or not n.endswith(".glb"):
            continue
        stem = Path(n).stem
        if not stem.startswith(cfg["prefix"]):
            continue
        glb = z.read(n)
        j = json.loads(glb[20 : 20 + struct.unpack_from("<I", glb, 12)[0]])
        folder = posixpath.dirname(n)
        texs = {img["uri"]: z.read(posixpath.join(folder, img["uri"])) for img in j.get("images", []) if "uri" in img}
        models[stem.removeprefix(cfg["prefix"])] = (glb, texs)
    return models


def build(args):
    pack, mid, glb, texs = args
    cfg = PACKS[pack]
    model = Model(glb, texs)
    used = list(cfg["states"].values())
    box = bounds(model, used)
    size = sprite_size(box)
    d = PACKS_DIR / pack / mid
    d.mkdir(parents=True, exist_ok=True)
    for state, anim in cfg["states"].items():
        to_gif([render(model, anim, t, box, size) for t in frames_of(model, anim)], d / f"{state}-{LOOK}.gif")
    return mid, size


def name_of(cfg, mid):
    if mid in cfg["names"]:
        return cfg["names"][mid]
    return " ".join(w.capitalize() if len(w) > 1 else w.upper() for w in mid.split("-"))


def run_pack(pack):
    cfg = PACKS[pack]
    jobs = [(pack, mid, glb, texs) for mid, (glb, texs) in sorted(load(pack).items())]
    sprites = []
    with ProcessPoolExecutor() as ex:
        for mid, (w, h) in ex.map(build, jobs):
            # Shown at half the file's size: sharp on 2x screens.
            sprites.append({"id": mid, "name": name_of(cfg, mid), "w": w // 2, "h": h // 2,
                            "tile": cfg["tiles"].get(mid, "grass")})
            print(pack, mid, w, h)
    data = {
        "id": pack,
        "name": cfg["name"],
        "credit": cfg["credit"],
        "files": {s: f"mods/zoo/packs/{pack}/{{id}}/{s}-{LOOK}.gif" for s in cfg["states"]},
        "bob": False,
        "sprites": sprites,
    }
    (PACKS_DIR / f"{pack}.json").write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def sheet(pack, mid):
    glb, texs = load(pack)[mid]
    model = Model(glb, texs)
    names = list(model.anims)
    box = bounds(model, names)
    size = sprite_size(box)
    rows = [[render(model, n, t, box, size) for t in frames_of(model, n)[::3]][:10] for n in names]
    cols = max(len(r) for r in rows)
    label = 150
    out = Image.new("RGBA", (label + cols * size[0], len(rows) * size[1]), (34, 38, 46, 255))
    from PIL import ImageDraw
    draw = ImageDraw.Draw(out)
    for y, r in enumerate(rows):
        draw.text((6, y * size[1] + size[1] // 2), names[y], fill=(220, 220, 220, 255))
        for x, f in enumerate(r):
            out.alpha_composite(f, (label + x * size[0], y * size[1]))
    path = Path.cwd() / f"{pack}-{mid}-sheet.png"
    out.save(path)
    print(path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--sheet" in sys.argv:
        return sheet(args[0], sys.argv[sys.argv.index("--sheet") + 1])
    packs = [a for a in args if a in PACKS] or [p for p in PACKS if zip_of(p)]
    if not packs:
        sys.exit(__doc__)
    for pack in packs:
        if not zip_of(pack):
            sys.exit(f"no sprites/{PACKS[pack]['zip']}")
        run_pack(pack)
    write_catalog()


if __name__ == "__main__":
    main()
