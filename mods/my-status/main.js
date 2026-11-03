import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import os from "os";
import { readdir, exists } from "fs/promises";
import { spaces, agents, panes, focused, theme, run, window, shared, exec, notify, openOverlay, closeOverlay, props, appHome } from "herdr";

// Clone of Herdr's workspace-status (0.1.10); changes: no agents count (the zoo shows them), and
// how many sub-agents are at work, from claude-chat's shared "chat.subs" ({ "<address>": n }). Click = the agent with the most.
// Also: "Folder" and "VS Code" open the focused terminal's folder (else the space's), on this
// computer only; same as the zoo's agent menu (`open` there, duplicated: mods can't share code).
// The branch name opens a list of the repo's branches to `git switch` to; "PR #N" opens its PR.
// The branch itself is read with git every 3 s (`readGit`): Herdr's own pane/space `branch` kept
// the old name after a `git switch` typed in the terminal (0.1.11). "Sync" = fetch, then pull --ff-only.
// Dev containers: when the focused agent (or one in the space) runs in a dev container, "N repos"
// lists every repo in the container's /workspace folder (its bind mount on this computer), each
// with its branch, ahead/behind, changes, PR and a Sync button (props {repos} = that popup).
// PRs: GitHub through gh, Azure DevOps through its REST API (azure-prs.ps1, git's stored credential).

const WIN = /^win/.test(os.platform()); // "windows" here, not node's "win32"
// claude-chat shares which container each Claude runs in: { "<address>": "<container id or name>" }.
const CONTAINERS = "chat.containers";

function openFolder(folder, what) {
  const [cmd, args] = what === "code"
    ? (WIN ? ["cmd", ["/c", "code", folder]] : ["code", [folder]]) // code is code.cmd on Windows
    // Not explorer itself: exec starts programs hidden, and so is the window explorer opens.
    : (WIN ? ["cmd", ["/c", "start", "", folder.replace(/\//g, "\\")]] : [os.platform() === "darwin" ? "open" : "xdg-open", [folder]]);
  exec(cmd, args).then(
    (r) => { if (what === "code" && r.code) notify({ title: "Couldn't open VS Code", body: (r.stderr || r.stdout).trim() || "Is `code` on the PATH?", level: "error" }); },
    (e) => notify({ title: `Couldn't run ${cmd}`, body: String(e), level: "error" }));
}

// A path with "." and ".." resolved (docker's mount sources look like "c:\x\harness-agent/..").
function resolvePath(p) {
  const parts = [];
  for (const s of String(p).split(/[\\/]+/)) { if (s === "..") parts.pop(); else if (s && s !== ".") parts.push(s); }
  return WIN ? parts.join("\\") : "/" + parts.join("/");
}
const pathKey = (p) => resolvePath(p).toLowerCase();
const inside = (child, parent) => { const c = pathKey(child), p = pathKey(parent); return c === p || c.startsWith(p + (WIN ? "\\" : "/")); };
const baseName = (p) => resolvePath(p).split(/[\\/]/).pop();

// One repo's branch, upstream, ahead/behind and changed files, from one `git status` (the call
// Herdr's `spaces` list makes). core.filemode off: a repo cloned in a Linux container has it on,
// and from Windows every file then looks changed (684 in rulebook-knowledge, 2026-11-03).
async function gitStatus(folder) {
  try {
    const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.filemode=false",
      "status", "--porcelain=v2", "--branch"], { cwd: folder });
    if (r.code) return null;
    const info = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, dirty: 0 };
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("# branch.head ")) info.branch = line.slice(14).trim();
      else if (line.startsWith("# branch.oid ")) info.oid = line.slice(13).trim();
      else if (line.startsWith("# branch.upstream ")) info.upstream = line.slice(18).trim();
      else if (line.startsWith("# branch.ab ")) {
        const [a, b] = line.slice(12).trim().split(" ");
        info.ahead = Math.abs(parseInt(a, 10)) || 0;
        info.behind = Math.abs(parseInt(b, 10)) || 0;
      } else if (line.trim() && !line.startsWith("#")) info.dirty++;
    }
    return info;
  } catch { return null; } // no git
}

