import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import os from "os";
import { readdir, exists, readFile, mkdir } from "fs/promises";
import { spaces, agents, panes, focused, theme, run, window, shared, setShared, exec, notify, openOverlay, closeOverlay, props, appHome, watchFolder } from "herdr";

// Clone of Herdr's workspace-status (0.1.10); changes: no agents count (the zoo shows them; the
// "N sub-agents working" item went too, 2026-11-05: the zoo pens and the chat's chips show them).
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
// The repo each dev container workspace shows on the bar, picked in the repos list:
// { "<workspace root, lowercase>": "<repo folder>" }. Unset = the focused terminal's repo.
const SHOWN = "status.shownRepo";

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
// and from Windows every file then looks changed (684 files in one repo, 2026-11-03).
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
// branch (main, a shared lane) otherwise shows some old PR that once came from it.
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

// A repo's page: its top folder, local branches (most recent first), uncommitted changes and
// how many agents work in it. null when it isn't a repo.
async function branchInfo(folder) {
  const git = (...args) => exec("git", args, { cwd: folder }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const [top, refs, status] = await Promise.all([
    git("rev-parse", "--show-toplevel"),
    git("for-each-ref", "--sort=-committerdate", "--format=%(HEAD)|%(refname:short)|%(committerdate:relative)", "refs/heads"),
    git("-c", "core.filemode=false", "status", "--porcelain"),
  ]);
  if (top.code) return null;
  const root = resolvePath(top.stdout.trim()); // git says C:/x; the bar's folders are C:\x
  const branches = refs.stdout.trim().split("\n").filter(Boolean).map((l) => { const [head, name, when] = l.split("|"); return { name, when, current: head === "*" }; });
  const agentsHere = panes().filter((p) => p.status && p.cwd && inside(p.cwd, root)).length;
  const dirty = status.stdout.trim().split("\n").filter(Boolean).length;
  return { root, branches, agentsHere, dirty };
}

const ROW = 34; // a repo row's height in the repos popup

// Plan usage (the 5-hour and weekly limits, as /usage shows them). Claude Code hands them to its
// status line command, and statusline.cjs (set up in ~/.claude/settings.json) saves them here,
// so they're as fresh as the last running Claude's status line.
const USAGE_DIR = () => `${appHome()}/data/my-status`;
const USAGE_POPUP_W = 320;

// { at, rate_limits: { five_hour: { used_percentage, resets_at (Unix s) }, seven_day: … } } | null
async function readUsageFile() {
  try { return JSON.parse(await readFile(`${USAGE_DIR()}/usage.json`, "utf8")); } catch { return null; }
}

function limitName(key) {
  if (key === "five_hour") return "5-hour limit";
  if (key === "seven_day") return "Weekly limit";
  if (key === "spend_limit") return "Spend limit";
  const m = /^seven_day_(.+)$/.exec(key);
  if (m) return `Weekly limit · ${m[1].replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}`;
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// Each window: { key, name, short, pct, resets (ms) | null, reset (true once resets has passed:
// the saved % is then the old window's, so it shows 0), spend ("$x / $y …") }.
function usageWindows(usage) {
  return Object.entries(usage?.rate_limits ?? {})
    .filter(([, w]) => w && typeof w.used_percentage === "number")
    .map(([key, w]) => {
      const r = w.resets_at;
      const resets = typeof r === "number" ? (r < 1e12 ? r * 1000 : r) : typeof r === "string" ? Date.parse(r) || null : null;
      const reset = Boolean(resets && resets <= Date.now());
      const short = key === "five_hour" ? "5h" : key === "seven_day" ? "wk" : null;
      const spend = typeof w.used_usd === "number" && typeof w.limit_usd === "number"
        ? `$${w.used_usd.toFixed(2)} / $${w.limit_usd.toFixed(2)}${w.period ? ` this ${w.period}` : ""}` : null;
      return { key, name: limitName(key), short, pct: reset ? 0 : Math.max(0, Math.min(100, Math.round(w.used_percentage))), resets, reset, spend };
    })
    .sort((a, b) => (a.key === "five_hour" ? -1 : b.key === "five_hour" ? 1 : a.key.localeCompare(b.key)));
}

// "3:10 PM", with the weekday when it isn't today ("Mon 9:00 AM").
function clock(ms) {
  const d = new Date(ms), now = new Date();
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
  const time = `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
  return d.toDateString() === now.toDateString() ? time : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${time}`;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const resetText = (w) => (w.reset ? `Reset at ${clock(w.resets)}` : w.resets ? `Resets at ${clock(w.resets)}` : "");

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.prs = {}; // "<folder>|<branch>" → { pr, error?, at }
    this.syncing = new Set(); // folders being synced
    const p = props() ?? {};
    if (p.repo) {
      // "+ New branch": a name box (shown on click), Enter = `git switch -c <name>` from the current branch.
      this.newBox = InputState.new({ placeholder: "New branch name, Enter to create" });
      this.newBox.on("submit", (_e, cx) => this.createBranch(cx));
      return this.initRepos({ dirs: [p.repo.dir], status: p.repo.status, prs: p.repo.prs }, cx);
    }
    if (p.repos) return this.initRepos(p.repos, cx);
    if (p.usage) return this.initUsage(cx, false);
    this.initUsage(cx, true);
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
      if (ticks % 3 === 0 || this.wsKey !== this.readKey) this.readRepos(cx); // at once on a new workspace
    });
  }

  // Plan usage from statusline.cjs's file. The bar watches the folder and redraws only when a
  // number changes (or a window resets: it then shows 0 with no new payload); the popup rereads
  // every 5 s so its "updated … ago" moves on.
  initUsage(cx, watch) {
    this.usage = null;
    this.usageSig = "";
    const check = (cx) => {
      const s = JSON.stringify(usageWindows(this.usage).map((w) => [w.key, w.pct, w.reset, w.resets, w.spend]));
      if (s !== this.usageSig) { this.usageSig = s; cx.notify(); }
    };
    const read = (cx) => cx.spawn(async (cx) => { this.usage = await readUsageFile(); check(cx); });
    read(cx);
    if (watch) {
      cx.spawn(async (cx) => {
        await mkdir(USAGE_DIR(), { recursive: true }).catch(() => {});
        for (;;) {
          try { await watchFolder(USAGE_DIR()); } catch { await cx.sleep(60000); }
          read(cx);
        }
      });
      cx.timer.every(30000, check);
    } else cx.timer.every(5000, (cx) => { read(cx); cx.notify(); });
  }

  openUsage(anchor) {
    const n = Math.max(1, usageWindows(this.usage).length);
    const height = 34 + n * 58 + 30 + 10;
    openOverlay({
      mod: "my-status", kind: "popup", width: USAGE_POPUP_W, height,
      at: { x: Math.max(4, anchor.x - USAGE_POPUP_W + 60), y: Math.max(4, anchor.y - height) },
      props: { usage: true },
    });
  }

  // Each limit: name, % used, a bar, when it resets; then how fresh the numbers are.
  usagePopup(t) {
    const uw = usageWindows(this.usage);
    const W = USAGE_POPUP_W - 10 - 16; // the bar's width: the popup less its padding
    const tone = (pct) => (pct >= 90 ? t.blocked : t.accent);
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(h_flex().h(30).flex_none().px(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().child("Plan usage"))
        .child(div().id("usage-page").cursor_pointer().hover(s => s.text_color(t.foreground)).tooltip("Open claude.ai's usage page")
          .on_click((_e, cx) => cx.open_url("https://claude.ai/settings/usage")).child("claude.ai ›")))
      .when(!uw.length, el => el.child(div().h(58).px(8).flex().items_center().text_color(t.muted)
        .child("No usage yet: it comes from a running Claude's status line.")))
      .children(uw.map((w) => v_flex().h(58).flex_none().px(8).py(6).gap(6)
        .child(h_flex().items_center()
          .child(div().flex_1().truncate().text_color(t.foreground).child(w.name))
          .child(div().flex_none().text_color(w.pct >= 90 ? t.blocked : t.muted).child(`${w.pct}% used`)))
        .child(div().h(6).w(W).flex_none().rounded(3).bg(t.hover)
          .child(div().h(6).w(Math.round((W * w.pct) / 100)).rounded(3).bg(tone(w.pct))))
        .child(div().text_size(11).text_color(t.dim).child([resetText(w), w.spend].filter(Boolean).join(" · ")))))
      .child(div().h(30).flex_none().px(8).flex().items_center().text_size(11).text_color(t.dim)
        .child(this.usage?.at ? `Updated ${ago(this.usage.at)}, from Claude's status line` : ""));
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
    this.readKey = this.wsKey;
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


  // A popup's own reads while open (statuses every 4 s, PRs on open and every minute).
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
        if (Date.now() - (this.prsAt ?? 0) > 60000) this.readPrs(ws.dirs, cx);
      });
    };
    this.reread = read;
    read(cx);
    cx.timer.every(4000, read);
  }

  readPrs(dirs, cx, force) {
    if (this.lookingUp && !force) return;
    this.lookingUp = true;
    this.prsAt = Date.now();
    cx.spawn(async (cx) => {
      const list = dirs.filter((d) => this.repos[d]?.branch).map((d) => ({ folder: d, branch: this.repos[d].branch, oid: this.repos[d].oid }));
      const got = await prsFor(list);
      for (const [k, v] of Object.entries(got)) this.prs[k] = { ...v, at: Date.now() };
      this.lookingUp = false;
      cx.notify();
    });
  }

  // The known PRs and statuses of some repos, to hand to the next popup so it shows them at once.
  handOver(dirs) {
    const status = {}, prs = {};
    for (const d of dirs) {
      const st = this.repos?.[d] ?? this.git?.[d];
      if (!st) continue;
      status[d] = st;
      const k = `${d}|${st.branch}`;
      if (this.prs[k]) prs[k] = this.prs[k];
    }
    return { status, prs };
  }

  // The git popups (one at a time; going between them closes one and opens the other in its
  // place). `anchor` = where the bar item is: the popup's bottom edge sits just above it (at the
  // pointer, popups ran off the window's bottom). They're sized to their content.
  // List: { repos: { root, name, dirs, focus } }. A repo's page: { repo: { dir, info }, back }.
  openList(ws, anchor) {
    const height = 40 + Math.min(ws.dirs.length, 12) * ROW + 10;
    const h = this.handOver(ws.dirs);
    openOverlay({
      mod: "my-status", kind: "popup", width: 640, height,
      at: { x: Math.max(4, anchor.x), y: Math.max(4, anchor.y - height) },
      props: { repos: { ...ws, status: { ...ws.status, ...h.status }, prs: { ...ws.prs, ...h.prs } }, anchor },
    });
  }

  openPage(dir, back, anchor, cx) {
    cx.spawn(async () => {
      const info = await branchInfo(dir);
      if (!info) return notify({ title: "Not a git repo", body: dir, level: "warning" });
      const notes = (info.agentsHere > 1 ? 1 : 0) + (info.dirty ? 1 : 0);
      // title row, notes, up to 10 branches, the "New branch" row, padding
      const height = 34 + notes * 26 + Math.min(info.branches.length, 10) * 30 + 34 + 16;
      const st = this.repos?.[dir] ?? this.git?.[dir] ?? null;
      const pr = st ? this.prs[`${dir}|${st.branch}`] : null;
      if (props()?.overlay) closeOverlay(props().overlay);
      openOverlay({
        mod: "my-status", kind: "popup", width: back ? 640 : 440, height,
        at: { x: Math.max(4, anchor.x), y: Math.max(4, anchor.y - height) },
        // what's known of it, under git's own name for the folder
        props: { repo: { dir: info.root, info, status: st ? { [info.root]: st } : {}, prs: pr ? { [`${info.root}|${st.branch}`]: pr } : {} }, back, anchor },
      });
    });
  }

  // Each repo of a dev container's workspace: name, branch (click = its page: switch, new
  // branch), ahead/behind, changes, PR, Sync; Sync all at the top. The bar's repo has a dot.
  repoList(t) {
    const { repos: ws, anchor } = props();
    const all = ws.dirs.filter((d) => this.repos[d]);
    const anySyncing = all.some((d) => this.syncing.has(d));
    const after = (cx) => { this.reread?.(cx); this.readPrs(ws.dirs, cx, true); };
    const row = (dir) => {
      const g = this.repos[dir];
      const name = baseName(dir);
      const here = pathKey(dir) === pathKey(ws.shown ?? "");
      return h_flex().id(`repo-${name}`).h(ROW).flex_none().px(8).gap(12).rounded(7).items_center().hover(s => s.bg(t.hover))
        .child(h_flex().w(160).flex_none().gap(6).items_center().id(`rn-${name}`).cursor_pointer()
          .tooltip(`${dir}\n${here ? "On the status bar" : "Click: show it on the status bar"}`)
          .on_click(() => { setShared(SHOWN, { ...(shared(SHOWN) ?? {}), [pathKey(ws.root)]: dir }); closeOverlay(props().overlay); })
          .child(div().size(6).flex_none().rounded(3).when(here, s => s.bg(t.accent)))
          .child(div().min_w(0).truncate().text_color(t.foreground).child(name)))
        .child(!g ? div().flex_1().text_color(t.dim).child(g === null ? "can't read it from here" : "…") : h_flex().id(`rb-${name}`).flex_1().min_w(0).gap(6).items_center()
          .text_color(t.muted).cursor_pointer().hover(s => s.text_color(t.foreground)).tooltip("Switch branch, new branch")
          .on_click((_e, cx) => { const h = this.handOver(ws.dirs); this.openPage(dir, { ...ws, status: { ...ws.status, ...h.status }, prs: { ...ws.prs, ...h.prs } }, anchor, cx); })
          .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none())
          .child(div().min_w(0).truncate().child(g.branch ?? "?"))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)))
        .child(div().w(64).flex_none().text_color(g?.behind ? t.accent : t.muted).child(this.counts(g)))
        .child(div().w(84).flex_none().truncate().text_color(t.muted).child(g?.dirty ? `${g.dirty} change${g.dirty === 1 ? "" : "s"}` : ""))
        .child(div().w(70).flex_none().child(this.prLink(t, dir, g, false)))
        .child(this.syncButton(t, dir, g, false, after));
    };
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(h_flex().h(30).flex_none().px(8).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().truncate().child(`Repos · ${ws.name} (dev container workspace)`))
        .child(h_flex().id("sync-all").gap(6).items_center().cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .tooltip("Fetch and pull (fast-forward) every repo")
          .on_click((_e, cx) => this.sync(all, cx, after))
          .child(this.syncIcon(anySyncing)).child(anySyncing ? "syncing…" : "Sync all")))
      .child(v_flex().id("repos").flex_none().h(Math.min(ws.dirs.length, 12) * ROW).overflow_y_scrollbar().children(ws.dirs.map(row)));
  }

  counts(g) { return g ? [g.ahead > 0 && `↑${g.ahead}`, g.behind > 0 && `↓${g.behind}`].filter(Boolean).join(" ") : ""; }
  syncIcon(spin) { const s = svg("mods/my-status/sync.svg").size(12); return spin ? s.spin(900) : s; }

  // A repo's PR: "#N" (or "PR #N" with `long`), a dim "…" while looking, "no PR".
  prLink(t, dir, g, long) {
    const pr = g?.branch ? this.prs[`${dir}|${g.branch}`] : null;
    const name = baseName(dir);
    if (!pr) return div().text_color(t.dim).child(g?.branch ? "…" : "");
    if (!pr.pr) return div().id(`nopr-${name}`).text_color(t.dim).child(pr.error ? "PR ?" : "no PR").when(Boolean(pr.error), s => s.tooltip(pr.error));
    const state = pr.pr.isDraft ? "draft" : pr.pr.state.toLowerCase();
    return h_flex().id(`pr-${name}`).gap(5).items_center().cursor_pointer()
      .text_color(state === "merged" ? t.ansi5 : state === "closed" ? t.dim : t.muted).hover(s => s.text_color(t.foreground))
      .tooltip(`${pr.pr.title} (${state}) · open`)
      .on_click((_e, cx) => cx.open_url(pr.pr.url))
      .child(svg("mods/workspace-chrome/git-compare.svg").size(12)).child(`${long ? "PR " : ""}#${pr.pr.number}`);
  }

  // Fetch, then pull --ff-only; with `label`, "Sync" / "syncing…" beside the icon.
  syncButton(t, dir, g, label, after) {
    const syncing = this.syncing.has(dir);
    return h_flex().id(`sync-${baseName(dir)}`).gap(6).flex_none().justify_center().items_center().text_color(t.muted)
      .when(!label, s => s.w(18))
      .when(Boolean(g), s => s.cursor_pointer().hover(s => s.text_color(t.foreground))
        .tooltip(g.upstream
          ? `Fetch and pull (fast-forward) · ${g.upstream}${g.behind ? ` · ${g.behind} to pull` : ""}${g.ahead ? ` · ${g.ahead} to push` : ""}`
          : "Fetch · no upstream branch to pull from")
        .on_click((_e, cx) => this.sync([dir], cx, after)))
      .child(this.syncIcon(syncing))
      .when(label, s => s.child(syncing ? "syncing…" : "Sync"));
  }

  // After a switch or a new branch: back to the list (it reads the new branch), else close.
  leavePage(cx) {
    const { back, anchor, overlay } = props();
    closeOverlay(overlay);
    if (back) this.openList(back, anchor);
  }

  // `git switch -c <name>` off the current branch (spaces become "-"); git's refusal shows in the popup.
  createBranch(cx) {
    const { repo } = props();
    const root = repo.dir;
    const name = this.newBox.value().trim().replace(/\s+/g, "-");
    if (!name || this.switching) return;
    this.switching = name; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("git", ["switch", "-c", name], { cwd: root }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.switching = null;
      if (r.code) { this.error = (r.stderr || r.stdout || "git switch -c failed").trim(); cx.notify(); }
      else { notify({ title: `On new branch ${name}`, body: baseName(root) }); this.leavePage(cx); }
    });
  }

  // One repo's page: its upstream, ahead/behind, PR and Sync on top, then its local branches
  // (click = `git switch`; git's refusal shows here) and "New branch…". From the list, ‹ goes back.
  repoPage(t) {
    const { repo, back, anchor, overlay } = props();
    const { dir, info } = repo;
    const { branches, agentsHere, dirty } = info;
    const g = this.repos[dir];
    const note = (text, color) => div().px(8).h(26).flex_none().flex().items_center().text_size(11.2).text_color(color).child(text);
    const pick = (name, cx) => {
      this.switching = name; this.error = null; cx.notify();
      cx.spawn(async (cx) => {
        const r = await exec("git", ["switch", name], { cwd: dir }).catch((e) => ({ code: 1, stderr: String(e) }));
        this.switching = null;
        if (r.code) { this.error = (r.stderr || r.stdout || "git switch failed").trim(); cx.notify(); }
        else this.leavePage(cx);
      });
    };
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .child(h_flex().h(30).flex_none().px(8).gap(12).items_center()
        .when(Boolean(back), el => el.child(h_flex().id("back").gap(4).items_center().cursor_pointer().text_size(11).text_color(t.dim)
          .hover(s => s.text_color(t.foreground)).tooltip("Back to the repos")
          .on_click(() => { closeOverlay(overlay); this.openList(back, anchor); })
          .child(svg("mods/workspace-chrome/chevron-left.svg").size(12)).child("Repos")))
        .child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().text_color(t.foreground).child(baseName(dir)))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(g?.upstream ?? "")))
        .child(div().flex_none().text_color(g?.behind ? t.accent : t.muted).child(this.counts(g)))
        .child(div().flex_none().child(this.prLink(t, dir, g, true)))
        .child(this.syncButton(t, dir, g, true, (cx) => { this.reread?.(cx); this.readPrs([dir], cx, true); })))
      .when(agentsHere > 1, el => el.child(note(`${agentsHere} agents work in this repo: their files change too`, t.blocked)))
      .when(dirty > 0, el => el.child(note(`${dirty} uncommitted change${dirty === 1 ? "" : "s"} come along (or git refuses)`, t.muted)))
      .when(Boolean(this.error), el => el.child(div().px(8).py(5).text_size(11.2).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("branches").flex_none().h(Math.min(branches.length, 10) * 30).overflow_y_scrollbar().children(branches.map((b) => h_flex()
        .id(`br-${b.name}`).h(30).flex_none().px(8).gap(8).rounded(7).items_center()
        .text_color(b.current ? t.foreground : t.muted)
        .when(!b.current, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => pick(b.name, cx)))
        .child(h_flex().w(14).flex_none().justify_center().when(b.current, el => el.child(svg("mods/workspace-chrome/check.svg").size(13).text_color(t.accent))))
        .child(div().flex_1().truncate().child(b.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.switching === b.name ? "switching…" : b.when)))))
      .child(div().h(1).mt(1).mb(2).flex_none().bg(t.border))
      .child(this.naming
        ? h_flex().id("new-branch").h(30).flex_none().px(8).gap(8).items_center()
          .child(h_flex().w(14).flex_none().justify_center().child(svg("mods/workspace-chrome/plus.svg").size(13).text_color(t.dim)))
          .child(div().flex_1().min_w(0).h(26).px(6).flex().items_center().rounded(6).bg(t.background).border(1).border_color(t.input)
            .text_color(t.foreground).child(Input.new(this.newBox)))
          .when(Boolean(this.switching) && !branches.some((b) => b.name === this.switching),
            el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("creating…")))
        : h_flex().id("new-branch").h(30).flex_none().px(8).gap(8).rounded(7).items_center()
          .text_color(t.muted).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(`New branch from ${branches.find((b) => b.current)?.name ?? "HEAD"}, switch to it`)
          .on_click((_e, cx) => { this.naming = true; cx.notify(); cx.timer.after(30, () => this.newBox.focus()); })
          .child(h_flex().w(14).flex_none().justify_center().child(svg("mods/workspace-chrome/plus.svg").size(13)))
          .child(div().flex_1().truncate().child("New branch…")));
  }

  render() {
    const t = theme();
    if (props()?.repo) return this.repoPage(t);
    if (props()?.repos) return this.repoList(t);
    if (props()?.usage) return this.usagePopup(t);
    // Plan usage: "5h 17% · wk 37%" (click = the popup); amber from 90%.
    const uw = usageWindows(this.usage);
    const usageText = uw.some((w) => w.short) ? uw.filter((w) => w.short).map((w) => `${w.short} ${w.pct}%`).join(" · ") : uw.length ? `${uw[0].pct}%` : "";
    const usageTip = [...uw.map((w) => `${w.name}: ${w.pct}% used${w.resets ? ` · ${resetText(w).toLowerCase()}` : ""}`),
      this.usage?.at ? `Updated ${ago(this.usage.at)}` : null, "Click: details"].filter(Boolean).join("\n");
    const space = spaces().find(s => s.active);
    const list = agents();
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const folder = space && !space.machine ? (focused()?.cwd || space.folder) : "";
    const button = (id, icon, text, what) => label(icon, text).id(id).cursor_pointer().hover(s => s.text_color(t.foreground))
      .tooltip(`${what === "code" ? "Open in VS Code" : "Open in Explorer"}: ${folder}`)
      .on_click(() => openFolder(folder, what));
    const f = focused();
    // A dev container's workspace: all its repos in the popup, and on the bar the one picked
    // there (else the focused terminal's), by name.
    const ws = space && !space.machine ? this.workspace(f, space, folder) : null;
    const wsKey = ws ? `${ws.root}|${ws.dirs.join("|")}` : "";
    if (wsKey !== this.wsKey) { this.wsKey = wsKey; this.ws = ws; } // readRepos reads this.ws
    const picked = ws ? (shared(SHOWN) ?? {})[pathKey(ws.root)] : null;
    const shown = ws ? (ws.dirs.find((d) => picked && pathKey(d) === pathKey(picked)) ?? ws.dirs.find((d) => inside(folder, d)) ?? null) : null;
    const gitDir = shown ?? folder;
    this.folder = gitDir; // what readGit reads on its next tick
    const g = gitDir ? this.git[gitDir] : null;
    // git's own answer first; Herdr's until it has been read (or on another machine).
    const branch = g?.branch || (gitDir === folder ? (f?.pane && panes().find(p => p.pane === f.pane)?.branch) || space?.branch : null);
    this.key = gitDir && branch ? `${gitDir}|${branch}` : null;
    const pr = this.key ? this.prs[this.key]?.pr : null;
    const prState = pr ? (pr.isDraft ? "draft" : pr.state.toLowerCase()) : "";
    const known = ws ? ws.dirs.map((d) => [d, this.repos[d]]).filter(([, r]) => r) : [];
    const othersBehind = known.filter(([d]) => d !== shown).reduce((s, [, r]) => s + r.behind, 0);
    // One git item: the bar's repo (in a dev container, by name), its branch and how far
    // ahead/behind, and "· N repos". Click = the repos list (dev container) or this repo's page.
    const counts = this.counts(g);
    const text = [branch && `${shown ? `${baseName(shown)}: ` : ""}${branch}${counts ? ` ${counts}` : ""}`, ws && `${ws.dirs.length} repos`].filter(Boolean).join(" · ");
    const tip = ws
      ? [`Repos in ${ws.root} (dev container)`, ...known.map(([d, r]) =>
        `${d === shown ? "• " : ""}${baseName(d)}: ${r.branch}${r.ahead ? ` ↑${r.ahead}` : ""}${r.behind ? ` ↓${r.behind}` : ""}${r.dirty ? ` · ${r.dirty} changed` : ""}`),
        "Click: pick the repo shown here, sync, switch branch"].join("\n")
      : [g?.upstream ? `${g.upstream}${g.behind ? ` · ${g.behind} to pull` : ""}${g.ahead ? ` · ${g.ahead} to push` : ""}` : null,
        g?.dirty ? `${g.dirty} uncommitted change${g.dirty === 1 ? "" : "s"}` : null, "Click: sync, switch branch, new branch"].filter(Boolean).join("\n");
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .when(Boolean(text), el => el.child(label(branch ? "branch" : "layers", text).id("git")
        .when((g?.behind ?? 0) + othersBehind > 0, s => s.text_color(t.accent))
        .when(Boolean(folder) && (Boolean(ws) || Boolean(g)), s => s.cursor_pointer().hover(s => s.text_color(t.foreground)).tooltip(tip)
          // mouse down, not click: it carries where (the popup goes above the bar)
          .on_mouse_down("left", (e, cx) => {
            const anchor = { x: e.position.x - 16, y: e.position.y - (e.local_position?.y ?? 8) - 8 };
            if (ws) this.openList({ root: ws.root, name: ws.name, dirs: ws.dirs, shown }, anchor);
            else this.openPage(folder, null, anchor, cx);
          }))))
      .when(Boolean(folder), el => el.child(button("open-folder", "folder", "Folder", "folder")).child(button("open-code", "file-text", "VS Code", "code")))
      .when(Boolean(pr), el => el.child(label("git-compare", `PR #${pr.number}`).id("open-pr").cursor_pointer()
        .when(prState === "merged", s => s.text_color(t.ansi5)).when(prState === "closed", s => s.text_color(t.dim))
        .hover(s => s.text_color(t.foreground))
        .tooltip(`${pr.title} (${prState}) · open`)
        .on_click((_e, cx) => cx.open_url(pr.url))))
      .child(div().flex_1())
      .when(Boolean(usageText), el => el.child(label("clock", usageText).id("usage").cursor_pointer()
        .when(uw.some((w) => w.pct >= 90), s => s.text_color(t.blocked))
        .hover(s => s.text_color(t.foreground)).tooltip(usageTip)
        .on_mouse_down("left", (e) => this.openUsage({ x: e.position.x, y: e.position.y - (e.local_position?.y ?? 8) - 8 }))))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(`${window()?.platform === "macos" ? "⌘" : "Ctrl"} Shift P  commands`))
      // The machine, last: rarely looked at (the user's call 2026-11-01).
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"));
  }
}
