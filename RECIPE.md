# Herdr Zoo

Herdr's usual window (spaces sidebar, tab bar, terminals, status bar) where the agents list
becomes a zoo: every agent is a small animated 3D creature on its own isometric tile that acts out
what the agent is doing. It walks while the agent works, shakes its head and jumps when the
agent needs you, cheers when it's done, and idles faded out. The middle of the window shows a
Claude Code agent as a chat (markdown, tool calls, diffs, sub-agents, question cards) with a
Chat / Terminal switch back to the real terminal. The creatures also appear in the tab bar and in
the agents list, and the zoo plays its own sounds when an agent needs you or finishes.

## What you see

Left to right. Root colours: `selection` `#4f7cff59` (translucent, so selected chat text stays
readable), `done` `#8a8f98` (a calm gray in place of the theme's blue). Root background `canvas`,
1px `border` dividers, no title bar, terminal padding 14×12.

- **Sidebar**, 268px, `chrome` background, top to bottom:
  - Brand row, 46px (Herdr's `workspace-chrome`, draggable window area).
  - Spaces list (Herdr's `spaces`), weight 1, min 90px.
  - The **Zoo / Agents** area, weight 2, min 90px. Its 41px header reads "Agents  Zoo" (11.5px,
    medium; the one showing in `foreground`, the other `dim` and clickable) with a ♪ button (14px)
    at the right on both sides (on the Agents side after the sort button). Zoo shows by default.
    - **Zoo**: pens wrap two to a row (each 122px wide, rounded 12, 8px vertical padding) and the
      area scrolls down. Each pen, top to bottom: a speech bubble (22px tall, radius 11, max 120px,
      11px semibold), the creature (scaled to fit 110×68 and at most 1.5×, so most are 68px tall)
      standing on an 80×50 tile (grass, water, or a cloud for flyers), the agent's name (12px) and
      its space's name (10.5px), both `foreground`, regular weight, centred, truncated. The
      focused agent's pen has the `selected` background; hover is `hover`. When an agent has
      Claude sub-agents at work, an 18px pill sits in the pen's top right corner: a 7px `working`
      dot and the count, `working` border on `background`. Empty: "The zoo is empty. Start an
      agent from the + in the tab bar."
    - **Agents**: Herdr's agents list (30px rows) with each row's icon replaced by the agent's
      creature at 24px, in the same animation as in the zoo. Sort button (Priority / Grouped by
      space), pins and Herdr's sub-agent tree as in the stock list.
  - Footer, 69px (Herdr's `workspace-chrome` footer).
- **Work column**:
  - **Tab bar**, 42px, `chrome`. Tabs 29px tall, radius 7, 12.8px text; the active one `raised`
    with a `border` outline. A tab with an agent shows its creature at 20px in place of the
    program icon; working = spinner, blocked/done = 6px dot in that status colour; × on the
    active tab. Then +, Files, Changes, and the window buttons.
  - **Body**, 8px padding and gap: a stack of **Chat** (default) and **Terminal**, both rounded
    10 with a 1px `border`, and Herdr's Files/Changes panel (hidden, 368px, 280–900px).
    - **Chat**: a 34px header on `chrome` (8px status-coloured dot, the agent's title, "space ·
      address" in 11px `dim`, a fork icon, ⚙, and a Chat / Terminal pill switch), then the
      conversation, then the composer on `chrome`: sub-agent chips, the status line, and a
      text box "Message Claude…  (Enter sends, Shift+Enter: new line)" that grows 1–8 lines.
      Claude's replies are markdown after an 8px accent dot; your messages are full-width boxes;
      tool calls are one-line rows; sub-agents are cards.
    - **Terminal**: the active tab's panes, each with a 30px header (program icon, name, folder,
      status) on `background`; a Claude pane's header ends in the same Chat / Terminal switch.
  - **Status bar**, 28px, `chrome`, 11.8px `muted`: git branch, Sync (with ↑N ↓M), Folder,
    VS Code, PR #N, "N sub-agents working" (when any), then right-aligned "Ctrl Shift P  commands"
    and the machine ("This computer").

## How it behaves

Pens are sorted needs-you first, then done, working, idle; most recently changed first within
each. The zoo also sets Herdr's agent order to match.

- **Working**: the creature walks. The bubble (`working` text on 15% `working`) shows Claude's
  own live verb ("Galloping…") read off its screen every 2s; other agents get code symbols
  cycling every 220ms (`{ }`, `</>`, `=>`, …).
- **Blocked**: the creature plays its "no" animation and jumps 10px every 520ms; the bubble
  "needs you!" (`blocked` on 20% `blocked`) pulses 0.4→1 opacity every 700ms. The chosen sound plays.
- **Done**: the creature plays its "yes" animation (Mini characters jump); bubble "✓ done" in
  `done` gray. The chosen sound plays.
- **Idle**: the creature plays its idle loop at 60% opacity, the tile at 50%; the bubble is a
  plain `dim` "zZz".

Clicks and keys:

- **Click a pen** (or a list row): focus that agent's pane. Hover tooltip: the creature's name,
  sub-agent count, "right-click for more".
- **Right-click a pen, a list row, or a tab with an agent**: a 220px popup titled "space · name"
  with Rename (Herdr asks for the tab name), Change character…, Open folder, Open in VS Code,
  Close agent. Closing a working or blocked agent asks first (Herdr's `confirm` dialog).
- **Change character…**: a 740×580 dialog, one tab per pack (Cube Pets 24, Blocky 18, Mini 12),
  a grid of creatures; the current one outlined in `accent`, other agents' ones at 40% opacity
  (picking one swaps the two). The tick box on each pack tab says whether new agents can get
  that pack (only Cube Pets at first). The pack's Kenney credit is at the bottom.
- **♪**: a 560×640 dialog "Zoo sounds", two columns ("When an agent needs you", "When an agent
  finishes"): a volume slider (0–100%, 5% steps; letting go saves and plays it), then Herdr's
  chime, every MP3 in `mods/zoo/sounds/` (each with ▶ preview), Silent. Clicking a choice plays it.
- **Agents  Zoo** header: flips between the zoo and the list (Herdr remembers which).
- **Tab bar**: click selects, double-click renames, drag reorders, wheel switches tabs, × on a tab
  with an agent asks first. **+** opens the new-tab menu: Terminal (Ctrl T), then under "Start an
  agent" Claude, Claude (dev container), Codex, OpenCode (installed ones only, Ctrl 1–4), New
  space (Ctrl N), New worktree…, Open worktree….
- **Chat / Terminal switch** (chat header or a Claude pane header): flips the stack; from a pane
  header it focuses that pane first. A new Claude tab opens on the chat ("Starting Claude…",
  then the empty chat); a tab with no Claude flips to Terminal once, and back when a Claude runs.
- **Chat**: Enter sends (typed into Claude's terminal), Shift+Enter is a new line. `/` opens
  Claude's command menu (↑↓, Tab fills in, Enter runs, Esc closes); commands that open a TUI menu
  (`/model`, `/config`, …) switch to the Terminal. Stop presses Esc. Pasting an image puts it in
  Claude's prompt ("🖼 1 image … Remove"). Tool rows open on click; Edit/Write rows show
  "+N −M" and open as a red/green diff with line numbers (up to 400 lines). Earlier turns fold
  their work into one row "▸ 12 tools · 3 messages". A sub-agent card shows type, task, model and
  live progress, and opens its whole conversation ("‹ Main chat" to go back). Scrolled up,
  "↑ Previous message" and "↓ Newest" float over the log. A pending question is a card with
  options, tick boxes and Submit; any other prompt shows the bottom of Claude's screen with
  1 / 2 / 3 / Enter / Esc buttons. Fork (header) opens a copy of the conversation in a new tab;
  the fork icon on any of your messages copies it up to the reply before that message.
- **⚙**: text size 10–22, Sans/Mono, Full/Narrow (820px column), tool calls Show/Hide, earlier
  turns Fold/Show, accent (theme or `#d97757`, `#4f8cff`, `#3fb950`, `#a371f7`, `#f778ba`), your
  messages Box/Tint/Bar, background (theme colours, five swatches or hex), text colour, spacing.
- **Status bar**: branch → popup of local branches to `git switch` to; Sync = fetch, then
  fast-forward pull; Folder / VS Code open the focused terminal's folder; PR opens on GitHub;
  the sub-agent count focuses the agent with the most.

## Built from

Layout `layouts/zoo.json`, a copy of Herdr's `main` (keep its ids `sidebar`, `panel`,
`panel-body`, `tabs`: the tab bar finds blocks by id):

```
root (row)
├─ sidebar (column, 268px, chrome)
│  ├─ brand        46px   workspace-chrome
│  ├─ sidebar-lists (column)
│  │  ├─ spaces    weight 1   spaces
│  │  └─ agents    stack, weight 2, active agents-zoo
│  │     ├─ agents-list  zoo-agents  {stack:"agents", other:"agents-zoo"}
│  │     └─ agents-zoo   zoo         {side:true, stack:"agents", other:"agents-list"}
│  └─ sidebar-footer 69px workspace-chrome {footer:true}
└─ work (column)
   ├─ tabs  42px  my-tabs
   ├─ work-body (row, padding 8, gap 8)
   │  ├─ views  stack, active chat
   │  │  ├─ chat  claude-chat {stack:"views", self:"chat", other:"main"}
   │  │  └─ main  {tab:"active", pane:{…, header:{content:{mod:"my-pane",
   │  │           props:{stack:"views", other:"chat"}}, height:30, position:"top", reveal:"always"}}}
   │  └─ panel (hidden, 368px) → panel-body stack: files, changes
   └─ status 28px  my-status
```

Our mods (all `"place": "none"`):

- `zoo`: pens (props `{side}` = sidebar grid; without it, a horizontal strip with 128px pens),
  plus its own overlays by props: `{menu}` agent menu, `{pick}` character picker, `{sounds}`
  dialog. Calls `agents`, `spaces`, `panes`, `hc read`, `setAgentOrder`, `pane.focus`,
  `layout.select`, `tab.rename`, `pane.close` / `terminal.kill`, `playSound`, `exec` (`code`,
  folder open). A 1s timer assigns creatures and plays sounds even while the list is in front.
- `zoo-agents`: clone of `agents` (0.1.9); creature icons, the view switch, the zoo's menu.
- `my-tabs`: clone of `tabs` (0.1.9); creature icons, + opens `my-new-menu`, agent right-click
  opens the zoo's menu (others keep Herdr's `menu`), × confirm.
- `my-new-menu`: clone of `new-menu` (0.1.9); fixed agent order via `knownAgents`.
- `my-pane`: clone of `pane` (0.1.10); the Chat / Terminal switch on `app === "claude-code"` panes.
  Its icons load from the shipped `mods/pane/`.
- `my-status`: clone of `workspace-status` (0.1.10); runs `git status --porcelain=v2 --branch`
  every 3s, `git fetch --prune` / `pull --ff-only` / `switch`, `gh pr view` (once a minute).
- `claude-chat`: finds the Claude under a terminal's shell (process tree: `Get-CimInstance` on
  Windows, `ps` elsewhere) → `~/.claude/sessions/<pid>.json` → transcript
  `~/.claude/projects/<cwd with non-alphanumerics as ->/<session>.jsonl`, read incrementally on
  `watchFolder` plus a 2s tick; sub-agents from `<session>/subagents/agent-*.jsonl` and
  `.meta.json`. Sends with `hc send`, `hc keys` (`esc`, `alt+v`), `hc send --force` for a
  question's typed answer. Forks with `tab.new` running `claude --resume <id> [--fork-session]`.
  `commands.js` is Claude Code's `/` menu (101 entries); `question.js` the question card.

Shipped mods used: `workspace-chrome` (brand, footer, icons), `spaces`, `files`, `changes`,
`confirm`, `menu`, `worktree`, `pane` (icons). Shared state: `zoo.sprites` (address → `pack/id`),
`zoo.packs`, `zoo.sounds`, `zoo.volume`, `chat.look`, `chat.subs` (address → sub-agents at work).

`programs.json` adds `claude-dev-container` ("Claude (dev container)"). **Optional**: it runs a
dev container from a `../harness-agent` checkout beside the space's folder, and the + menu hides it
when that folder is missing. The chat reads a dev-container Claude's transcript through docker.

**Art: reuse the files, don't redraw.** The creatures are Kenney's CC0 Cube Pets, Blocky
Characters and Mini Characters, pre-rendered to GIFs in `mods/zoo/packs/<pack>/<id>/` (one per
state: work = walk, blocked = no gesture, done = yes gesture / jump, idle = idle loop; 20 fps,
longest side 112px = 2× display, 30° isometric). `mods/zoo/packs/<pack>.json` lists each
creature's name, display size and tile; `scripts/make_packs.py` merges them into `sprites.js`,
copied into `zoo`, `zoo-agents` and `my-tabs`. Tiles are `mods/zoo/tiles/{grass,water,sky}.png`
(80×50). Sounds are the MP3s in `mods/zoo/sounds/` (Kenney jingles and interface sounds, five
original effects) and `mods/zoo/silent.mp3`. A rebuild copies all of these as they are.

## Watch out

- A mod can't import from another mod's folder: `sprites.js`, the view switch and the agent-name
  helpers are duplicated. Image paths are app-relative (`mods/zoo/packs/…`), so `zoo-agents` and
  `my-tabs` need the `zoo` mod installed.
- Herdr caches images by path, misses included: a changed GIF needs a new file name (the `-1`,
  `-2` suffixes).
- Mods run on Herdr's UI thread and every animation keeps the window redrawing. Keep slow work in
  spawned processes (the fork's transcript cut runs in PowerShell / `sh`; done in the mod it hit
  Herdr's time limit). Restart Herdr after many deploys.
- Herdr 0.1.9 ignores `settings.json` `sounds.done` / `sounds.blocked` (always its chime). The zoo
  plays sounds itself on status changes and sets `sounds.enabled: false`, so sounds only play
  while this layout is up. `playSound` has no volume: `volume.js` writes quieter MP3 copies (each
  frame's `global_gain` lowered) to `data/zoo/volume/`, ahead of time. `writeFile` of bytes leaves
  an empty file, so bytes go out as base64 and a shell decodes them. MP3 only.
- `os.platform()` is `"windows"` here, not `"win32"`: test `/^win/`.
- Chat text is Herdr's `TextView`, which only uses the theme's `foreground`; the ⚙ text colour is
  written to `settings.json` `colors.foreground` and recolours all of Herdr. Layout `colors` take
  hex only, not theme names.
- GPUI scrollers can't be scrolled from code: the chat log is a custom scroller pinned to the
  bottom. Double-click then drag in chat text doesn't extend the selection (Herdr's).
- Stop is Esc, not `hc interrupt` (that is Ctrl+C; a second one quits Claude). Esc can't stop a
  background task; the chat says so after 3s. Image paste is Claude's own key: `alt+v` on Windows.
- Question answers move Claude's cursor with up/down + Enter; digit keys also land in the prompt.
- A fresh `--fork-session` copy has no transcript until its first new message ("No transcript
  yet"). Fork copies are written into `~/.claude/projects`.
- Never display a dev-container Claude's process command line: it carries the container's env.
- `programs.json` replaces one the person already has; merge by hand.
- Reaches outside its folder: reads `~/.claude`, writes `settings.json`, runs `git`, `gh`
  (network), `powershell`/`ps`, `docker`, `code`, `claude`.

## Done when

- `herdr-app check` passes for every mod, `layout.switch zoo` works, `herdr-app status` shows no
  errors, and `herdr-app shot` shows the sidebar zoo, tab bar, Chat view and status bar.
- Starting Claude from + opens a tab whose creature appears in its tab, a pen, and the list;
  the Chat shows "Starting Claude…", then the empty chat, and a message typed there reaches Claude.
- While Claude works its pen walks with the live verb in the bubble; when it asks something the
  pen jumps with a pulsing "needs you!", the chat shows the question card, and the sound plays;
  when it finishes the bubble says "✓ done" and the done sound plays; once looked at, it idles
  faded with "zZz".
- Right-click a pen: the five-item menu; Change character… swaps creatures between agents.
- ♪ opens the sounds dialog; a choice and a slider release both play.
- "Agents  Zoo" flips the sidebar both ways; Chat / Terminal flips the work area both ways, from
  the chat header and from a Claude pane header.
- The status bar shows the branch, and "1 sub-agent working" while a Claude sub-agent runs.