// Fetch, then pull --ff-only when there's an upstream. Anything git refuses (diverged, changes in
// the way) comes back as the note; the terminal is where that gets sorted.
async function syncRepo(folder) {
  const git = (...args) => exec("git", args, { cwd: folder }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  const tail = (r) => (r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n");
  const repo = baseName(folder);
  const before = (await git("rev-parse", "HEAD")).stdout.trim();
  const fetched = await git("fetch", "--prune");
  if (fetched.code) return { repo, ok: false, n: 0, title: "Couldn't fetch", body: tail(fetched) || repo };
  const upstream = await git("rev-parse", "--abbrev-ref", "@{u}");
  if (upstream.code) return { repo, ok: true, n: 0, title: "Fetched", body: `${repo}: no upstream branch to pull from` };
  const pulled = await git("pull", "--ff-only");
  if (pulled.code) return { repo, ok: false, n: 0, title: "Couldn't pull", body: tail(pulled) };
  const after = (await git("rev-parse", "HEAD")).stdout.trim();
  const n = before === after ? 0 : parseInt((await git("rev-list", "--count", `${before}..${after}`)).stdout, 10) || 0;
  return { repo, ok: true, n, title: n ? `Pulled ${n} commit${n === 1 ? "" : "s"}` : "Up to date", body: `${repo} · ${upstream.stdout.trim()}` };
}

// Where a repo's PRs live, from its origin's URL (read once per folder).
const origins = new Map();
async function forgeOf(folder) {
  if (!origins.has(folder)) {
    const r = await exec("git", ["remote", "get-url", "origin"], { cwd: folder }).catch(() => ({ code: 1 }));
    origins.set(folder, r.code ? "" : r.stdout.trim());
  }
  const url = origins.get(folder);
  let m = /^https:\/\/(?:([^@/]+)@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(url);
  if (m) return { kind: "azure", host: "dev.azure.com", user: m[1] ?? m[2], org: m[2], project: m[3], repo: m[4] };
  m = /^https:\/\/(?:([^@/]+)@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(url);
  if (m) return { kind: "azure", host: `${m[2]}.visualstudio.com`, user: m[1] ?? "", org: m[2], project: m[3], repo: m[4] };
  m = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com:(?:22\/)?v3\/([^/]+)\/([^/]+)\/([^/]+?)$/i.exec(url);
  if (m) return { kind: "azure", host: "dev.azure.com", user: m[1], org: m[1], project: m[2], repo: m[3] };
  if (/github\.com[:/]/i.test(url)) return { kind: "github" };
  return null;
}

// The PR of each { folder, branch, oid }: { "<folder>|<branch>": { pr, error? } }, pr as gh gives
// it ({ url, number, state: OPEN|MERGED|CLOSED, isDraft, title, head }) or null. GitHub: `gh pr
// view` (needs gh signed in). Azure DevOps: one PowerShell call for all of them (~2 s).
// A merged or closed PR counts only while the branch is still at its last commit: a long-lived
// branch (main, AI-main) otherwise shows some old PR that once came from it.
async function prsFor(list) {
  const out = {};
  const azure = [];
  const oids = {};
  await Promise.all(list.map(async ({ folder, branch, oid }) => {
    oids[`${folder}|${branch}`] = oid;
    const key = `${folder}|${branch}`;
    out[key] = { pr: null };
    if (!branch || branch.startsWith("(")) return; // detached
    const forge = await forgeOf(folder);
    if (forge?.kind === "azure") { const { kind, ...rest } = forge; azure.push({ key, ...rest, branch }); }
    else if (forge?.kind === "github") {
      try {
        const r = await exec("gh", ["pr", "view", branch, "--json", "url,number,state,isDraft,title,headRefOid"], { cwd: folder });
        if (r.code === 0) { const { headRefOid, ...pr } = JSON.parse(r.stdout); out[key].pr = { ...pr, head: headRefOid }; }
      } catch {} // no gh
    }
  }));
  if (azure.length) {
    try {
      const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(azure))));
      const r = await exec(WIN ? "powershell" : "pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", `${appHome()}/mods/my-status/azure-prs.ps1`, b64]);
      for (const res of JSON.parse(r.stdout.trim() || "[]")) out[res.key] = { pr: res.pr ?? null, error: res.error };
    } catch (e) { for (const a of azure) out[a.key].error = String(e); }
  }
  for (const [key, res] of Object.entries(out)) {
    const pr = res.pr, oid = oids[key];
    if (pr && pr.state !== "OPEN" && oid && pr.head && pr.head !== oid) res.pr = null;
  }
  return out;
}

