#!/usr/bin/env sh
# Copy this repo's layouts, mods and programs.json into Herdr's folder; Herdr hot-reloads them.
# Only copies: it never deletes (remove files there by hand when they go from the repo).
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

mkdir -p "$home/layouts" "$home/mods"
cp "$repo"/layouts/* "$home/layouts/"
cp "$repo"/programs.json "$home/"
for mod in "$repo"/mods/*/; do
  name=$(basename "$mod")
  mkdir -p "$home/mods/$name"
  cp -r "$mod". "$home/mods/$name/"
  herdr-app check "$home/mods/$name"
done
echo "deployed to $home"
