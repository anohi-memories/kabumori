"""G10 Phase 2 実行係（偽Claudeのみ）。

仕様: PHASE2_SPEC_v5.md ＋ v5.1〜v5.4 の差分（Mac上の phase2-spec フォルダが原本）。
このパッケージは、実Claude CLI を起動する経路を持たない。実行できるのは、
同梱の偽Claude（fake_claude/fake_claude.py）だけ（adapter.py）。
"""

SPEC_BASIS = "PHASE2_SPEC_v5 + v5.1..v5.4 (interim)"