// Running dev containers: [{ id, name, local (the folder it was opened on), root (what its
// /workspace is on this computer: the bind mount with the shortest /workspace… target) }].
async function devContainers() {
  const ps = await exec("docker", ["ps", "-q", "--filter", "label=devcontainer.local_folder"]);
  const ids = ps.code ? [] : ps.stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const r = await exec("docker", ["inspect", "-f",
    '{{.Id}}|{{.Name}}|{{index .Config.Labels "devcontainer.local_folder"}}|{{range .Mounts}}{{if eq .Type "bind"}}{{.Destination}}>{{.Source}};{{end}}{{end}}', ...ids]);
  if (r.code) return [];
  return r.stdout.split("\n").filter((l) => l.includes("|")).map((line) => {
    const [id, name, local, mounts] = line.trim().split("|");
    const work = (mounts ?? "").split(";").filter(Boolean).map((m) => m.split(">"))
      .filter(([to]) => /^\/workspaces?(\/|$)/.test(to)).sort((a, b) => a[0].length - b[0].length)[0];
    return { id, name: name.replace(/^\//, ""), local: resolvePath(local), root: resolvePath(work?.[1] ?? local) };
  });
}

// The repos in a workspace folder: it, if it is one, and each folder in it with a .git.
async function reposIn(root) {
  const found = [];
  if (await exists(`${root}/.git`).catch(() => false)) found.push(root);
  for (const name of (await readdir(root).catch(() => [])).sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    const dir = resolvePath(`${root}/${name}`);
    if (await exists(`${dir}/.git`).catch(() => false)) found.push(dir);
  }
  return found;
}

const ROW = 34; // a repo row's height in the repos popup

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.prs = {}; // "<folder>|<branch>" → { pr, error?, at }
    this.syncing = new Set(); // folders being synced
    const p = props() ?? {};
    if (p.branches) return;
    if (p.repos) return this.initRepos(p.repos, cx);
    this.git = {}; // folder -> { branch, upstream, ahead, behind, dirty } | null (not a repo)
    this.boxes = []; // devContainers()
    this.dirs = {}; // workspace root → its repos
    this.repos = {}; // repo folder → gitStatus (the workspace's repos)
    let ticks = 0;
    this.readBoxes(cx);
    cx.timer.every(3000, (cx) => {
      ticks++;
      this.readGit(cx);
      this.lookup(cx);
      if (ticks % 10 === 0) this.readBoxes(cx);
      if (ticks % 3 === 0) this.readRepos(cx);
    });
  }

  // The bar's folder, read with git. Only redraws when something changed.
  readGit(cx) {
    const folder = this.folder;
    if (!folder || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      const info = await gitStatus(folder);
      this.reading = false;
      if (JSON.stringify(this.git[folder] ?? null) !== JSON.stringify(info)) { this.git[folder] = info; cx.notify(); }
    });
  }

  // The dev containers and their workspaces' repos, every 30 s (docker ~0.2 s, async).
  readBoxes(cx) {
    if (this.boxing) return;
    this.boxing = true;
    cx.spawn(async (cx) => {
      const boxes = await devContainers().catch(() => []);
      const dirs = {};
      for (const root of new Set(boxes.map((b) => b.root))) dirs[pathKey(root)] = await reposIn(root);
      this.boxing = false;
      const changed = JSON.stringify([boxes, dirs]) !== JSON.stringify([this.boxes, this.dirs]);
      this.boxes = boxes; this.dirs = dirs;
      if (changed) { cx.notify(); this.readRepos(cx); }
    });
  }

  // The shown workspace's repos, every 9 s (the bar's count and tooltip).
  readRepos(cx) {
    const ws = this.ws;
    if (!ws || this.readingRepos) return;
    this.readingRepos = true;
    cx.spawn(async (cx) => {
      const got = await Promise.all(ws.dirs.map(gitStatus));
      this.readingRepos = false;
      let changed = false;
      ws.dirs.forEach((dir, i) => { if (JSON.stringify(this.repos[dir] ?? null) !== JSON.stringify(got[i])) { this.repos[dir] = got[i]; changed = true; } });
      if (changed) cx.notify();
    });
  }

  // Which dev container's workspace the bar shows: the focused agent's container, else one an
  // agent in this space runs in, else the container opened on (a parent of) the bar's folder.
  workspace(f, space, folder) {
    if (!this.boxes?.length) return null;
    const map = shared(CONTAINERS) ?? {};
    const box = (tok) => (tok ? this.boxes.find((b) => b.id.startsWith(tok) || b.name === tok) : null);
    let b = box(f?.agent && map[f.agent]);
    if (!b && space) for (const a of agents()) if (a.space === space.id && (b = box(map[a.address]))) break;
    if (!b && folder) b = this.boxes.find((x) => inside(folder, x.local));
    if (!b) return null;
    const dirs = this.dirs[pathKey(b.root)] ?? [];
    return dirs.length ? { root: b.root, name: baseName(b.root), dirs } : null;
  }

  // Sync one repo (its toast as before) or several (one toast for all).
  sync(folders, cx, after) {
    folders = folders.filter((f) => !this.syncing.has(f));
    if (!folders.length) return;
    for (const f of folders) this.syncing.add(f);
    cx.notify();
    cx.spawn(async (cx) => {
      const results = await Promise.all(folders.map(syncRepo));
      for (const f of folders) this.syncing.delete(f);
      if (results.length === 1) {
        const [r] = results;
        notify({ title: r.title, body: r.body, level: r.ok ? (r.title === "Fetched" ? "info" : "success") : "error", ...(r.ok ? { timeout: 4000 } : {}) });
      } else {
        const failed = results.filter((r) => !r.ok);
        const pulled = results.reduce((s, r) => s + r.n, 0);
        const lines = results.filter((r) => !r.ok || r.n).map((r) => (r.ok ? `${r.repo}: pulled ${r.n}` : `${r.repo}: ${r.title.toLowerCase()}: ${r.body.split("\n").pop()}`));
        notify({
          title: failed.length ? `${results.length - failed.length} of ${results.length} repos synced` : pulled ? `Pulled ${pulled} commit${pulled === 1 ? "" : "s"}` : `All ${results.length} repos up to date`,
          body: lines.join("\n") || undefined, level: failed.length ? "warning" : "success", ...(failed.length ? {} : { timeout: 5000 }),
        });
      }
      after?.(cx);
      cx.notify();
    });
  }

  lookup(cx) {
    const key = this.key;
    if (!key || !(key.split("|")[0] in this.git) || this.busy || Date.now() - (this.prs[key]?.at ?? 0) < 60000) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const [folder, branch] = key.split("|");
      const got = (await prsFor([{ folder, branch, oid: this.git[folder]?.oid }]))[key];
      const changed = JSON.stringify(this.prs[key]?.pr ?? null) !== JSON.stringify(got.pr);
      this.prs[key] = { ...got, at: Date.now() };
      this.busy = false;
      if (changed) cx.notify();
    });
  }

  // The repos popup: its own reads while open (statuses every 4 s, PRs on open and every minute).
  initRepos(ws, cx) {
    this.repos = { ...(ws.status ?? {}) };
    this.prs = { ...(ws.prs ?? {}) };
    const read = (cx) => {
      if (this.readingRepos) return;
      this.readingRepos = true;
      cx.spawn(async (cx) => {
        const got = await Promise.all(ws.dirs.map(gitStatus));
        this.readingRepos = false;
        const changed = ws.dirs.some((d, i) => JSON.stringify(this.repos[d] ?? null) !== JSON.stringify(got[i]));
        ws.dirs.forEach((d, i) => { this.repos[d] = got[i]; });
        if (changed) cx.notify();
        if (Date.now() - (this.prsAt ?? 0) > 60000) this.readPrs(ws, cx);
      });
    };
    this.reread = read;
    read(cx);
    cx.timer.every(4000, read);
  }

  readPrs(ws, cx, force) {
    if (this.lookingUp && !force) return;
    this.lookingUp = true;
    this.prsAt = Date.now();
    cx.spawn(async (cx) => {
      const list = ws.dirs.filter((d) => this.repos[d]?.branch).map((d) => ({ folder: d, branch: this.repos[d].branch, oid: this.repos[d].oid }));
      const got = await prsFor(list);
      for (const [k, v] of Object.entries(got)) this.prs[k] = { ...v, at: Date.now() };
      this.lookingUp = false;
      cx.notify();
    });
  }

  openRepos(ws, above) {
    const height = 40 + Math.min(ws.dirs.length, 12) * ROW + 10;
    const prs = {};
    for (const d of ws.dirs) { const k = `${d}|${this.repos[d]?.branch}`; if (this.prs[k]) prs[k] = this.prs[k]; }
    openOverlay({
      mod: "my-status", kind: "popup", width: 640, height,
      at: { x: Math.max(4, above.x), y: Math.max(4, above.y - height) },
      props: { repos: { root: ws.root, name: ws.name, dirs: ws.dirs, status: Object.fromEntries(ws.dirs.map((d) => [d, this.repos[d] ?? null])), prs } },
    });
  }

  // Each repo of a dev container's workspace: name, branch (click = switch), ahead/behind,
  // changes, PR, Sync; Sync all at the top.
  repoList(t) {
    const { repos: ws } = props();
    const all = ws.dirs.filter((d) => this.repos[d]);
    const anySyncing = all.some((d) => this.syncing.has(d));
    const after = (cx) => { this.reread?.(cx); this.readPrs(ws, cx, true); };
    const icon = (name, spin) => { const s = svg(name).size(12); return spin ? s.spin(900) : s; };
    const row = (dir) => {
      const g = this.repos[dir];
      const name = baseName(dir);
      const pr = g?.branch ? this.prs[`${dir}|${g.branch}`] : null;
      const prState = pr?.pr ? (pr.pr.isDraft ? "draft" : pr.pr.state.toLowerCase()) : "";
      const syncing = this.syncing.has(dir);
      return h_flex().id(`repo-${name}`).h(ROW).flex_none().px(8).gap(12).rounded(7).items_center().hover(s => s.bg(t.hover))
        .child(div().w(150).flex_none().truncate().text_color(t.foreground).child(name).id(`rn-${name}`).tooltip(dir))
        .child(!g ? div().flex_1().text_color(t.dim).child("can't read it from here") : h_flex().id(`rb-${name}`).flex_1().min_w(0).gap(6).items_center()
          .text_color(t.muted).cursor_pointer().hover(s => s.text_color(t.foreground)).tooltip("Switch branch")
          .on_mouse_down("left", (e, cx) => this.openBranches(dir, { x: e.position.x - 16, y: e.position.y - (e.local_position?.y ?? 8) - 8 }, cx))
          .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none())
          .child(div().min_w(0).truncate().child(g.branch ?? "?")))
        .child(div().w(64).flex_none().text_color(g?.behind ? t.accent : t.muted)
          .child(g ? [g.ahead > 0 && `↑${g.ahead}`, g.behind > 0 && `↓${g.behind}`].filter(Boolean).join(" ") : ""))
        .child(div().w(84).flex_none().truncate().text_color(t.muted).child(g?.dirty ? `${g.dirty} change${g.dirty === 1 ? "" : "s"}` : ""))
        .child(div().w(70).flex_none().child(!pr ? div().text_color(t.dim).child(g?.branch ? "…" : "")
          : pr.pr ? h_flex().id(`pr-${name}`).gap(5).items_center().cursor_pointer()
            .text_color(prState === "merged" ? t.ansi5 : prState === "closed" ? t.dim : t.muted).hover(s => s.text_color(t.foreground))
            .tooltip(`${pr.pr.title} (${prState}) · open`)
            .on_click((_e, cx) => cx.open_url(pr.pr.url))
            .child(svg("mods/workspace-chrome/git-compare.svg").size(12)).child(`#${pr.pr.number}`)
          : div().id(`nopr-${name}`).text_color(t.dim).child(pr.error ? "PR ?" : "no PR").when(Boolean(pr.error), s => s.tooltip(pr.error))))
        .child(h_flex().id(`sync-${name}`).w(18).flex_none().justify_center().text_color(t.muted)
          .when(Boolean(g), s => s.cursor_pointer().hover(s => s.text_color(t.foreground))
            .tooltip(g.upstream ? `Fetch and pull (fast-forward) · ${g.upstream}` : "Fetch · no upstream branch")
            .on_click((_e, cx) => this.sync([dir], cx, after)))
          .child(icon("mods/my-status/sync.svg", syncing)));
    };
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(h_flex().h(30).flex_none().px(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().truncate().child(`Repos · ${ws.name} (dev container workspace)`))
        .child(h_flex().id("sync-all").gap(6).items_center().cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .tooltip("Fetch and pull (fast-forward) every repo")
          .on_click((_e, cx) => this.sync(all, cx, after))
          .child(icon("mods/my-status/sync.svg", anySyncing)).child(anySyncing ? "syncing…" : "Sync all")))
      .child(v_flex().id("repos").flex_none().h(Math.min(ws.dirs.length, 12) * ROW).overflow_y_scrollbar().children(ws.dirs.map(row)));
  }

  // Click the branch: read the repo's local branches (most recent first), uncommitted changes and
  // which agents work in it, then open the list as a popup of this mod (props {branches}).
  openBranches(folder, above, cx) {
    cx.spawn(async () => {
      const git = (...args) => exec("git", args, { cwd: folder }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      const [top, refs, status] = await Promise.all([
        git("rev-parse", "--show-toplevel"),
        git("for-each-ref", "--sort=-committerdate", "--format=%(HEAD)|%(refname:short)|%(committerdate:relative)", "refs/heads"),
        git("-c", "core.filemode=false", "status", "--porcelain"),
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
    if (props()?.repos) return this.repoList(t);
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
    const syncing = this.syncing.has(folder);
    const counts = g ? [g.ahead > 0 && `↑${g.ahead}`, g.behind > 0 && `↓${g.behind}`].filter(Boolean).join(" ") : "";
    const syncIcon = svg("mods/my-status/sync.svg").size(12);
    this.key = folder && branch ? `${folder}|${branch}` : null;
    const pr = this.key ? this.prs[this.key]?.pr : null;
    const prState = pr ? (pr.isDraft ? "draft" : pr.state.toLowerCase()) : "";
    // A dev container's workspace: its repos' totals on the bar, the list in a popup.
    const ws = space && !space.machine ? this.workspace(f, space, folder) : null;
    const wsKey = ws ? `${ws.root}|${ws.dirs.join("|")}` : "";
    if (wsKey !== this.wsKey) { this.wsKey = wsKey; this.ws = ws; } // readRepos reads this.ws
    const known = ws ? ws.dirs.map((d) => [d, this.repos[d]]).filter(([, r]) => r) : [];
    const behind = known.reduce((s, [, r]) => s + r.behind, 0);
    const changed = known.filter(([, r]) => r.dirty).length;
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .when(Boolean(ws), el => el.child(label("layers", `${ws.dirs.length} repos${behind ? ` ↓${behind}` : ""}`).id("repos")
        .when(behind > 0, s => s.text_color(t.accent))
        .cursor_pointer().hover(s => s.text_color(t.foreground))
        .tooltip([`Repos in ${ws.root} (dev container)`, ...known.map(([d, r]) =>
          `${baseName(d)}: ${r.branch}${r.ahead ? ` ↑${r.ahead}` : ""}${r.behind ? ` ↓${r.behind}` : ""}${r.dirty ? ` · ${r.dirty} changed` : ""}`),
          changed ? `${changed} with uncommitted changes` : null].filter(Boolean).join("\n"))
        .on_mouse_down("left", (e) => this.openRepos(ws, { x: e.position.x - 16, y: e.position.y - (e.local_position?.y ?? 8) - 8 }))))
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
        .on_click((_e, cx) => this.sync([folder], cx, (cx) => this.readGit(cx)))
        .child(syncing ? syncIcon.spin(900) : syncIcon)
        .child(syncing ? "syncing…" : counts || "Sync")))
      .when(Boolean(folder), el => el.child(button("open-folder", "folder", "Folder", "folder")).child(button("open-code", "file-text", "VS Code", "code")))
      .when(Boolean(pr), el => el.child(label("git-compare", `PR #${pr.number}`).id("open-pr").cursor_pointer()
        .when(prState === "merged", s => s.text_color(t.ansi5)).when(prState === "closed", s => s.text_color(t.dim))
        .hover(s => s.text_color(t.foreground))
        .tooltip(`${pr.title} (${prState}) · open`)
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
