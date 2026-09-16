# Codex Task 2

- task_id: kabumori-news-url-removal-cost-control-20260916
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol Medium
- purpose: かぶモリのXニュース投稿から外部URLを原則外し、URL付きX投稿のAPI原価を抑える。ニュース本文自体の要約・株への影響・Fact/Voice安全策は維持する。

## User decision / source of truth

2026-09-16 JST、ユーザーはX APIのURL付き投稿コストが高いことを踏まえ、かぶモリの通常ニュース投稿ではURLを付けない方針を明示し、「とりあえず早急にそれやるべき」と変更を承認した。

方針:
- 通常のかぶモリ自動ニュース投稿はURLなしを標準にする。
- ニュース内容は本文だけで読める形を維持する。
- ニュース取得元URL/出典情報をDB内部に保持している場合、それは削除しない。今回止めるのはXへ公開する投稿本文へのURL付与。
- 将来、自社記事/note/重要導線など明示的にURLを付けたい投稿は別設定・別枠で扱う。今回それらまで一律禁止する設計変更はしない。

## Mandatory startup / parallel safety

開始前に必ず読む:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CLAUDE_TASK_1.md`
- `.agent/tasks/CLAUDE_TASK.md`
- fresh `origin/main`

最優先の競合ルール:
- H1が現在AI Lab live testで`x-test-post` / OAuth / AI Lab posting windows / planner周辺を所有している可能性がある。
- URL付与箇所が`supabase/functions/x-test-post/**`またはH1が触っている同一workflow/fileにある場合、同時変更してはいけない。実装を開始せず、具体的な競合ファイルをReportしてSTOPする。
- URL付与がH1と完全分離された別function/fileであるとfresh-checkで証明できる場合のみ実装してよい。
- G2のmorning-greeting image cost gate、G1のnews observation範囲とも同じファイル/workflowを触らない。
- 既存未コミット変更は他workstreamの所有物として扱う。

## Phase A — exact source identification

まずread-onlyで、かぶモリの自動ニュースX投稿にURLがどこで付与されているか特定する。

最低限確認:
- URLが生成prompt由来か、publish前の文字列連結か、DB保存済み本文に含まれるか
- 対象post_type / news path
- Xへ送る最終本文を組み立てる関数/ファイル
- URL削除がニュース以外（朝刊、大引け、挨拶、tips、AI Lab brand_post等）へ波及しないか
- URLを除いても出典/source URLがDB内部・アプリ内部で必要なら保持されるか

対象が曖昧なら変更せずSTOP。

## Goal

かぶモリの通常ニュース自動投稿についてのみ、Xへ送信する最終本文に外部URLを含めない。

期待:
- ニュース本文の要点/株への影響/ハッシュタグ等、既存の非URL部分は可能な限り不変
- Fact/Voice/dedupe/fingerprint/publish guardの順序と意味を変えない
- source URL自体の収集・DB保存・アプリ表示用途は壊さない
- AI Lab / Mio / Kabumoriの非ニュース投稿に影響しない
- media挙動は変更しない

## Tests

少なくとも:
- 対象ニュース投稿本文に`http://` / `https://`が含まれない
- URL以外の既存本文が維持される
- 非ニュース投稿が不変
- source URL metadataが必要箇所で保持される
- dedupe/fingerprintが意図せず壊れない
- 対象周辺の既存テスト
- `deno check`（対象TS）
- `git diff --check`

可能ならURLありfixture→最終X本文URLなしの明示テストを追加する。

## Production boundary

このTASKではまずsource修正・テスト・candidate pushまで。

C2前に禁止:
- production Edge Function deploy
- manual/synthetic X投稿
- Cron変更
- posting_windows変更
- OAuth/Vault/token変更
- DB/schema/RPC/migration変更
- `supabase db push`
- source URLデータの削除
- AI Lab/Mio設定変更

## Completion

実装可能で競合なしの場合:
- `status: review_required`
- `next_owner: chatgpt`
- `.agent/CODEX_REPORT_2.md`へReport
- candidate commit/branchを明記
- changed files、tests、URL removal scope、non-news regression、安全確認を記録
- production changesは0のままC2へ渡す

競合で実装不可の場合:
- 同じく`review_required`
- 競合ファイル/workflowを具体的にReport
- H1完了後の最短再開手順を記録

このタスクの目的は『かぶモリ通常ニュースのX本文からURLを外す』だけで、アプリ全体のURL課金設計や将来のURL付き投稿機能は別タスクとする。

## Completion report

- result: implemented and locally verified; C2 review required
- implementation_commit: `bd97a56` (`Remove external URLs from news X posts`)
- changed_files: `supabase/functions/important-news-monitor/publish_logic.ts`, `supabase/functions/important-news-monitor/publish_logic_test.ts`
- url_scope: source URL remains in candidate generated text/metadata and all existing Fact/Voice/dedupe/fingerprint checks; only the final important-news X publisher input removes `http://`/`https://` links and the trailing 出典 URL line
- tests: focused publish suite 19/19; full important-news suite 407/407; `deno check --no-config supabase/functions/important-news-monitor/publish_logic.ts` PASS; `git diff --check` PASS
- production: deploy 0, DB/schema/RPC/migration/Cron/settings 0, OpenAI/X/API calls 0, X posts 0
