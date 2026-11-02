// Agents as creatures in a zoo. Working ones bash out code (their verb in the bubble),
// blocked ones jump up and down for you, done ones look pleased, idle ones idle (faded).
// Most urgent first, as in the agents list. Click one to go to its agent; right-click for a
// menu (pick its character, close the agent); ♪ picks the sounds. The characters come in
// packs (sprites.js, made by scripts/make_packs.py): Kenney's Cube Pets, Blocky and Mini
// Characters, all CC0. The sounds/ effects are original.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, SliderState, Slider, SliderTrack, SliderIndicator, SliderThumb } from "gpui-base";
import { readdir } from "fs/promises";
import os from "os";
import { agents, spaces, panes, hc, exec, notify, run, theme, setAgentOrder, shared, setShared, openOverlay, closeOverlay, props, playSound, appHome, readTextFile, writeTextFile } from "herdr";
import PACKS from "./sprites.js";
import { play, prepare, LEVELS } from "./volume.js";

const CODE = ["{ }", "</>", "=>", "&&", "fn()", "!=", "[ ]", "++", ";;"];
// The sprite's room in a pen: BOX tall, WIDE across.
const BOX = 68;
const WIDE = 110;
const PICK_BOX = 44;
// The isometric tile under each one (scripts/make_tiles.py); each sprite names its own
// (grass, water, sky = a cloud).
const TILE = { w: 80, h: 50, feet: 26 };
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// An agent's name as the agents list shows it (copied from zoo-agents; a mod can't import
// another's): the tab's name if someone named it, else the agent's own title, else its program.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all) {
  const mine = all.filter((p) => p.tab === tab.id && p.terminal);
  return mine.find((p) => p.program?.agent) ?? mine.find((p) => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}

function nameOf(a, tabs, all) {
  const tab = tabs.find((tab) => tab.id === a.tab);
  const name = tab ? title(tab, lead(tab, all)) : a.title || a.program?.name || "";
  return /^\d+$/.test(name) ? a.program?.name || name : name;
}

