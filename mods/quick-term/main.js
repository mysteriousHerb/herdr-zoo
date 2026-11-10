// The quick terminal's header, the top of the zoo layout's `tray` (a hidden column under the work
// body: drag its top edge to resize; keys.json `"ctrl-j": "layout.toggle:tray"` shows and hides it).
// The tray's stack (`tray-terms`, a terminal block per quick terminal) shows the shown space's
// quick terminal: a core terminal Herdr puts in no tab (`hc run --bg` without Herdr's space/tab labels; ours is
// `zoo.quickterm=<space>:<kind>`), kept (`--keep`), so hiding the tray leaves it running, and it is
// found again by its label, also after a restart. Kind = local (the space's shell) or dev (a bash
// in the space's dev container, the + menu's "Terminal (dev container)" command), picked per space
// (shared `quickterm.kind`). While the tray shows, this selects the right one (see `sync`) and
// gives it the keyboard. Exiting the shell hides the tray; the next Ctrl+J starts a new one.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, run, exec, theme, spaces, terminals, panes, focused, layout, hc, knownAgents, shared, setShared } from "herdr";

const LABEL = "zoo.quickterm";
const KINDS = "quickterm.kind"; // { <space id>: "local" | "dev" }

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const kindOf = (space) => (shared(KINDS) ?? {})[space] ?? "local";
// `terminals()` lists a new terminal only after a few seconds, so the ones started here count as
// live until it lists them (else every tick started another: 5 spare shells per space, 2026-11-06).
const made = new Map(); // address -> when started (ms)
function live(address) {
  const t = terminals().find((x) => x.address === address);
  if (t) return t.state === "live";
  return Date.now() - (made.get(address) ?? 0) < 60000;
}
// A terminal to replace: one started by older code (its `zoo.quickterm.v` label isn't VERSION; bump
// it when the command or the folder it starts in changes), or a lost dev one (core restart, reboot),
// which comes back as a plain shell with its labels: PowerShell, not the container's bash (a live
// one is cmd.exe).
const VERSION = "zoo.quickterm.v";
const NOW = "3";
const stale = (t, want) => t.labels?.[VERSION] !== NOW ||
  (want.endsWith(":dev") && /^(powershell|pwsh)/i.test(t.agent ?? ""));

// Where a space's quick terminal starts: where the space's terminals are (the focused one, else the
// shown tab's, else any tab's). Not `space.folder`: started from it, the harness-agent space's quick
// terminal opened in plat3_dev2 (2026-11-10; it looks like the folder of whatever terminal had the
// keyboard when the space was made, its value wasn't read). The terminal keeps that folder for life.
function folderOf(space) {
  const f = focused();
  const quick = f?.terminal && terminals().find((t) => t.address === f.terminal)?.labels?.[LABEL];
  if (f?.space === space.id && f.cwd && !quick) return f.cwd;
  const tabs = [...(space.tabs ?? [])].sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  for (const tab of tabs) {
    const pane = panes().find((p) => p.tab === tab.id && p.terminal && p.cwd);
    if (pane) return pane.cwd;
  }
  return space.folder || null;
}
const labelledTerm = (want) => terminals().find((t) => t.state === "live" && t.labels?.[LABEL] === want) ?? null;

// The dev container terminal's command: my-new-menu's, from the Claude entry, but `devcontainer up`
// is quiet unless it fails (then it runs again to show why, and waits for a key), and the screen is
// cleared before bash. The terminal starts at Herdr's default width (~200 columns) while the tray
// isn't sized yet; bash through `docker exec` redraws its prompt on the resize, which left a doubled
// prompt and the cursor a line off (2026-11-06). No quotes: hc's argv quoting and cmd's don't mix.
function devArgv(entry) {
  const line = (entry?.run ?? []).join(" ");
  const folder = /--workspace-folder\s+("[^"]+"|\S+)/.exec(line)?.[1] ?? "..\\harness-agent";
  const up = `devcontainer up --workspace-folder ${folder}`;
  return ["cmd.exe", "/c", `echo Starting the dev container... & ${up} >nul 2>&1 || (${up} & pause & exit 1) & cls & devcontainer exec --workspace-folder ${folder} bash -l`];
}

export default class QuickTerm extends View {
  init(_props, cx) {
    if (props()?.empty) return; // the stack's placeholder, shown until the first terminal starts
    this.dev = undefined; // the + menu's dev container entry (null: none on this computer)
    this.starting = null; // label being started
    this.started = {}; // label -> { address, at }: the last start, and never two within a minute
    this.wasShown = false;
    this.mine = null; // { want, address } the tray last showed
    this.killed = new Set(); // stale terminals already told to end
    cx.spawn(async (cx) => {
      try { this.dev = (await knownAgents()).find((a) => a.key === "claude-dev-container" && a.installed) ?? null; }
      catch { this.dev = null; }
      cx.notify();
    });
    this.sync(cx);
    cx.timer.every(700, (cx) => this.sync(cx));
  }

