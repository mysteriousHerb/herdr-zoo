# /// script
# dependencies = ["numpy", "lameenc"]
# ///
"""Synthesize the original Game Boy-style sound effects in mods/zoo/sounds/ (shareable: no game audio).

Run: uv run scripts/make_sounds.py
"""

from pathlib import Path

import lameenc
import numpy as np

OUT = Path(__file__).resolve().parent.parent / "mods" / "zoo" / "sounds"
R = 22050


def tone(freq, ms, duty=0.5, decay=6.0, vol=0.28):
    t = np.arange(int(R * ms / 1000)) / R
    wave = np.where((t * freq) % 1 < duty, 1.0, -1.0)  # pulse wave, as on the Game Boy
    return wave * np.exp(-decay * t) * vol


def gap(ms):
    return np.zeros(int(R * ms / 1000))


def note(name):
    i = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"].index(name[:-1])
    return 440 * 2 ** ((i - 9) / 12 + int(name[-1]) - 4)


def save(name, *parts):
    enc = lameenc.Encoder()
    enc.set_bit_rate(64)
    enc.set_in_sample_rate(R)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = (np.clip(np.concatenate(parts), -1, 1) * 32767).astype(np.int16).tobytes()
    (OUT / f"{name}.mp3").write_bytes(enc.encode(pcm) + enc.flush())


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    save("chime-up", *[tone(note(n), 80, decay=4) for n in ["C6", "E6", "G6"]], tone(note("C7"), 420, decay=5))
    save(
        "level-up",
        tone(note("G5"), 90, 0.25),
        tone(note("C6"), 90, 0.25),
        tone(note("E6"), 90, 0.25),
        gap(40),
        tone(note("G6"), 160, 0.25),
        tone(note("E6"), 90, 0.25),
        tone(note("G6"), 480, 0.25, decay=3),
    )
    blip = tone(note("A6"), 70, 0.125, 0)
    save("alert-blips", blip, gap(50), blip, gap(160), blip, gap(50), blip)
    save("ping", tone(note("E7"), 600, 0.5, decay=7))
    save("two-tone", tone(note("D6"), 140, 0.25, decay=2), tone(note("A6"), 520, 0.25, decay=5))
    print(f"sounds in {OUT}")


if __name__ == "__main__":
    main()
