#!/bin/bash
# G1 TASK 43: the media box screen on the REAL local Supabase (never a managed project, nothing deployed). Builds the runner from G5's own
# (build-media-box.py), makes real PNG / JPEG / MP4 files (sips, AVFoundation), and runs tests/local-stack/media-box.e2e.mjs on it.
# Needs what G5's runner needs (supabase CLI 2.116.0, podman with the images, deno, psql, the pinned commits fetched) plus
# `npm ci` in apps/social-mobile and Xcode's swift. Optional: G1MB_AFTER=<executable> runs while the stack is still up.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$here" rev-parse --show-toplevel)"
[ -d "$REPO/apps/social-mobile/node_modules/@supabase/supabase-js" ] || { echo "G1MB_APP_DEPS: run npm ci in apps/social-mobile"; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/g1mb-run.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
fx="$WORK/fixtures"
mkdir -p "$fx"
# a real PNG (G5's 1x1, scaled to 64x64), a JPEG made from it, a 1-second H.264 MP4
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$fx/one.png"
sips -z 64 64 "$fx/one.png" --out "$fx/cafe.png" >/dev/null
sips -s format jpeg "$fx/cafe.png" --out "$fx/menu.jpg" >/dev/null
xcrun swift "$here/make-media-fixtures.swift" "$fx/clip.mp4" >/dev/null 2>&1 || { echo "G1MB_FIXTURE_MP4_FAILED"; exit 2; }
[ "$(file -b "$fx/cafe.png" | cut -c1-9)" = "PNG image" ] && [ "$(file -b "$fx/menu.jpg" | cut -c1-10)" = "JPEG image" ] && file -b "$fx/clip.mp4" | grep -q "ISO Media" \
  || { echo "G1MB_FIXTURES_UNEXPECTED"; exit 2; }
python3 -I "$here/build-media-box.py" "$REPO" "$WORK/run.sh" >/dev/null
cd "$REPO"
G1MB_FIXTURES="$fx" bash "$WORK/run.sh"
