import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import os from "os";
import { spaces, agents, panes, focused, theme, run, window, shared, exec, notify, openOverlay, closeOverlay, props } from "herdr";

// Clone of Herdr's workspace-status (0.1.10); changes: no agents count (the zoo shows them), and
// how many sub-agents are at work, from claude-chat's shared "chat.subs" ({ "<address>": n }). Click = the agent with the most.
// Also: "Folder" and "VS Code" open the focused terminal's folder (else the space's), on this
// computer only; same as the zoo's agent menu (`open` there, duplicated: mods can't share code).
// The branch name opens a list of the repo's branches to `git switch` to; "PR #N" opens its PR.
// The branch itself is read with git every 3 s (`readGit`): Herdr's own pane/space `branch` kept
// the old name after a `git switch` typed in the terminal (0.1.11). "Sync" = fetch, then pull --ff-only.

function openFolder(folder, what) {
  const win = /^win/.test(os.platform()); // "windows" here, not node's "win32"
  const [cmd, args] = what === "code"
    ? (win ? ["cmd", ["/c", "code", folder]] : ["code", [folder]]) // code is code.cmd on Windows
    // Not explorer itself: exec starts programs hidden, and so is the window explorer opens.
    : (win ? ["cmd", ["/c", "start", "", folder.replace(/\//g, "\\")]] : [os.platform() === "darwin" ? "open" : "xdg-open", [folder]]);
  exec(cmd, args).then(
    (r) => { if (what === "code" && r.code) notify({ title: "Couldn't open VS Code", body: (r.stderr || r.stdout).trim() || "Is `code` on the PATH?", level: "error" }); },
    (e) => notify({ title: `Couldn't run ${cmd}`, body: String(e), level: "error" }));
}
export default class WorkspaceStatus extends View {
  // The PR for the bar's folder and branch, from `gh pr view` (needs gh signed in): looked up when
  // they change (checked every 3 s) and again after a minute. "<folder>|<branch>" → {pr, at}.
  init(_props, cx) {
    this.prs = {};
    this.git = {}; // folder -> { branch, upstream, ahead, behind } | null (not a repo)
    cx.timer.every(3000, (cx) => { this.readGit(cx); this.lookup(cx); });
  }

  // The bar's folder: its branch, upstream and how far ahead/behind, from one `git status`
  // (the same call Herdr's `spaces` list makes). Only redraws when something changed.
  readGit(cx) {
    const folder = this.folder;
    if (!folder || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      let info = null;
      try {
        const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd: folder });
        if (r.code === 0) {
          info = { branch: null, upstream: null, ahead: 0, behind: 0 };
          for (const line of r.stdout.split("\n")) {
            if (line.startsWith("# branch.head ")) info.branch = line.slice(14).trim();
            else if (line.startsWith("# branch.upstream ")) info.upstream = line.slice(18).trim();
            else if (line.startsWith("# branch.ab ")) {
              const [a, b] = line.slice(12).trim().split(" ");
              info.ahead = Math.abs(parseInt(a, 10)) || 0;
              info.behind = Math.abs(parseInt(b, 10)) || 0;
            }
          }
        }
      } catch {} // no git
      this.reading = false;
      if (JSON.stringify(this.git[folder] ?? null) !== JSON.stringify(info)) { this.git[folder] = info; cx.notify(); }
    });
  }

  // Sync: `git fetch --prune`, then `git pull --ff-only` when the branch has an upstream. Anything
  // git refuses (diverged, changes in the way) shows as a note; the terminal is where that gets sorted.
  sync(folder, cx) {
    if (this.syncing) return;
    this.syncing = folder;
    cx.notify();
    cx.spawn(async (cx) => {
      const git = (...args) => exec("git", args, { cwd: folder }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      const tail = (r) => (r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n");
      const repo = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      const before = (await git("rev-parse", "HEAD")).stdout.trim();
      const fetched = await git("fetch", "--prune");
      if (fetched.code) notify({ title: "Couldn't fetch", body: tail(fetched) || repo, level: "error" });
      else {
        const upstream = await git("rev-parse", "--abbrev-ref", "@{u}");
        if (upstream.code) notify({ title: "Fetched", body: `${repo}: no upstream branch to pull from`, level: "info", timeout: 4000 });
        else {
          const pulled = await git("pull", "--ff-only");
          if (pulled.code) notify({ title: "Couldn't pull", body: tail(pulled), level: "error" });
          else {
            const after = (await git("rev-parse", "HEAD")).stdout.trim();
            const n = before === after ? 0 : parseInt((await git("rev-list", "--count", `${before}..${after}`)).stdout, 10) || 0;
            notify({ title: n ? `Pulled ${n} commit${n === 1 ? "" : "s"}` : "Up to date", body: `${repo} · ${upstream.stdout.trim()}`, level: "success", timeout: 4000 });
          }
        }
      }
      this.syncing = null;
      this.readGit(cx);
      cx.notify();
    });
  }

  lookup(cx) {
    const key = this.key;
    if (!key || this.busy || Date.now() - (this.prs[key]?.at ?? 0) < 60000) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      let pr = null;
      try {
        const r = await exec("gh", ["pr", "view", "--json", "url,number,state,isDraft,title"], { cwd: key.split("|")[0] });
        if (r.code === 0) pr = JSON.parse(r.stdout);
      } catch {} // no gh, or not a GitHub repo
      const changed = JSON.stringify(this.prs[key]?.pr ?? null) !== JSON.stringify(pr);
      this.prs[key] = { pr, at: Date.now() };
      this.busy = false;
      if (changed) cx.notify();
    });
  }

  // Click the branch: read the repo's local branches (most recent first), uncommitted changes and
  // which agents work in it, then open the list as a popup of this mod (props {branches}).
  openBranches(folder, above, cx) {
    cx.spawn(async () => {
      const git = (...args) => exec("git", args, { cwd: folder }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      const [top, refs, status] = await Promise.all([
        git("rev-parse", "--show-toplevel"),
        git("for-each-ref", "--sort=-committerdate", "--format=%(HEAD)|%(refname:short)|%(committerdate:relative)", "refs/heads"),
        git("status", "--porcelain"),
      ]);
      if (top.code) return notify({ title: "Not a git repo", body: folder, level: "warning" });
      const root = top.stdout.trim();
      const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      const inRepo = (p) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + "/");
      const branches = refs.stdout.trim().split("\n").filter(Boolean).map((l) => { const [head, name, when] = l.split("|"); return { name, when, current: head === "*" }; });
      const agentsHere = panes().filter((p) => p.status && inRepo(p.cwd)).length;
      const dirty = status.stdout.trim().split("\n").filter(Boolean).length;
      const notes = (agentsHere > 1 ? 1 : 0) + (dirty ? 1 : 0);
      // Sized to content (Herdr's popups are): title, one-line notes, up to 10 rows, padding.
      const height = 30 + notes * 26 + Math.min(branches.length, 10) * 30 + 12;
      openOverlay({
        mod: "my-status", kind: "popup", width: 360, height,
        at: { x: Math.max(4, above.x), y: Math.max(4, above.y - height) },
        props: { branches, root, agentsHere, dirty },
      });
    });
  }

  // The branch list: click one to `git switch` to it; git's refusal shows here instead.
  branchList(t) {
    const { branches, root, agentsHere, dirty, overlay } = props();
    const note = (text, color) => div().px(8).h(26).flex_none().flex().items_center().text_size(11.2).text_color(color).child(text);
    const pick = (name, cx) => {
      this.switching = name; this.error = null; cx.notify();
      cx.spawn(async (cx) => {
        const r = await exec("git", ["switch", name], { cwd: root }).catch((e) => ({ code: 1, stderr: String(e) }));
        this.switching = null;
        if (r.code) { this.error = (r.stderr || r.stdout || "git switch failed").trim(); cx.notify(); }
        else closeOverlay(overlay);
      });
    };
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(div().h(20).flex_none().px(8).truncate().text_size(11).text_color(t.dim).child(`Switch branch · ${root.split(/[\\/]/).pop()}`))
      .when(agentsHere > 1, el => el.child(note(`${agentsHere} agents work in this repo: their files change too`, t.blocked)))
      .when(dirty > 0, el => el.child(note(`${dirty} uncommitted change${dirty === 1 ? "" : "s"} come along (or git refuses)`, t.muted)))
      .when(Boolean(this.error), el => el.child(div().px(8).py(5).text_size(11.2).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("branches").flex_none().h(Math.min(branches.length, 10) * 30).overflow_y_scrollbar().children(branches.map((b) => h_flex()
        .id(`br-${b.name}`).h(30).flex_none().px(8).gap(8).rounded(7).items_center()
        .text_color(b.current ? t.foreground : t.muted)
        .when(!b.current, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => pick(b.name, cx)))
        .child(h_flex().w(14).flex_none().justify_center().when(b.current, el => el.child(svg("mods/workspace-chrome/check.svg").size(13).text_color(t.accent))))
        .child(div().flex_1().truncate().child(b.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.switching === b.name ? "switching…" : b.when)))));
  }

  render() {
    const t = theme();
    if (props()?.branches) return this.branchList(t);
    const space = spaces().find(s => s.active);
    const list = agents();
    const subs = Object.entries(shared("chat.subs") ?? {}).filter(([address]) => list.some(a => a.address === address)).sort((a, b) => b[1] - a[1]);
    const working = subs.reduce((sum, [, n]) => sum + n, 0);
    const title = (address) => list.find(a => a.address === address)?.title || address;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const folder = space && !space.machine ? (focused()?.cwd || space.folder) : "";
    const button = (id, icon, text, what) => label(icon, text).id(id).cursor_pointer().hover(s => s.text_color(t.foreground))
      .tooltip(`${what === "code" ? "Open in VS Code" : "Open in Explorer"}: ${folder}`)
      .on_click(() => openFolder(folder, what));
    const f = focused();
    this.folder = folder; // what readGit reads on its next tick
    const g = folder ? this.git[folder] : null;
    // git's own answer first; Herdr's until it has been read (or on another machine).
    const branch = g?.branch || (f?.pane && panes().find(p => p.pane === f.pane)?.branch) || space?.branch;
    const syncing = this.syncing === folder;
    const counts = g ? [g.ahead > 0 && `↑${g.ahead}`, g.behind > 0 && `↓${g.behind}`].filter(Boolean).join(" ") : "";
    const syncIcon = svg("mods/my-status/sync.svg").size(12);
    this.key = folder && branch ? `${folder}|${branch}` : null;
    const pr = this.key ? this.prs[this.key]?.pr : null;
    const prState = pr ? (pr.isDraft ? "draft" : pr.state.toLowerCase()) : "";
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .when(Boolean(branch), el => el.child(label("branch", branch).id("branch")
        .when(Boolean(folder), s => s.cursor_pointer().hover(s => s.text_color(t.foreground)).tooltip("Switch branch")
          // mouse down, not click: it carries where (the popup goes above the bar; at the pointer
          // it ran off the window's bottom)
          .on_mouse_down("left", (e, cx) => this.openBranches(folder, { x: e.position.x - 16, y: e.position.y - (e.local_position?.y ?? 8) - 8 }, cx)))))
      .when(Boolean(g?.branch), el => el.child(h_flex().id("sync").gap(6).items_center().cursor_pointer()
        .text_color(g.behind > 0 && !syncing ? t.accent : t.muted).hover(s => s.text_color(t.foreground))
        .tooltip(g.upstream
          ? `Fetch and pull (fast-forward) · ${g.upstream}${g.behind ? ` · ${g.behind} to pull` : ""}${g.ahead ? ` · ${g.ahead} to push` : ""}`
          : "Fetch · no upstream branch to pull from")
        .on_click((_e, cx) => this.sync(folder, cx))
        .child(syncing ? syncIcon.spin(900) : syncIcon)
        .child(syncing ? "syncing…" : counts || "Sync")))
      .when(Boolean(folder), el => el.child(button("open-folder", "folder", "Folder", "folder")).child(button("open-code", "file-text", "VS Code", "code")))
      .when(Boolean(pr), el => el.child(label("git-compare", `PR #${pr.number}`).id("open-pr").cursor_pointer()
        .when(prState === "merged", s => s.text_color(t.ansi5)).when(prState === "closed", s => s.text_color(t.dim))
        .hover(s => s.text_color(t.foreground))
        .tooltip(`${pr.title} (${prState}) · open on GitHub`)
        .on_click((_e, cx) => cx.open_url(pr.url))))
      .when(working > 0, el => el.child(h_flex().id("subs").gap(6).items_center().cursor_pointer().text_color(t.working)
        .hover(s => s.text_color(t.foreground))
        .tooltip(subs.map(([address, n]) => `${title(address)}: ${n}`).join("\n"))
        .on_click(() => run("pane.focus", { terminal: subs[0][0] }))
        .child(svg("mods/workspace-chrome/spinner.svg").size(11).spin(900))
        .child(working === 1 ? "1 sub-agent working" : `${working} sub-agents working`)))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(`${window()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`))
      // The machine, last: rarely looked at (the user's call 2026-11-01).
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"));
  }
}
