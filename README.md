# herdr-zoo

Layouts and mods for the [Herdr](https://herdr.dev) desktop app (terminals + coding agents).
Your coding agents live in a little zoo: each one is an animated 3D creature standing on its
own tile, and it acts out what the agent is doing. A Claude Code agent's conversation can also
be read and answered as a chat, next to its terminal.

## What's in it

- **The zoo** (`mods/zoo`): one pen per agent, most urgent first.
  - **Working:** the creature walks, and the bubble shows Claude's live verb ("Reticulating…").
  - **Needs you:** it shakes its head and jumps, with "needs you!" pulsing.
  - **Done:** it nods happily with "✓ done".
  - **Idle:** it idles, faded, with a zZz.

  Click a pen to go to that agent. Right-click it to rename the agent, change its creature,
  open its folder or VS Code, or close it. The ♪ button picks the sounds for "needs you"
  and "done", each with its own volume.
- **Chat view** (`mods/claude-chat`): a Claude Code session as a chat. It shows markdown,
  tool calls that expand, Edit/Write calls as coloured diffs, and sub-agent cards with
  their whole conversation. Questions (`AskUserQuestion`) come up as clickable cards, and
  `/` brings up the slash-command menu. You can paste images and fork the conversation,
  whole or from any of your messages. It works with local agents and with ones running
  in a dev container. A Chat / Terminal switch flips between it and the real terminal.
- **Agents list** (`mods/zoo-agents`): Herdr's agents sidebar with each agent's creature as
  its icon. The "Agents / Zoo" header switches between the list and the zoo, and both
  headers have the ♪ sounds button.
- **Tabs, pane header, status bar, + menu** (`my-tabs`, `my-pane`, `my-status`,
  `my-new-menu`): Herdr's own, with tweaks.
  - Tabs show the agent's creature and name.
  - The status bar shows the git branch and ahead/behind, with a Sync button, the PR link,
    and Folder / VS Code buttons.
  - The + menu offers Claude, Claude (dev container), Codex and OpenCode.
- **Layouts**:
  - `zoo`: the daily one. The spaces sidebar, the agents list or zoo below it, and Chat or
    Terminal in the middle.
  - `zoo-top`: the same without the sidebar. Spaces are pills in a top bar, with the zoo as
    a strip.
  - `board`: a kanban (Needs you / Working / Done) beside the focused agent's terminal.

The creatures are Kenney's [Cube Pets](https://kenney.nl/assets/cube-pets),
[Blocky Characters](https://kenney.nl/assets/blocky-characters) and
[Mini Characters](https://kenney.nl/assets/mini-characters) (CC0), pre-rendered to GIFs. New
agents get a Cube Pet. Turn other packs on with the ticks in the "Change character…" picker.

## Install

You need the Herdr desktop app (built against 0.1.11) and, for the chat, Claude Code.

```sh
git clone https://github.com/mysteriousHerb/herdr-zoo.git
cd herdr-zoo
sh scripts/deploy.sh        # Git Bash on Windows
```

`deploy.sh` copies `layouts/` and `mods/` into `~/.config/herdr-app/` (or
`$HERDR_APP_HOME`) and runs `herdr-app check` on each mod. It only copies and never
deletes. Herdr reloads within a second. Then switch layouts with **Ctrl+Shift+L** and pick
**zoo**. Run `deploy.sh` again after a `git pull`.

### Claude (dev container) (optional)

The + menu can offer a "Claude (dev container)" entry that runs
`devcontainer up` + `devcontainer exec … claude` on the space's folder, so it works for any
space whose folder holds a `.devcontainer` (the standard VS Code layout; it needs the
devcontainer CLI and Docker on this computer). It is on by default (Windows): the first run
adds the entry to `~/.config/herdr-app/programs.json`. To hide it, use the chat's ⚙ (top right
of the Chat view), **+ menu → Claude (dev container) → Off**, which removes the entry (the rest
of the file is kept) and is remembered. To run it on another folder, edit the entry's
`--workspace-folder` in that file (turning it on again won't overwrite it; "Terminal (dev
container)" follows it, a fork of a container chat does not: it always uses the space's folder).

## Status

This is a personal project, mostly built and tested on Windows 11. Some things may need
work elsewhere:

- The chat finds Claude's process with `Get-CimInstance` on Windows.
- Forks are written by PowerShell on Windows and by `sh` elsewhere.

`CLAUDE.md` has the detailed notes: how each piece works, what was verified and Herdr's
runtime quirks. It's written for the coding agents that work on this repo.

## Rebuilding the assets

The rendered GIFs and MP3s are committed, so you don't need this to use the zoo. To
rebuild them, download Kenney's zips by hand into `sprites/` and `sounds/` (both
git-ignored), then run (needs [uv](https://docs.astral.sh/uv/)):

```sh
uv run scripts/render_cube_pets.py
uv run scripts/render_kenney.py blocky
uv run scripts/render_kenney.py mini
uv run scripts/kenney_sounds.py
uv run scripts/make_tiles.py
uv run scripts/make_sounds.py
```

## License

Code: MIT, see [LICENSE](LICENSE). Art and sounds by [Kenney](https://kenney.nl) (CC0).
Five mods start from Herdr's own shipped mods. See [NOTICE](NOTICE) for both. This project
is not affiliated with Herdr.
