#!/bin/sh
# G10 完了通知のネイティブ窓（AppKit）をビルドする。Xcode の swiftc を使う（追加インストール不要）。
# 出力はパッケージ内 g10runner/g10_notify_window（MacNotifier が既定で探す場所）。release 同梱時もここ。
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="$HERE/g10runner/notify_window.swift"
OUT="$HERE/g10runner/g10_notify_window"
xcrun swiftc -O "$SRC" -o "$OUT"
chmod 755 "$OUT"
echo "built: $OUT"
