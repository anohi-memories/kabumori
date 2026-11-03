# F6 J1 R1/R2 修正（共通Claude API、source-only）

- 日付: 2026-10-16（JST）
- task_id: `common-ai-f6-j1-import-timeout-security-fix-20261015`
- 指摘の出どころ: `.agent_v2/reports/J1.md`（V1、CHANGES_REQUIRED、P2 × 2）
- 土台: Draft PR #205（`4cd2cbdd`）。順番 #187 → #198 → #205 → この PR は変えない
- 本番・台帳・Secret・Edge・Cron の変更は無い。有料の呼び出しも無い

## 1. R1: 読み込みの検査の穴をふさぐ（`isolation_test.ts`）

### 何が問題だったか

- 許可された H5 の bridge が `import("../ai_provider/mod.ts")` と書くと、検査は気づかなかった。静的な `import ... from` しか読んでいなかったため。`mod.ts` の公開名がすべて（`executeAiRequest`、台帳、Secret の読み手など）使えてしまう
- 検査が追えない道筋（計算で作った読み込み先、import map の別名、シンボリックリンク、読めないフォルダ、存在しないファイル）は「届かない」と数えられていた

### どう直したか（許可リストは広げていない）

- **追えないものは止める（fail closed）**
  - `import()` の引数が文字列そのもの以外（変数、足し算、`${}`、エスケープ）→ 止める
  - `npm:` / `jsr:` / `node:` / `https://` 以外の、相対でない読み込み先（別名、絶対パス、`file:`、`data:`、`http:`）→ 止める
  - 相対の読み込み先が、読んだファイルの中に無い（存在しない、大文字小文字が違う、隠しフォルダや `node_modules` の中、functions の外）→ 止める
  - シンボリックリンク、読めないフォルダ、読めないファイル → 止める（たどらない、黙って飛ばさない）
  - 読み込み先を付け替えられる設定（`deno.json` / `deno.jsonc` / `import_map*.json` の `imports`・`scopes`・`importMap`・`workspace`・`links`・`patch`、すべての `package.json`）→ 止める
- **動的な読み込みも名前の決まりに入れた**
  - `import()` は「全部の名前（`*`）」として数える。`*` を許された読み手はいないので止まる
  - 名前の決まりを `mod.ts` だけでなく、モジュールのどのファイルにも広げた（`AUTHORIZED_PROVIDER_IMPORTS`）。市況レポートの `handler.ts` も、`market_report_primary.ts` から今の 4 つの名前しか取れない。これは決まりを狭める変更で、広げていない
- **ソースの生の文字列を読む**
  - 以前はコメントを消してから読んでいた。`"a//b"` のような文字列があると、同じ行の後ろの `import` まで消えて見落とした
  - いまはコメントも文字列も消さずに読む。コメントの中の読み込みも数える（止める側に倒れる）
  - `from "x"` が普通の import / export の形でないとき（SQL や文中の言葉）は、相対でない限り読み込みとして数えない（誤検知を避ける）
- モジュールの名前の検索を大文字小文字を区別しないようにした（`AI_PROVIDER/` も見つける）

### 確かめたこと

- 本物のファイルでの比較（直す前 `4cd2cbdd` の検査と、直した後の検査に、同じ細工をして実行。シンボリックリンクと読めないフォルダも本物）

| 細工 | 直す前 | 直した後 |
|---|---|---|
| M1 J1 の再現そのもの（bridge に `import("../ai_provider/mod.ts")`） | 見逃す | 止める |
| M2 bridge で `await import("../ai_provider/mod.ts")` | 見逃す | 止める |
| M3 計算で作った読み込み先で bridge を読む新しいファイル | 見逃す | 止める |
| M4 `deno.json` の import map の別名＋その別名での読み込み | 見逃す | 止める |
| M5 bridge のフォルダへの本物のシンボリックリンク経由 | 見逃す | 止める |
| M6a handler が primary から台帳の部品も取る | 見逃す | 止める |
| M6b handler が primary を `export *` で丸ごと出す | 見逃す | 止める |
| M7 本物の読めないフォルダに置いた中継ファイル経由 | 見逃す | 止める |
| M8 `../_shared/AI_PROVIDER/mod.ts`（大文字） | 見逃す | 止める |
| M9 `"a//b"` の文字列の後ろの `import` | 見逃す | 止める |
| 以前の回帰 3 つ（別名での `executeAiRequest`、新しい Edge が bridge を使う、bridge が private な台帳ファイルを読む） | 止める | 止める |
| 普通の読み込み（相対、`npm:`、型だけ、JSON、動的な文字列そのまま） | 通す | 通す |

