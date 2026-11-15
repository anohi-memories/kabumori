#!/bin/sh
# G10 完了通知のネイティブ窓（AppKit）をビルドする。Xcode の swiftc を使う（追加インストール不要）。
# 出力2か所:
#   1) パッケージ内 g10runner/g10_notify_window（開発/worktree 実行時に MacNotifier が探す）
#   2) 共有場所 /Users/Shared/g10-bin/g10_notify_window（リリース運用時の既定置き場。yuya 所有・0755）
# 窓はリリース検証外の装飾 UI。MacNotifier は「所有者=自分・group/other 書込不可・実行可能」のときだけ起動する。
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="$HERE/g10runner/notify_window.swift"
PKG_OUT="$HERE/g10runner/g10_notify_window"
SHARED_DIR=/Users/Shared/g10-bin
SHARED_OUT="$SHARED_DIR/g10_notify_window"

xcrun swiftc -O "$SRC" -o "$PKG_OUT"
chmod 755 "$PKG_OUT"
echo "built: $PKG_OUT"

mkdir -p "$SHARED_DIR"
chmod 755 "$SHARED_DIR"
cp "$PKG_OUT" "$SHARED_OUT.tmp"
chmod 755 "$SHARED_OUT.tmp"
mv -f "$SHARED_OUT.tmp" "$SHARED_OUT"
echo "installed: $SHARED_OUT"
