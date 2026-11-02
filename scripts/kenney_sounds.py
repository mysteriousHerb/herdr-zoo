# /// script
# dependencies = ["numpy", "soundfile", "lameenc"]
# ///
"""Turn Kenney's sound packs (CC0) into MP3s for the zoo's ♪ dialog.

The zips are downloaded by hand into sounds/ (git-ignored; kenney.nl refuses scripts):
Music Jingles (all 85: 8-bit, hit, pizzicato, sax, steel drum) and, from Interface Sounds,
the kinds that work as an alert (bong, confirmation, error, glass, pluck, question). UI Audio
is only clicks and switches, too short to notice, so it's skipped.

Each file is trimmed, mixed to mono and set to the same peak as the zoo's other sounds, then
written as a 96 kbps MP3 (volume.js can only scale MP3s) to mods/zoo/sounds/ in this repo.
CC0, so they can be committed and shared.

Run: uv run scripts/kenney_sounds.py   (then sh scripts/deploy.sh)
"""

import io
import re
import zipfile
from pathlib import Path

import lameenc
import numpy as np
import soundfile as sf

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "sounds"
OUT = REPO / "mods" / "zoo" / "sounds"
PEAK = 0.4

JINGLES = {"NES": "8bit", "HIT": "hit", "PIZZI": "pizzicato", "SAX": "sax", "STEEL": "steel-drum"}
INTERFACE = {"bong", "confirmation", "error", "glass", "pluck", "question"}


def trim(x: np.ndarray, floor: float = 0.003) -> np.ndarray:
    loud = np.flatnonzero(np.abs(x) > floor)
    return x[loud[0] : loud[-1] + 1] if len(loud) else x


def mp3(data: bytes, dest: Path) -> None:
    samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    samples = trim(samples.mean(axis=1))
    samples = samples * (PEAK / np.abs(samples).max())
    enc = lameenc.Encoder()
    enc.set_bit_rate(96)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()
    dest.write_bytes(enc.encode(pcm) + enc.flush())


def picks(name: str) -> str | None:
    """The MP3 name for one file in a zip, or None to skip it."""
    base = name.rsplit("/", 1)[-1]
    if m := re.fullmatch(r"jingles_([A-Z]+)(\d+)\.ogg", base):
        kind = JINGLES.get(m[1])
        return kind and f"jingle-{kind}-{int(m[2]) + 1:02d}"
    if (m := re.fullmatch(r"([a-z]+)_(\d+)\.ogg", base)) and m[1] in INTERFACE:
        return f"ui-{m[1]}-{int(m[2])}"
    return None


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    made = 0
    for z in sorted(SRC.glob("kenney_*.zip")):
        with zipfile.ZipFile(z) as zf:
            for name in zf.namelist():
                if out := picks(name):
                    mp3(zf.read(name), OUT / f"{out}.mp3")
                    made += 1
    print(f"{made} sounds in {OUT}")


if __name__ == "__main__":
    main()
