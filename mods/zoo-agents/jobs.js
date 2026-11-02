// The zoo's background jobs, run from here since the Zoo view left the zoo layout (2026-11-02):
// each new agent gets a character, and the chosen sounds play when an agent needs you or
// finishes. Copied from mods/zoo/main.js (a mod can't import another's files), which still runs
// them where the zoo itself is shown (the zoo-top layout's strip): keep the two in step.
// volume.js is a copy of the zoo's too.

import { agents, shared, setShared, playSound } from "herdr";
import PACKS from "./sprites.js";
import { play, prepare } from "./volume.js";

const BY = new Map(PACKS.flatMap((p) => p.sprites.map((s) => [`${p.id}/${s.id}`, { ...s, pack: p }])));
const SPRITES = "zoo.sprites";
const NEW = "zoo.packs";
const FIRST = ["cube-pets"];
const packsOn = () => shared(NEW) ?? FIRST;

function pool() {
  const on = new Set(packsOn());
  const keys = [...BY.keys()].filter((k) => on.has(BY.get(k).pack.id));
  return keys.length ? keys : [...BY.keys()];
}

function firstFor(address, keys = pool()) {
  let h = 0;
  for (const c of address) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return keys[h % keys.length];
}

// Gives every agent without one a sprite no other agent has, and remembers it.
function assign(list) {
  let map = shared(SPRITES) ?? {};
  if (shared(NEW) == null) {
    setShared(NEW, FIRST);
    map = Object.fromEntries(Object.entries(map).filter(([, k]) => FIRST.includes(BY.get(k)?.pack.id)));
    setShared(SPRITES, map);
  }
  const keys = pool();
  const taken = new Set(list.map((a) => map[a.address]).filter((k) => BY.has(k)));
  let next = null;
  for (const a of list) {
    if (BY.has(map[a.address])) continue;
    let i = keys.indexOf(firstFor(a.address, keys));
    while (taken.has(keys[i]) && taken.size < keys.length) i = (i + 1) % keys.length;
    taken.add(keys[i]);
    (next ??= { ...map })[a.address] = keys[i];
  }
  if (next) setShared(SPRITES, next);
}

const EVENTS = ["blocked", "done"];
const choiceOf = (id) => {
  const c = shared("zoo.sounds")?.[id] ?? "chime";
  return c === "cry" ? "chime" : c;
};
const volumeOf = (id) => shared("zoo.volume")?.[id] ?? 100;
const fileOf = (choice) => choice.startsWith("file:") ? `mods/zoo/sounds/${choice.slice(5)}` : null;

// Every second: characters for new agents, and a sound for each agent that has just started
// needing you (or finished). Herdr ignores settings.json's sounds (0.1.9), so the choice is played
// here and Herdr's own sounds are off (see the zoo's ♪ dialog). Quieter copies are made ahead
// (volume.js), so a sound plays the moment a status changes.
export function startJobs(cx) {
  let last = null;
  const warmed = new Set();
  cx.timer.every(1000, (cx) => {
    const list = agents();
    assign(list);
    for (const id of EVENTS) {
      const file = fileOf(choiceOf(id)), v = volumeOf(id);
      if (file && !warmed.has(`${file}|${v}`)) {
        warmed.add(`${file}|${v}`);
        cx.spawn(async (cx) => { await prepare(file, [v], cx).catch(() => {}); }, { owner: null });
      }
    }
    const prev = last;
    last = new Map(list.map((a) => [a.address, a.status]));
    if (!prev) return;
    for (const a of list) {
      if (!EVENTS.includes(a.status) || prev.get(a.address) === a.status) continue;
      const choice = choiceOf(a.status), file = fileOf(choice);
      if (choice === "chime") playSound(a.status);
      else if (file) cx.spawn(async (cx) => { await play(file, volumeOf(a.status), cx); }, { owner: null });
    }
  });
}
