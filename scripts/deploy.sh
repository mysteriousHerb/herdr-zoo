#!/usr/bin/env sh
# Copy this repo's layouts and mods into Herdr's folder; Herdr hot-reloads them.
# Only copies: it never deletes (remove files there by hand when they go from the repo).
# programs.json is per computer and not copied: the chat's ⚙ popup adds the dev container entry.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

mkdir -p "$home/layouts/.deployed" "$home/mods"
# A layout is copied only when the repo's copy changed since the last deploy (kept in
# layouts/.deployed/): Herdr writes the deployed file too (layout.set folds the person's dragged
# sizes into it, and the quick terminal's tray adds its terminals there), and an unchanged repo
# copy shouldn't undo that.
for f in "$repo"/layouts/*; do
  name=$(basename "$f")
  if ! cmp -s "$f" "$home/layouts/.deployed/$name" || [ ! -e "$home/layouts/$name" ]; then
    cp "$f" "$home/layouts/$name"
    cp "$f" "$home/layouts/.deployed/$name"
  fi
done
for mod in "$repo"/mods/*/; do
  name=$(basename "$mod")
  mkdir -p "$home/mods/$name"
  cp -r "$mod". "$home/mods/$name/"
  herdr-app check "$home/mods/$name"
done
echo "deployed to $home"
