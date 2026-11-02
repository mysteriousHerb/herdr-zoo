// Volume for playSound, which has none. An MP3 keeps each granule's loudness in a "global gain"
// field (1.5 dB a step), so a quieter copy is the same file with that number lowered in every
// frame: no decoding, no re-encoding (what mp3gain does). The copies go in data/zoo/volume/,
// made once per file, size and level.
import { readFile, writeFile, mkdir, unlink, exists } from "fs/promises";
import os from "os";
import { appHome, playSound, exec } from "herdr";

const DIR = () => `${appHome()}/data/zoo/volume`;

const KBPS = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
// By the header's version bits: 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5 (1 is reserved).
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function getBits(b, pos, n) {
  let v = 0;
  for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((b[pos >> 3] >> (7 - (pos & 7))) & 1);
  return v;
}

function setBits(b, pos, n, v) {
  for (let i = n - 1; i >= 0; i--, pos++) {
    const m = 1 << (7 - (pos & 7));
    b[pos >> 3] = (v >> i) & 1 ? b[pos >> 3] | m : b[pos >> 3] & ~m;
  }
}

// A copy of the MP3 bytes `steps` × 1.5 dB quieter. Only Layer III frames are touched; a frame
// with a CRC would need it redone (LAME writes none, so they're left alone).
export function quieter(src, steps) {
  const b = new Uint8Array(src);
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) // ID3v2 tag: skip it
    i = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0);
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (b[i + 1] >> 3) & 3;
    const layer3 = ((b[i + 1] >> 1) & 3) === 1;
    const crc = !(b[i + 1] & 1);
    const br = b[i + 2] >> 4, sr = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
    if (ver === 1 || !layer3 || br === 0 || br === 15 || sr === 3) { i++; continue; }
    const mpeg1 = ver === 3;
    const len = Math.floor(((mpeg1 ? 144000 : 72000) * KBPS[mpeg1 ? "mpeg1" : "mpeg2"][br]) / RATES[ver][sr]) + pad;
    const mono = b[i + 3] >> 6 === 3;
    const nch = mono ? 1 : 2;
    // Side info: main_data_begin and private bits (and scfsi in MPEG-1), then per granule and
    // channel: part2_3_length (12), big_values (9), global_gain (8), and the rest.
    let pos = (i + 4) * 8 + (mpeg1 ? 9 + (mono ? 5 : 3) + 4 * nch : 8 + (mono ? 1 : 2));
    const end = pos + (mpeg1 ? 2 * nch * 59 : nch * 63);
    if (!crc && end <= b.length * 8) {
      for (let g = 0; g < (mpeg1 ? 2 : 1) * nch; g++, pos += mpeg1 ? 59 : 63) {
        const gain = getBits(b, pos + 21, 8);
        setBits(b, pos + 21, 8, Math.max(0, gain - steps)); // 0 (e.g. LAME's info frame) stays 0
      }
    }
    i += Math.max(len, 1);
  }
  return b;
}

// 0–100 on the slider; loudness follows its square (100 → 0 dB, 50 → −12 dB, 10 → −40 dB), which
// sounds closer to even steps than a straight line.
export const stepsFor = (volume) => Math.round((-40 * Math.log10(volume / 100)) / 1.5);

const q = (s) => `'${s.replace(/'/g, "''")}'`;

// writeFile(path, Uint8Array) says it worked but writes an empty file (Herdr 0.1.10, tested
// 2026-10-31), so the bytes go as base64 text and one shell call turns them all back into bytes
// (PowerShell takes ~0.8 s to start, hence many files per call).
async function writeAll(jobs) {
  const list = `${DIR()}/batch-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const lines = [];
  for (const { out, bytes } of jobs) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await writeFile(`${out}.b64`, btoa(bin));
    lines.push(`${out}.b64|${out}`);
  }
  await writeFile(list, lines.join("\n") + "\n");
  const r = /^win/.test(os.platform())
    ? await exec("powershell", ["-NoProfile", "-Command",
      `foreach ($l in [IO.File]::ReadAllLines(${q(list)})) { if ($l) { $p = $l.Split('|'); [IO.File]::WriteAllBytes($p[1], [Convert]::FromBase64String([IO.File]::ReadAllText($p[0]))) } }`])
    : await exec("sh", ["-c", 'while IFS="|" read -r a b; do [ -n "$a" ] && base64 -d < "$a" > "$b"; done < "$1"', "sh", list]);
  for (const { out } of jobs) await unlink(`${out}.b64`).catch(() => {});
  await unlink(list).catch(() => {});
  if (r.code !== 0) throw new Error(r.stderr);
}

// Copy for a file at a level, named by the source's size too, so a replaced sound gets new
// copies and an existing copy is never rewritten (it may be playing).
const outOf = (file, size, steps) => `${DIR()}/${steps}-${size}-${file.replace(/[\\/:]/g, "_")}`;
const made = new Map(); // copy path → promise of it being written

// A job cut off halfway (seen when a deploy reloaded the mod) would never settle and leave its
// levels waiting for good; after 10 s it counts as failed, and the next play tries again.
const within = (p, ms, cx) => cx ? Promise.race([p, cx.sleep(ms).then(() => { throw new Error("timed out"); })]) : p;

// Makes `file`'s copies for these volumes ahead of time, in one shell call, so playing them
// later is instant. Resolves to { volume: copy path } (the file itself at full volume).
export async function prepare(file, volumes, cx) {
  const src = await readFile(`${appHome()}/${file}`);
  const paths = {};
  const jobs = [];
  for (const v of volumes) {
    const steps = stepsFor(Math.min(100, v));
    if (!(v > 0) || steps <= 0) { paths[v] = file; continue; }
    const out = outOf(file, src.length, steps);
    paths[v] = out;
    if (!made.has(out) && !jobs.some((j) => j.out === out)) jobs.push({ out, steps });
  }
  if (jobs.length) {
    // Claimed in `made` before any await, so a second call at the same time waits for this one.
    const job = within((async () => {
      const todo = [];
      for (const j of jobs) if (!(await exists(j.out))) todo.push({ out: j.out, bytes: quieter(src, j.steps) });
      if (!todo.length) return;
      await mkdir(DIR(), { recursive: true }).catch(() => {});
      await writeAll(todo);
    })(), 10000, cx).catch((e) => { for (const j of jobs) made.delete(j.out); throw e; });
    for (const j of jobs) made.set(j.out, job);
  }
  await Promise.all(Object.values(paths).map((p) => made.get(p)));
  return paths;
}

// Every level the slider stops at.
export const LEVELS = Array.from({ length: 21 }, (_, i) => i * 5);

// Plays `file` (relative to ~/.config/herdr-app) at `volume` (0–100); `cx` (a task's) times it.
export async function play(file, volume, cx) {
  if (!(volume > 0)) return;
  try {
    playSound((await prepare(file, [volume], cx))[volume]);
  } catch {
    playSound(file); // couldn't make the copy: at full volume rather than not at all
  }
}