  // While the tray shows: the stack `tray-terms` shows the shown space's terminal of the picked kind.
  // Switching is `layout.select` (a click, like the Chat / Terminal switch); `layout.set` only adds
  // a child when a new terminal starts (and drops the ones whose terminal ended), from `layout()`,
  // which carries the person's dragged sizes, so they stay (the set writes them into the file and
  // drops layouts/.state/zoo.json; deploy.sh leaves an unchanged layout alone for that reason).
  sync(cx) {
    const tree = layout();
    const tray = find(tree, "tray");
    const shown = Boolean(tray) && !tray.hidden;
    const opened = shown && !this.wasShown;
    this.wasShown = shown;
    if (!shown) return;
    const space = spaces().find((s) => s.active);
    if (!space) return;
    const kind = kindOf(space.id) === "dev" && this.dev ? "dev" : "local";
    const want = `${space.id}:${kind}`;
    const last = this.started[want];
    let found = labelledTerm(want);
    if (found && stale(found, want)) {
      if (!this.killed.has(found.address)) {
        this.killed.add(found.address);
        cx.spawn(async () => { try { await hc(["kill", found.address]); } catch {} });
      }
      found = null;
    }
    const address = found?.address ?? (last?.address && live(last.address) ? last.address : null);
    if (!address) {
      // The one it showed ended (the shell was exited): put the tray away instead of starting another.
      // Not one this mod ended to replace it, nor while the replacement starts.
      if (!opened && this.mine?.want === want && !live(this.mine.address) &&
          !this.killed.has(this.mine.address) && this.starting !== want) {
        this.mine = null;
        run("layout.hide", { id: "tray" });
        return;
      }
      if (this.starting !== want && Date.now() - (last?.at ?? 0) > 60000) this.start(space, kind, want, cx);
      return;
    }
    const stack = find(tree, "tray-terms");
    if (!stack) return;
    const id = `qt-${address.replace(/[^A-Za-z0-9]/g, "-")}`;
    if (!stack.children.some((c) => c.id === id)) {
      // layout() is read-only (assigning to it is silently dropped): edit a plain copy. Once per
      // terminal, so a refused set can't repeat its error toast every tick.
      if (this.setFor === id) return;
      this.setFor = id;
      const copy = JSON.parse(JSON.stringify(tree));
      const s = find(copy, "tray-terms");
      s.children = s.children
        .filter((c) => c.id === "qt-none" || live(c.content?.terminal))
        .concat([{ id, type: "block", content: { terminal: address } }]);
      s.active = id;
      // Through the CLI: run("layout.set") from a mod does nothing (no error, no change; 0.1.11).
      cx.spawn(async () => { try { await exec("herdr-app", ["do", "layout.set", "--layout", JSON.stringify(copy)]); } catch {} });
      return; // focus on a later tick, once the block exists
    }
    if (stack.active !== id) run("layout.select", { stack: "tray-terms", child: id });
    if (opened || this.mine?.address !== address) run("pane.focus", { terminal: address });
    if (this.mine?.address !== address) { this.mine = { want, address }; cx.notify(); }
  }

  start(space, kind, want, cx) {
    if (kind === "dev" && this.dev === undefined) return; // not known yet: the next tick
    this.starting = want;
    this.started[want] = { address: null, at: Date.now() };
    cx.spawn(async (cx) => {
      try {
        const args = ["run", "--bg", "--keep", "--no-parent", "--outlive-parent", "--no-notify", "--json",
          "--label", `${LABEL}=${want}`, "--label", `${VERSION}=${NOW}`];
        const folder = folderOf(space);
        if (folder) args.push("--cwd", folder);
        if (space.machine) args.push("--on", space.machine);
        if (kind === "dev") args.push("--", ...devArgv(this.dev));
        const address = JSON.parse((await hc(args)).stdout).address;
        if (address) { made.set(address, Date.now()); this.started[want] = { address, at: Date.now() }; }
      } catch {}
      this.starting = null;
      this.sync(cx);
    });
  }

  pick(kind, cx) {
    const space = spaces().find((s) => s.active);
    if (!space) return;
    setShared(KINDS, { ...(shared(KINDS) ?? {}), [space.id]: kind });
    this.sync(cx);
  }

  render() {
    const t = theme();
    if (props()?.empty) return div().size_full().p(10).text_size(12).text_color(t.dim).child("Starting the terminal…");
    const space = spaces().find((s) => s.active);
    const kind = space && kindOf(space.id) === "dev" && this.dev ? "dev" : "local";
    const seg = (id, label) => div().id(`qt-${id}`).px(8).h(20).flex().items_center().rounded(5)
      .text_size(11.5).font_medium()
      .when(id === kind, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(id !== kind, (el) => el.text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.pick(id, cx)))
      .child(label);
    return h_flex().size_full().px(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(svg("icons/shell.svg").size(13).text_color(t.dim))
      .child(div().text_size(12).font_medium().text_color(t.foreground).child("Terminal"))
      .child(h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.surface).border(1).border_color(t.border)
        .child(seg("local", "Local"))
        .when(Boolean(this.dev), (el) => el.child(seg("dev", "Dev container"))))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
        .child(this.starting ? "Starting…" : space?.name ?? ""))
      .child(div().id("qt-hide").w(22).h(20).flex().items_center().justify_center().rounded(4)
        .text_size(14).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Hide (Ctrl+J); the terminal keeps running")
        .on_click(() => run("layout.hide", { id: "tray" }))
        .child("×"));
  }
}