- テストの中の合成の木でも、J1 の求めた全部（動的な名前空間、計算した道筋、別名、シンボリックリンク、export-star / 中継、読めない道筋）と、普通の読み込みが通ることを確かめる（`J1 R1:` で始まる 2 つのテスト）。シンボリックリンクと読めないものは、フォルダの読み手を差し替えて確かめる（テストはファイルを書かない）

## 2. R2: 課金されたか分からない送信を、自動で送り直さない（`retry.ts`）

### 何が問題だったか

- `retryOnTimeout: false` は、こちらの時間切れ（`TIMEOUT`）しか止めていなかった
- provider の 504 / `timeout_error`、送信後の切断（`NETWORK`）、その他の 5xx は、`maxAttempts` が 2 以上なら送り直していた。どれも課金された可能性がある（`maybeBilled`）。1 つの呼び出しで 2 回払うことがありえた

### どう直したか

- **送り直すのは、provider が「処理していない」と返した失敗だけ**（`isKnownUnsent`）
  - 429（`RATE_LIMITED`）と、529 / OpenAI の 503（`OVERLOADED`）
  - かつ `retryable` で、`maybeBilled` でないもの。条件はそれぞれ単独でも効く
- それ以外（時間切れ、504 / `timeout_error`、送信後の切断、500 / 502 / Anthropic の 503 など）は、`maxAttempts` に関係なく 1 回で終える
- `retryOnTimeout: true` は、鍵を読む前・予約の前・送信の前に `REQUEST_INVALID` で断る。黙って無視はしない。型も `retryOnTimeout?: false` にした
- 曖昧な失敗を送り直す仕組み（opt-in）は作っていない。作るなら、呼び出しごとの支出の上限を決めた別の方針を、別のレビューと承認で作る
- 変えていないもの
  - エラーの分類（`errors.ts`）と、結果の `retryable`。`retryable: true` は「後で新しい操作としてやり直せば通るかもしれない」という意味のまま
  - 台帳の流れ（予約 → 送信の確認 → 送信 → 精算）と費用の計上
  - 市況レポートの `primary_both`（もともと 1 回だけ。テスト 324 件そのまま通る）
  - OpenAI の adapter（テストそのまま通る）。市況レポートの旧経路 `transport_retry.ts` も触っていない
  - モデルや provider の自動切り替えは無いまま

### 確かめたこと

- J1 の再現（bridge、`maxTransportAttempts: 2`、504 `timeout_error` のあと 200）: 直す前は 2 回送る → 直した後は 1 回だけ。台帳は予約 1 つ、精算は `unknown`
- 新しいテスト（`ambiguous_retry_test.ts`、台帳の `(callId, attempt)` の決まりを真似た偽物の台帳を使う）
  - 504 / `timeout_error`（Anthropic と OpenAI）、送信後の切断: `maxAttempts: 3` でも 1 回。`unknown`・最大額で精算。他の provider やモデルへは行かない
  - 500 / 502 / Anthropic 503: 1 回
  - こちらの時間切れ: 1 回。`retryOnTimeout: true` は何もせずに断る
  - 429 / 529 / OpenAI 503: `maxAttempts` の範囲で送り直す。各回が予約・送信の確認・精算（0 円）を通る。`maxAttempts: 1` なら 1 回
  - 429 のあと 504: 2 回目で終わる（課金の可能性がある送信は 1 回まで）
  - 送信の確認（mark_sent）が記録された後に応答が失われた: 何も送らない。送信済みの行は解放しない。呼び直しても許可が出ない
  - `unknown` で精算済みの呼び出しを同じ `callId` で呼び直す: `ATTEMPT_FINALIZED` で何も送らない
  - まとめての上限: 上限を超える呼び出しは送る前に断る。送り直しも呼び出し回数の上限に数える
- 新しいテストを直す前のコードに当てると、`execute_test.ts`・`ambiguous_retry_test.ts`・`model_policy_test.ts` で 11 件が落ちる（§3 の手順。このブランチでは 43 件すべて通る）。`errors_test.ts` は新しい関数（`isKnownUnsent`）が無いので読み込みで止まる。送信の確認の消失と 429 / 529 のテストは、直す前から正しい動きを固定するもの
- わざとコードを壊す確認（10 種類）は、すべてテストが気づいた

## 3. 自分で再現する方法

