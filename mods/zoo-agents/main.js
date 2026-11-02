// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";
import PACKS from "./sprites.js";
import { startJobs } from "./jobs.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Every sprite by key "<pack>/<id>" (sprites.js, the zoo's catalog; scripts/make_packs.py).
const BY = new Map(PACKS.flatMap((p) => p.sprites.map((s) => [`${p.id}/${s.id}`, { ...s, pack: p }])));
const STATE = { working: "work", blocked: "blocked", done: "done", idle: "idle" };

// The agent's character as the zoo mod assigned it (shared "zoo.sprites"); until then the
// first one of the packs new agents get, as the zoo picks it (copied from there).
function spriteKey(address) {
  const k = shared("zoo.sprites")?.[address];
  if (BY.has(k)) return k;
  const on = new Set(shared("zoo.packs") ?? ["cube-pets"]);
  let keys = [...BY.keys()].filter((k) => on.has(BY.get(k).pack.id));
  if (!keys.length) keys = [...BY.keys()];
  let h = 0;
  for (const c of address) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return keys[h % keys.length];
}

// Its animation for the agent's status; idle is gray and still, as in the zoo (an animation keeps
// Herdr redrawing the window).
function creature(address, box, status) {
  const s = BY.get(spriteKey(address));
  const scale = box / Math.max(s.w, s.h);
  const file = (s.pack.files[STATE[status] ?? "work"] ?? s.pack.files.done).replace("{id}", s.id);
  return h_flex().w(box).h(box).flex_none().items_center().justify_center()
    .child(image(file).w(Math.round(s.w * scale)).h(Math.round(s.h * scale)));
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

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    cx.timer.every(30000, (cx) => cx.notify());
    // New agents' characters and the ♪ sounds (the Zoo view used to do this; jobs.js).
    startJobs(cx);
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Drag to reorder, as Herdr's spaces list does it (press, move, release; no drag API).
  // `key` names this element; `me` is what pressing it drags ({kind, pos, ...}) or null;
  // `aim(drag)` is where that drag lands with the pointer here ({key, pos, drop}) or null.
  // The accent line is drawn on the landing element, under it when moving down.
  dnd(el, t, key, me, aim) {
    const d = this.drag;
    const o = this.over;
    return el
      .relative()
      .when(Boolean(d && d.key === key && o && o.key !== key), (el) => el.opacity(0.5))
      .when(Boolean(d && o && o.key === key && d.key !== key), (el) => el.child(
        div().absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
          .when(d.pos < o.pos, (line) => line.bottom(0))
          .when(d.pos > o.pos, (line) => line.top(0)),
      ))
      .when(Boolean(me), (el) => el.on_mouse_down("left", () => {
        this.drag = { key, ...me };
        this.over = null;
      }))
      .on_mouse_move((_e, cx) => {
        if (!this.drag) return;
        const over = aim(this.drag);
        if ((over?.key ?? null) !== (this.over?.key ?? null)) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.drag;
        const over = from && aim(from);
        this.drag = null;
        this.over = null;
        if (over && over.key !== from.key) over.drop(from);
        cx.notify();
      });
  }

  endDrag(cx) {
    if (!this.drag && !this.over) return;
    this.drag = null;
    this.over = null;
    cx.notify();
  }

  // Where a dragged space header lands with the pointer on space `id`'s header or rows:
  // spaces move only within their machine (space.move).
  spaceAim(id) {
    return (d) => {
      if (d.kind !== "space") return null;
      const sp = spaces();
      const i = sp.findIndex((s) => s.id === id);
      if (i < 0 || (sp[i].machine ?? null) !== d.machine) return null;
      return { key: `sp-${id}`, pos: i, drop: (d) => run("space.move", { id: d.id, index: i + 1 }) };
    };
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.prunePins(all);
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    // Puts pin `from` where `to` is (after it when moving down); pins not shown keep their place at the end.
    const movePin = (from, to) => {
      const shown = pinned.map((a) => a.address);
      const order = shown.filter((p) => p !== from);
      order.splice(shown.indexOf(to), 0, from);
      this.setPins([...order, ...this.pins.filter((p) => !shown.includes(p))]);
    };

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = creature(a.address, 24, a.status);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = this.pins.includes(a.address);
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.setPins(isPinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      // It reads "agent · space": the agent's name first (it shortens when the row is
      // short), the space after it, dim and always whole.
      const full = byPriority || isPinned;
      const both = full && Boolean(more) && Boolean(a.space_name);
      const name = both ? more : full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      // Dragging: pinned rows reorder the pins; under a space header a row moves its tab
      // within the space (the tab bar follows); rows in priority sections stay put.
      const pinAt = pinned.indexOf(a);
      const spaceTabs = spaces().find((s) => s.id === a.space)?.tabs ?? [];
      const tabAt = spaceTabs.findIndex((x) => x.id === a.tab);
      const me = isPinned ? { kind: "pin", pos: pinAt }
        : !byPriority && tabAt >= 0 ? { kind: "tab", pos: tabAt, space: a.space, tab: a.tab }
        : null;
      const onSpace = this.spaceAim(a.space);
      const aim = (d) => {
        if (d.kind === "pin" && isPinned) return { key: a.address, pos: pinAt, drop: (d) => movePin(d.key, a.address) };
        if (d.kind === "tab" && !isPinned && !byPriority && d.space === a.space && d.tab !== a.tab && tabAt >= 0) {
          return { key: a.address, pos: tabAt, drop: (d) => run("tab.move", { id: d.tab, index: tabAt + 1 }) };
        }
        return !isPinned && !byPriority ? onSpace(d) : null;
      };
      return this.dnd(h_flex(), t, a.address, me, aim)
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        // The zoo's own menu (an overlay of the zoo mod): change its character, close the agent.
        .on_mouse_down("right", () => openOverlay({
          mod: "zoo", kind: "popup", width: 220, height: 205,
          props: { menu: a.address, title: `${a.space_name} · ${label(a)}` },
        }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().when(both, el => el.min_w(0)).when(!both, el => el.flex_none().max_w(200)).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          // Right-click the space name: rename the space (Herdr asks for the name).
          .when(both, el => el.child(div().id(`ag-space-${a.address}`).flex_none().max_w(110).truncate().text_color(t.dim)
            .on_mouse_down("right", (_e, cx) => {
              cx.stop_propagation();
              run("space.rename", { id: a.space });
            })
            .child(`\u00b7 ${a.space_name}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a], space: byPriority ? null : a.space });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    // A space's header drags to reorder the spaces; right-click renames the space.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      const sp = g.space ? spaces() : [];
      const at = sp.findIndex((s) => s.id === g.space);
      const el = g.space && at >= 0
        ? this.dnd(h_flex(), t, g.id, { kind: "space", pos: at, id: g.space, machine: sp[at].machine ?? null }, this.spaceAim(g.space))
          .on_mouse_down("right", () => run("space.rename", { id: g.space }))
        : h_flex();
      return el
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(viewSwitch(t, "list"))
            .child(h_flex().gap(4).items_center().mr(-8)
              .child(
                div()
                  .id("ag-sort")
                  .text_size(11)
                  .text_color(t.dim)
                  .hover((s) => s.text_color(t.foreground))
                  .on_click(() => openOverlay({ mod: "zoo-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                  .tooltip(`Sort agents: ${sort.label}`)
                  .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
              )
              // The zoo's sounds dialog, the same ♪ as in the zoo's header.
              .child(
                div()
                  .id("ag-sounds")
                  .px(8)
                  .py(4)
                  .rounded(6)
                  .text_size(14)
                  .text_color(t.dim)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Sounds")
                  .on_click(() => openOverlay({ mod: "zoo", kind: "dialog", width: 560, height: 640, props: { sounds: true } }))
                  .child("♪"),
              )),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always")
        // A drag ends on any release, and when the pointer leaves the list (a release out there never arrives).
        .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
        .on_hover((on, cx) => { if (!on) this.endDrag(cx); })
        .children(rows))
      .child(
        h_flex()
          .h(28)
          .px(12)
          .items_center()
          .justify_end()
          .when(collapsed, (el) => el.justify_center().px(0))
          .child(
            div()
              .id("collapse")
              .text_size(13)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground))
              .on_click(toggleSidebar)
              .child(collapsed ? "»" : ""),
          ),
      );
  }
}
