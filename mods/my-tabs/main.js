// Clone of Herdr's `tabs`; changes: + opens `my-new-menu` instead of `new-menu`, props
// { buttons: false } leaves out the window buttons (when a bar above has them), and a right-click
// on a tab with an agent opens the zoo's agent menu (the one the zoo and the agents list open); the × on a tab with an agent asks first.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, terminals, focused, run, openOverlay, theme, window, shared, setShared, layout, settings, props, knownAgents } from "herdr";
import PACKS from "./sprites.js";

// Every sprite by key "<pack>/<id>" (sprites.js, the zoo's catalog; scripts/make_packs.py).
const BY = new Map(PACKS.flatMap((p) => p.sprites.map((s) => [`${p.id}/${s.id}`, { ...s, pack: p }])));
const STATE = { working: "work", blocked: "blocked", done: "done", idle: "idle" };

// A tab with an agent shows its character (shared "zoo.sprites", as zoo-agents draws it) instead
// of the program's icon; idle = gray and still, so an idle tab bar doesn't keep Herdr redrawing.
// Until the zoo assigns one: the first of the packs new agents get (copied from the zoo).
function creature(a, box) {
  let key = shared("zoo.sprites")?.[a.address];
  if (!BY.has(key)) {
    const on = new Set(shared("zoo.packs") ?? ["cube-pets"]);
    let keys = [...BY.keys()].filter((k) => on.has(BY.get(k).pack.id));
    if (!keys.length) keys = [...BY.keys()];
    let h = 0;
    for (const c of a.address) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    key = keys[h % keys.length];
  }
  const s = BY.get(key);
  const scale = box / Math.max(s.w, s.h);
  const st = shownStatus(a);
  const file = (s.pack.files[STATE[ANIM[st] ?? st] ?? "work"] ?? s.pack.files.done).replace("{id}", s.id);
  return h_flex().w(box).h(box).flex_none().items_center().justify_center()
    .child(image(file).w(Math.round(s.w * scale)).h(Math.round(s.h * scale)));
}

// A tab Herdr named after its program ("Claude Code", or an automatic "tbN") shows the agent's
// own title instead, as the agents list does (`title` in zoo-agents): unless that title is
// only a path, a user@host, or the program's name again. A tab someone renamed keeps its name.
// "Named after its program" = the pane's program name, or any + menu entry's (`LAUNCHERS`): a
// "Claude (dev container)" tab runs a pane whose program reports "Claude Code" (seen 2026-11-05).
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const LAUNCHERS = new Set();
function loadLaunchers(cx) {
  cx.spawn(async () => { for (const k of await knownAgents()) LAUNCHERS.add(k.name); });
}
function tabName(c, lead) {
  const prog = lead?.program?.name;
  const live = clean(lead?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== lead?.program?.key;
  const auto = /^tb\d+$/.test(c.name);
  if ((auto || c.name === prog || LAUNCHERS.has(c.name)) && telling) return live;
  return auto ? prog ?? "Terminal" : c.name;
}

// Unread vs done: shared "zoo.turns" = { address: "run" | "seen" }; Herdr's done = unread until
// the agent is shown with the window active (the Chat view hides the terminal, so Herdr never
// sees you read it), idle after a turn = done. Copied from zoo-agents (the why is there): keep them in step.
const machineOf = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
function trackTurns(list, all) {
  const was = shared("zoo.turns") ?? {};
  let next = null;
  const set = (k, v) => { if (was[k] !== v) (next ??= { ...was })[k] = v; };
  const looking = window()?.active ? focused()?.agent : null;
  for (const a of list) {
    if (a.status === "working" || a.status === "blocked") set(a.address, "run");
    else if (a.status === "done" && a.address === looking) set(a.address, "seen");
  }
  const heard = new Set(all.map((k) => machineOf(k.address)));
  const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
  for (const k of Object.keys(next ?? was)) if (heard.has(machineOf(k)) && !live.has(k)) delete (next ??= { ...was })[k];
  if (next) setShared("zoo.turns", next);
}
function shownStatus(a) {
  const v = shared("zoo.turns")?.[a.address];
  if (a.status === "done") return v === "seen" ? "done" : "unread";
  if (a.status === "idle") return v ? "done" : "idle";
  return a.status;
}
const RANK = { blocked: 5, unread: 4, working: 3, done: 2, idle: 1 };
// The character's animation for a shown status: unread nods (Herdr's done), read ones idle.
const ANIM = { unread: "done", done: "idle" };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    loadLaunchers(cx);
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // The × on a tab: one with an agent asks first (the shipped `confirm` dialog), since a closed
  // tab can't be reopened. Other tabs close at once, as in Herdr's own `tabs`.
  close(c, name, space) {
    const mine = agents().filter(a => a.tab === c.id);
    if (!mine.length) return run("tab.close", { id: c.id });
    const state = mine.some(a => a.status === "working") ? "is still working"
      : mine.some(a => a.status === "blocked") ? "is waiting for you" : null;
    const who = mine.length > 1 ? `${mine.length} agents` : "its agent";
    openOverlay({
      mod: "confirm", kind: "dialog", width: 440, height: 180,
      props: {
        title: `Close ${name}?`,
        detail: `${space.name} · ${name}${state ? ` ${state}` : ""}. Closing the tab ends ${who} and it can't be reopened here. A Claude conversation stays saved: claude --resume brings it back.`,
        command: { name: "tab.close", args: { id: c.id } },
      },
    });
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    trackTurns(agents(), terminals());
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = tabName(c, lead);
      const mine = agents().filter(a => a.tab === c.id), agent = mine.find(a => a.focused) ?? mine[0];
      // The tab's status: its most urgent agent's shown one (terminal-only tabs: Herdr's).
      const st = mine.length ? mine.map(shownStatus).reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m)) : c.status === "done" ? "unread" : c.status;
      // Chrome-style: a tab is as wide as its content (up to 200, active 240) and the others
      // shrink together as tabs are added, down to the character (+ status); the active one keeps its name.
      return h_flex().id(`tab-${c.id}`).h(29).px(8).gap(6).rounded(7).items_center().overflow_hidden()
        .max_w(c.active ? 240 : 200).flex_shrink(c.active ? 0 : 1).min_w(c.active ? 0 : 60).text_size(12.8).tooltip(name)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", () => {
          const mine = agents().filter(a => a.tab === c.id);
          const a = mine.find(a => a.focused) ?? mine[0];
          if (a) openOverlay({ mod: "zoo", kind: "popup", width: 220, height: 205, props: { menu: a.address, title: `${space.name} · ${name}` } });
          else openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } });
        })
        .when(Boolean(agent), el => el.child(creature(agent, 20)))
        .when(!agent && Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).flex_none().text_color(t.muted) : image(program.icon).size(14).flex_none()))
        .child(div().flex_1().min_w(0).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        // Blocked and unread: a dot; finished and read: a gray tick.
        .when(st === "blocked" || st === "unread", el => el.child(div().size(6).flex_none().rounded(3).bg(st === "unread" ? t.accent : t.blocked)))
        .when(st === "done", el => el.child(svg("mods/workspace-chrome/check.svg").size(11).flex_none().text_color(t.done ?? t.dim)))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.close(c, name, space); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_hidden().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "my-new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(window()?.buttons && props()?.buttons !== false, el => el.child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