// Claude's working line: "✻ Galloping… (4s · ↓ 109 tokens)".
const VERB = /^\s*\S\s+([A-Z][\w-]*…)\s*\(/gm;
// Every sprite by key "<pack>/<id>", with its pack.
const BY = new Map(PACKS.flatMap((p) => p.sprites.map((s) => [`${p.id}/${s.id}`, { ...s, pack: p }])));
// Each agent's sprite key, by address. Shared, so the zoo-agents list shows the same ones.
const SPRITES = "zoo.sprites";
// The packs new agents get their sprite from (shared, ticked in the picker); Cube Pets at first
// (the user's pick: the cutest, and all the same size).
const NEW = "zoo.packs";
const FIRST = ["cube-pets"];
const packsOn = () => shared(NEW) ?? FIRST;

function setPackOn(id, on) {
  const now = new Set(packsOn());
  if (on) now.add(id); else now.delete(id);
  setShared(NEW, PACKS.map((p) => p.id).filter((p) => now.has(p)));
}

// The sprites a new agent can get, in catalog order (all of them if no pack is ticked).
function pool() {
  const on = new Set(packsOn());
  const keys = [...BY.keys()].filter((k) => on.has(BY.get(k).pack.id));
  return keys.length ? keys : [...BY.keys()];
}

// A new agent's first choice: the same address always starts from the same sprite.
function firstFor(address, keys = pool()) {
  let h = 0;
  for (const c of address) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return keys[h % keys.length];
}

const spriteOf = (address) => {
  const k = shared(SPRITES)?.[address];
  return BY.has(k) ? k : firstFor(address);
};

// Gives every agent without one a sprite no other agent has, and remembers it.
function assign(list) {
  // Once, while no packs were ever ticked: agents from other packs start over in Cube Pets.
  // Ticking `zoo.packs` makes it stick, so a character picked by hand later stays.
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
  return next ?? map;
}

// Gives `address` sprite `key`; an agent that had it gets the old one in exchange.
function pick(address, key) {
  const map = { ...(shared(SPRITES) ?? {}) };
  const other = agents().find((a) => a.address !== address && map[a.address] === key);
  if (other) map[other.address] = map[address];
  map[address] = key;
  setShared(SPRITES, map);
}

// The two sounds, each a choice: "chime" (Herdr's), "silent", or "file:<name>" from
// mods/zoo/sounds/. (An old saved "cry" choice reads as the chime.)
const EVENTS = [
  { id: "blocked", label: "When an agent needs you", fallback: "chime" },
  { id: "done", label: "When an agent finishes", fallback: "chime" },
];
const choiceOf = (event) => {
  const c = shared("zoo.sounds")?.[event.id] ?? event.fallback;
  return c === "cry" ? "chime" : c;
};

// What settings.json's sounds.<event> becomes. Herdr 0.1.9 ignores it (see alerts()), but it's
// kept in step so the choice is there once Herdr honors it.
function settingFor(choice) {
  if (choice === "chime") return undefined;
  if (choice.startsWith("file:")) return `mods/zoo/sounds/${choice.slice(5)}`;
  return "mods/zoo/silent.mp3";
}

async function choose(event, choice) {
  setShared("zoo.sounds", { ...(shared("zoo.sounds") ?? {}), [event]: choice });
  const path = `${appHome()}/settings.json`;
  // writeTextFile refuses if the file changed since it was read: read it again once.
  for (let tries = 0; tries < 2; tries++) {
    const text = await readTextFile(path);
    const s = JSON.parse(text ?? "{}");
    s.sounds = { ...(s.sounds ?? {}), enabled: false };
    const value = settingFor(choice);
    if (value === undefined) delete s.sounds[event];
    else s.sounds[event] = value;
    try {
      await writeTextFile(path, JSON.stringify(s, null, 2) + "\n", text);
      return;
    } catch {}
  }
}

// Each sound's volume, 0–100 (shared "zoo.volume"). Herdr's chime has none: it plays as it is.
const volumeOf = (id) => shared("zoo.volume")?.[id] ?? 100;

// The MP3 a file choice plays.
const fileOf = (choice) => choice.startsWith("file:") ? `mods/zoo/sounds/${choice.slice(5)}` : null;

// Plays a file choice at `volume`.
function sound(choice, volume, cx) {
  const file = fileOf(choice);
  if (file) cx.spawn(async (cx) => { await play(file, volume, cx); }, { owner: null });
}

// Makes a choice's quieter copies ahead (one slow shell call), so playing it is instant.
function warm(choice, volumes, cx) {
  const file = fileOf(choice);
  if (file) cx.spawn(async (cx) => { await prepare(file, volumes, cx).catch(() => {}); }, { owner: null });
}

// An agent status's animation: work, blocked, done, or idle (gray and still: anything
// animating on screen makes Herdr redraw the whole window).
const STATE = { working: "work", blocked: "blocked", done: "done", idle: "idle" };

// The sprite `key` in `state`, scaled to fit `box` tall and `wide` across without stretching.
function sprite(key, box, state = "done", wide = box) {
  const s = BY.get(key) ?? BY.values().next().value;
  const scale = Math.min(1.5, box / s.h, wide / s.w);
  const file = (s.pack.files[state] ?? s.pack.files.done).replace("{id}", s.id);
  return image(file).w(Math.round(s.w * scale)).h(Math.round(s.h * scale));
}

// props {stack, other}: a sidebar stack this list shares with the zoo (or the zoo with the list);
// the header's "Agents  Zoo" flips it. Without them, just the label.
function viewSwitch(t, here) {
  const p = props();
  const tab = (id, label) => div()
    .id(`view-${id}`)
    .text_size(11.5)
    .font_medium()
    .text_color(id === here ? t.foreground : t.dim)
    .when(id !== here, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click(() => run("layout.select", { stack: p.stack, child: p.other })))
    .child(label);
  if (!p?.stack) return div().text_size(11.5).font_medium().text_color(t.dim).child(here === "zoo" ? "Zoo" : "Agents");
  return h_flex().gap(10).child(tab("list", "Agents")).child(tab("zoo", "Zoo"));
}

export default class Zoo extends View {
  init(_props, cx) {
    if (props()?.pick || props()?.menu) return;
    if (props()?.sounds) {
      this.files = [];
      // A volume slider per sound: the % follows the drag (a redraw only when it changes), letting
      // go saves it and plays it. Every level of the chosen sounds is made now, so that's instant.
      this.vol = {};
      for (const ev of EVENTS) {
        const s = SliderState.new({ min: 0, max: 100, step: 5, value: volumeOf(ev.id) });
        let shown = s.value();
        s.on("change", (v, cx) => { if (v !== shown) { shown = v; cx.notify(); } });
        s.on("release", (v, cx) => {
          setShared("zoo.volume", { ...(shared("zoo.volume") ?? {}), [ev.id]: v });
          sound(choiceOf(ev), v, cx);
        });
        this.vol[ev.id] = s;
        warm(choiceOf(ev), LEVELS, cx);
      }
      cx.spawn(async (cx) => {
        this.files = (await readdir(`${appHome()}/mods/zoo/sounds`).catch(() => [])).filter((f) => /\.mp3$/i.test(f)).sort();
        cx.notify();
      });
      return;
    }
    // The verb each working agent is showing on its screen, read every 2 s.
    this.verbs = {};
    cx.timer.every(2000, (cx) => this.readVerbs(cx));
    // Each agent's status at the last look; null until the first, so a start makes no noise.
    this.last = null;
    // Also looked at on a timer: behind the agents list (a stack) the zoo isn't rendered, but still
    // gives new agents their character and plays the sounds.
    cx.timer.every(1000, (cx) => { assign(agents()); this.alerts(agents(), cx); });
  }

  // An agent that has just started needing you (or finished) plays the chosen sound: a file
  // or Herdr's chime. Herdr 0.1.9 ignores settings.json's sounds.done and
  // sounds.blocked (it always plays its chime), so the zoo plays them all itself and Herdr's own
  // sounds are switched off (sounds.enabled: false; its corner notes still show).
  alerts(list, cx) {
    // The sounds at the set volume are made ahead, so they play the moment a status changes.
    this.warmed ??= new Set();
    for (const ev of EVENTS) {
      const choice = choiceOf(ev), v = volumeOf(ev.id);
      const key = `${fileOf(choice)}|${v}`;
      if (fileOf(choice) && !this.warmed.has(key)) { this.warmed.add(key); warm(choice, [v], cx); }
    }
    const prev = this.last;
    this.last = new Map(list.map((a) => [a.address, a.status]));
    if (!prev) return;
    for (const a of list) {
      for (const ev of EVENTS) {
        if (a.status !== ev.id || prev.get(a.address) === ev.id) continue;
        const choice = choiceOf(ev);
        if (choice === "chime") playSound(ev.id);
        else sound(choice, volumeOf(ev.id), cx);
      }
    }
  }

  // The dialog ♪ opens: a column of choices per sound, each with a preview.
  soundsDialog(t) {
    const options = [
      { id: "chime", label: "Herdr's chime" },
      ...this.files.map((f) => ({ id: `file:${f}`, label: f.replace(/\.mp3$/i, "") })),
      { id: "silent", label: "Silent" },
    ];
    const volume = (ev, on) => {
      const s = this.vol[ev.id];
      const chime = on === "chime";
      return h_flex().id(`vol-${ev.id}`).px(8).pb(6).gap(8).items_center()
        .tooltip(chime ? "Herdr's chime plays at its own volume" : "Volume")
        .child(div().text_size(11).text_color(t.dim).child("Volume"))
        .child(Slider.new(s).flex_1().min_w(0).child(SliderTrack.new(s).flex().items_center().h(20).w_full().cursor_pointer().child(
          SliderIndicator.new(s).relative().w_full().h(4).rounded(2).bg(t.input)
            .range_style((fill) => fill.rounded(2).bg(chime ? t.dim : t.accent))
            .child(SliderThumb.new(s).size(12).rounded(6).bg(chime ? t.dim : t.accent).ml(-6).mt(-4)))))
        .child(div().w(34).flex_none().text_right().text_size(11).text_color(t.dim).child(`${Math.round(s.value())}%`));
    };
    const column = (ev) => {
      const on = choiceOf(ev);
      return v_flex().flex_1().min_w(0).gap(2)
        .child(div().px(8).pb(4).text_size(11.5).font_medium().text_color(t.dim).child(ev.label))
        .child(volume(ev, on))
        .children(options.map((o) => h_flex()
          .id(`${ev.id}-${o.id}`)
          .h(30)
          .px(8)
          .gap(9)
          .rounded(7)
          .items_center()
          .cursor_pointer()
          .when(o.id === on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            sound(o.id, volumeOf(ev.id), cx);
            warm(o.id, LEVELS, cx);
            cx.spawn(async () => { await choose(ev.id, o.id); });
          })
          .child(div().size(12).flex_none().rounded(6).border(1.5).border_color(o.id === on ? t.accent : t.input)
            .when(o.id === on, (el) => el.bg(t.accent)))
          .child(div().flex_1().truncate().text_color(t.foreground).child(o.label))
          .when(o.id.startsWith("file:"), (el) => el.child(div()
            .id(`play-${ev.id}-${o.id}`)
            .px(6)
            .rounded(4)
            .text_size(11)
            .text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Preview")
            .on_click((_e, cx) => { cx.stop_propagation(); sound(o.id, volumeOf(ev.id), cx); })
            .child("▶")))));
    };
    return v_flex()
      .size_full()
      .bg(t.popover)
      .p(14)
      .gap(12)
      .text_size(13)
      .child(div().px(8).font_semibold().text_color(t.foreground).child("Zoo sounds"))
      .child(v_flex().id("zoo-sound-list").flex_1().min_h(0).overflow_y_scrollbar()
        .child(h_flex().items_start().gap(14).children(EVENTS.map(column))))
      .child(div().px(8).text_size(11).text_color(t.dim)
        .child("Drop MP3s into ~/.config/herdr-app/mods/zoo/sounds/ to add your own. The zoo plays these itself, so only in the Zoo layout (Herdr ignores its own sound settings for now)."));
  }

  readVerbs(cx) {
    cx.spawn(async (cx) => {
      let changed = false;
      for (const a of agents().filter((a) => a.status === "working")) {
        const r = await hc(["read", a.address]).catch(() => null);
        const verb = [...(r?.stdout ?? "").matchAll(VERB)].at(-1)?.[1] ?? null;
        if (verb !== (this.verbs[a.address] ?? null)) { this.verbs[a.address] = verb; changed = true; }
      }
      if (changed) cx.notify();
    });
  }

  bubble(t, a) {
    const status = a.status;
    const base = div().h(22).max_w(120).px(8).rounded(11).flex().items_center().truncate().text_size(11).font_semibold();
    if (status === "working") {
      const verb = this.verbs[a.address];
      // Agents that don't print a Claude-style verb get the code symbols.
      return base.bg(t.working + "26").text_color(t.working).when(Boolean(verb), (el) => el.child(verb)).when(!verb, (el) => el.frames(CODE, 220));
    }
    if (status === "blocked") return base.bg(t.blocked + "33").text_color(t.blocked).loop("opacity", { from: 0.4, to: 1, period: 700 }).child("needs you!");
    if (status === "done") return base.bg(t.done + "26").text_color(t.done).child("✓ done");
    return base.text_color(t.dim).child("zZz");
  }

  animal(a, key) {
    const el = div().relative().child(sprite(key, BOX, STATE[a.status] ?? "work", WIDE));
    if (a.status === "blocked") return el.loop("top", { from: 0, to: -10, period: 520 });
    // Packs with their own done animation (a dance, the weapon held up) don't need the bob.
    if (a.status === "done" && BY.get(key)?.pack.bob !== false) return el.loop("top", { from: 0, to: -3, period: 1600 });
    if (a.status === "idle") return el.opacity(0.6);
    return el;
  }

  // How many sub-agents this agent has at work (claude-chat shares them as "chat.subs"): a dot
  // and the number, in the pen's top corner.
  helpers(t, n) {
    const ball = div().size(7).flex_none().rounded(4).bg(t.working);
    return h_flex().absolute().top(0).right(6).h(18).px(5).gap(4).items_center().rounded(9)
      .bg(t.background).border(1).border_color(t.working).text_size(10.5).font_semibold().text_color(t.working)
      .child(ball).child(String(n));
  }

  pen(t, a, key, name, w = 128) {
    const subs = shared("chat.subs")?.[a.address] ?? 0;
    return v_flex()
      .id(`pen-${a.address}`)
      .w(w)
      .flex_none()
      .py(8)
      .gap(4)
      .items_center()
      .rounded(12)
      .when(a.focused, (el) => el.bg(t.selected))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(`${BY.get(key)?.name ?? key}${subs ? ` · ${subs} sub-agent${subs === 1 ? "" : "s"} working` : ""} · right-click for more`)
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .on_mouse_down("right", () => openOverlay({
        mod: "zoo", kind: "popup", width: 220, height: 205,
        props: { menu: a.address, title: `${a.space_name} · ${name}` },
      }))
      .child(this.bubble(t, a))
      .child(h_flex().relative().w_full().h(BOX + TILE.feet).items_end().justify_center()
        .child(image(`mods/zoo/tiles/${BY.get(key)?.tile ?? "grass"}.png`).absolute().bottom(0).left((w - TILE.w) / 2).w(TILE.w).h(TILE.h)
          .when(a.status === "idle", (el) => el.opacity(0.5)))
        .child(div().mb(TILE.feet).child(this.animal(a, key)))
        .when(subs > 0, (el) => el.child(this.helpers(t, subs))))
      .child(div().w_full().px(6).text_center().truncate().text_size(12).text_color(t.foreground).child(name || a.address))
      .child(div().w_full().px(6).text_center().truncate().text_size(10.5).text_color(t.foreground).child(a.space_name || a.address));
  }

  // The popup a right-click on an agent opens (zoo pens, the agents list, the tab bar): rename it
  // (its tab, which the lists show; Herdr asks for the name), pick its character, or close it (its
  // pane). One that's still working or waiting on you asks first.
  menu(t) {
    const { menu: address, title, overlay } = props();
    const a = agents().find((a) => a.address === address);
    const close = () => {
      const command = a?.pane ? { name: "pane.close", args: { pane: a.pane } } : { name: "terminal.kill", args: { terminal: address } };
      if (a?.status === "working" || a?.status === "blocked") {
        openOverlay({
          mod: "confirm", kind: "dialog", width: 420, height: 160,
          props: { title: "Close this agent?", detail: `${title} is ${a.status === "working" ? "still working" : "waiting for you"}. Closing it ends its terminal.`, command },
        });
      } else run(command.name, command.args);
    };
    // Its folder: where its terminal is now, else its space's. Opened on this computer only.
    const open = (what) => {
      const space = spaces().find((s) => s.id === a?.space);
      const folder = panes().find((p) => p.terminal === address)?.cwd || space?.folder || "";
      if (space?.machine) return notify({ title: "Not on this computer", body: `${title} runs on ${space.machine}.`, level: "warning" });
      if (!folder) return notify({ title: "No folder known", body: title, level: "warning" });
      const win = /^win/.test(os.platform()); // "windows" here, not node's "win32"
      const [cmd, args] = what === "code"
        ? (win ? ["cmd", ["/c", "code", folder]] : ["code", [folder]]) // code is code.cmd on Windows
        // Not explorer itself: exec starts programs hidden, and so is the window explorer opens.
        : (win ? ["cmd", ["/c", "start", "", folder.replace(/\//g, "\\")]] : [os.platform() === "darwin" ? "open" : "xdg-open", [folder]]);
      exec(cmd, args).then(
        (r) => { if (what === "code" && r.code) notify({ title: "Couldn't open VS Code", body: (r.stderr || r.stdout).trim() || "Is `code` on the PATH?", level: "error" }); },
        (e) => notify({ title: `Couldn't run ${cmd}`, body: String(e), level: "error" }));
    };
    const item = (id, pic, label, act) => h_flex()
      .id(id)
      .h(31)
      .px(8)
      .gap(9)
      .rounded(7)
      .items_center()
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .on_click(() => { closeOverlay(overlay); act(); })
      .child(h_flex().size(16).flex_none().items_center().justify_center().child(pic))
      .child(div().flex_1().child(label));
    const icon = (name) => svg(`mods/workspace-chrome/${name}.svg`).size(14).text_color(t.muted);
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).truncate().text_size(11).text_color(t.dim).child(title ?? address))
      .when(Boolean(a?.tab), (el) => el.child(item("menu-rename", icon("square-pen"), "Rename", () => run("tab.rename", { id: a.tab }))))
      .child(item("menu-pick", sprite(spriteOf(address), 16), "Change character…", () => openOverlay({
        mod: "zoo", kind: "dialog", width: 740, height: 580, props: { pick: address, title },
      })))
      .child(item("menu-folder", icon("folder"), "Open folder", () => open("folder")))
      .child(item("menu-code", icon("file-text"), "Open in VS Code", () => open("code")))
      .child(item("menu-close", icon("x"), "Close agent", close));
  }

  // The dialog "Change character…" opens: a tab per pack, its sprites in a grid; the current one
  // marked, others' dimmed (picking one swaps). The tick on a tab: new agents get that pack.
  picker(t) {
    const { pick: address, title, overlay } = props();
    const list = agents();
    const map = shared(SPRITES) ?? {};
    const mine = spriteOf(address);
    this.tab ??= BY.get(mine)?.pack.id ?? PACKS[0].id;
    const pack = PACKS.find((p) => p.id === this.tab) ?? PACKS[0];
    const on = new Set(packsOn());
    const owners = new Map(list.filter((a) => a.address !== address && map[a.address]).map((a) => [map[a.address], a.space_name || a.address]));
    const cell = (s) => {
      const key = `${pack.id}/${s.id}`;
      return v_flex()
        .id(`pick-${key}`)
        .w(64)
        .h(74)
        .p(4)
        .gap(2)
        .items_center()
        .justify_end()
        .rounded(8)
        .when(key === mine, (el) => el.bg(t.selected).border(1).border_color(t.accent))
        .hover((st) => st.bg(t.hover))
        .cursor_pointer()
        .when(owners.has(key), (el) => el.tooltip(`${s.name} · ${owners.get(key)}'s; picking it swaps`))
        .on_click(() => { pick(address, key); closeOverlay(overlay); })
        .child(h_flex().h(PICK_BOX).items_end().when(owners.has(key), (el) => el.opacity(0.4)).child(sprite(key, PICK_BOX, "done", 56)))
        .child(div().w_full().text_center().truncate().text_size(9.5).text_color(key === mine ? t.foreground : t.muted).child(s.name));
    };
    const tab = (p) => h_flex()
      .id(`pack-${p.id}`)
      .h(30)
      .pl(6)
      .pr(10)
      .gap(6)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(p.id === pack.id, (el) => el.bg(t.selected))
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.tab = p.id; cx.notify(); })
      .child(div()
        .id(`new-${p.id}`)
        .size(14)
        .flex_none()
        .rounded(3)
        .border(1.5)
        .border_color(on.has(p.id) ? t.accent : t.input)
        .when(on.has(p.id), (el) => el.bg(t.accent))
        .tooltip(on.has(p.id) ? "New agents can get these (click to stop)" : "New agents don't get these (click to allow)")
        .on_click((_e, cx) => { cx.stop_propagation(); setPackOn(p.id, !on.has(p.id)); cx.notify(); }))
      .child(div().text_color(p.id === pack.id ? t.foreground : t.muted).child(`${p.name}`))
      .child(div().text_size(11).text_color(t.dim).child(String(p.sprites.length)));
    return v_flex()
      .size_full()
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().px(16).h(44).flex_none().gap(8).items_center()
        .child(div().font_semibold().text_color(t.foreground).child("Pick a character"))
        .child(div().flex_1().truncate().text_color(t.dim).child(title ?? address)))
      .child(h_flex().px(10).pb(6).flex_none().gap(4).items_center().children(PACKS.map(tab)))
      .child(div().id(`pick-grid-${pack.id}`).flex_1().min_h(0).px(10).pb(6).flex().flex_wrap().content_start().gap(2).overflow_y_scrollbar()
        .children(pack.sprites.map(cell)))
      .child(div().px(16).pb(10).flex_none().text_size(11).text_color(t.dim).child(pack.credit));
  }

  render(cx) {
    const t = theme();
    if (props()?.pick) return this.picker(t);
    if (props()?.menu) return this.menu(t);
    if (props()?.sounds) return this.soundsDialog(t);
    // Needs you, done, working, idle; the most recently changed first within each.
    const list = [...agents()].sort((x, y) => RANK[y.status] - RANK[x.status] || y.seq - x.seq);
    const map = assign(list);
    this.alerts(list, cx);
    setAgentOrder(list.map((a) => a.address));
    const tabs = spaces().flatMap((s) => s.tabs);
    const all = panes();
    const empty = (el) => el.child(div().p(12).text_size(12).text_color(t.dim).child("The zoo is empty. Start an agent from the + in the tab bar."));
    const sounds = div()
      .id("zoo-sounds")
      .px(8)
      .py(4)
      .rounded(6)
      .text_size(14)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Sounds")
      .on_click(() => openOverlay({ mod: "zoo", kind: "dialog", width: 560, height: 640, props: { sounds: true } }))
      .child("♪");
    // props {side}: the sidebar's agents list, two pens a row under a header like Herdr's "Agents".
    if (props()?.side) return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(h_flex().px(16).pr(8).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(viewSwitch(t, "zoo"))
        .child(sounds))
      .child(div().id("zoo-pens").flex_1().min_h(0).px(8).pb(10).flex().flex_wrap().content_start().justify_center().gap(4).overflow_y_scrollbar()
        .when(list.length === 0, empty)
        .children(list.map((a) => this.pen(t, a, map[a.address], nameOf(a, tabs, all), 122))));
    return v_flex()
      .size_full()
      .bg(t.chrome)
      .rounded(10)
      .border(1)
      .border_color(t.border)
      .child(h_flex().flex_1().min_h(0)
        .child(h_flex().id("zoo-pens").flex_1().min_w(0).h_full().px(10).py(6).gap(6).items_end().overflow_x_scrollbar()
          .when(list.length === 0, empty)
          .children(list.map((a) => this.pen(t, a, map[a.address], nameOf(a, tabs, all)))))
        .child(sounds.self_start().m(8)));
  }
}