リポジトリの checkout の中で、順に実行する（`../j1-before` は作業用の別フォルダ。終わったら `git worktree remove ../j1-before`）。

```bash
git fetch origin
git worktree add --detach ../j1-before 4cd2cbdd51a68bc537cd0fc81dc8f1c7ee059f21
git -C ../j1-before checkout origin/claude/f6-j1-r1-r2-fix-20261016 -- supabase/functions/_shared/ai_provider/execute_test.ts supabase/functions/_shared/ai_provider/ambiguous_retry_test.ts supabase/functions/_shared/ai_provider/model_policy_test.ts
deno test --no-check --cached-only --frozen --config ../j1-before/supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS ../j1-before/supabase/functions/_shared/ai_provider/execute_test.ts ../j1-before/supabase/functions/_shared/ai_provider/ambiguous_retry_test.ts ../j1-before/supabase/functions/_shared/ai_provider/model_policy_test.ts
```

- 上は R2 の「直す前は落ちる」（`--no-check` は、直す前の型 `retryOnTimeout?: boolean` との違いで止まらないようにするため。型の確認は別にこのブランチで行う）。同じテストをこのブランチで流すと通る
- R1 は、直す前の `isolation_test.ts` に、上の表の細工（例: J1 の再現を `_shared/ai_consumer_bridge/bridge.ts` の末尾に足す）をすると通ってしまい、このブランチの `isolation_test.ts` では落ちる

## 4. 残るリスク

- 読み込みの検査は CI の検査で、実行時の囲い（sandbox）ではない。`eval` や `new Function`、`Worker` に渡す文字列で読み込むことまでは見ない（いまの functions には無い）
- functions の外の設定（リポジトリ直下の `deno.json` / `package.json`、`supabase/config.toml` の `import_map`、deploy のときの `--import-map`）は読んでいない。`config.toml` は main に無い
- `from "x"` が普通の import の形でないとき、相対でない読み込み先は数えない（SQL や文を誤検知しないため）。ただし別名の設定が止まるので、そういう読み込み先がこの木のファイルに解決されることはない
- ~~500 / 502 / Anthropic 503 は送り直さなくなったが、費用は今まで通り「課金なし（0 円）」で精算する~~ → J1 の再レビュー（A1）を受けて、課金の可能性ありとして最大額で精算するよう直した（`F6_J1_R1A_A1_FIX.md`）
- コメントを挟んだ `import/* x */(...)` などが検査をすり抜けた（J1 の再レビュー、R1a）→ 直した（`F6_J1_R1A_A1_FIX.md`）
- 呼び出し元が、失敗のあと新しい `callId` / 新しい操作で呼び直せば、それは新しい有料の呼び出しになる。それを決めるのは呼び出し元（H5 の bridge は同じ operationId を重複させない）

## 5. H5 への引き継ぎ（H5 のファイルは変えていない）

- H5 の `ai_consumer_bridge/isolation_test.ts` は静的な `from` しか読まない。bridge の動的な読み込みは、この PR の F6 の検査が止める。H5 の検査を強くするかは H5 の判断（必須ではない）
- bridge の例（`maxTransportAttempts: 2`）は、この PR の後、429 / 529 だけを送り直す。504 や時間切れは 1 回で終わる。bridge の費用の前もっての確認（1 回の上限 × `maxTransportAttempts`）は、そのままで安全側
- `H5_M2_CONSUMER_BRIDGE.md` の「retry limit」は、「処理されなかったと分かる拒否だけを、その回数まで」と読める書き方に直すとよい

## 6. 変更したファイル

- `supabase/functions/_shared/ai_provider/retry.ts`、`types.ts`、`execute.ts`（説明だけ）、`model_policy.ts`（説明だけ）
- テスト: `isolation_test.ts`、`errors_test.ts`、`execute_test.ts`、`model_policy_test.ts`、新しい `ambiguous_retry_test.ts`
  - `execute_test.ts` の 11 / 14 / 15 / 21 は、古い決まり（5xx・切断・時間切れを送り直す）を固定していたので、新しい決まり（1 回で終わる）に書き換えた。どれも送る回数を少なく確かめる向きで、弱めてはいない
- 文書: `PROVIDER_CONTRACT.md`（§2、エラーの表、§5）、`F6_M1_ANTHROPIC_MULTIMODEL.md`（`maxTransportAttempts` の行）、この文書
- `PHASE0_DESIGN.md` の再試行の表（`SERVER_ERROR` 1 回まで）は当時の設計の記録なので変えていない。今の決まりは `PROVIDER_CONTRACT.md` §5
