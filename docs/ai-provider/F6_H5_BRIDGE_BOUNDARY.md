# F6 — H5 の Claude 利用側ブリッジと、共通AI基盤の安全境界（2026-10-15）

- task_id: `common-ai-f6-h5-consumer-bridge-import-boundary-repair-20261014`
- 積み重ね: main ← #187（F6 M1）← #198（H5 ブリッジ）← この PR
- #187 と #198 は変えていない
- この PR は F6 の持ち物だけを変える（`_shared/ai_provider/` と、この文書）
- 本番・実 API・台帳・Secret・配信は 0。どの機能も ON にしていない

## 1. 3件の失敗の原因（#187 と #198 を合わせた状態）

F6 の `isolation_test.ts` の3件が失敗していた。

| テスト | 原因 |
|---|---|
| provider を参照してよいファイルが決まっている | ブリッジの 5 ファイルが `../ai_provider/mod.ts` / `test_support.ts` を参照していた（runtime 2、テスト 3） |
| deploy 対象で provider に届くファイルが決まっている | `bridge.ts` と `types.ts` が届いていた |
| 広げる方向の変更をすべて拒否する | 上の2つと同じ一覧を前提にしていた |

**テストは緩めていない。** 許可を足したのは、実際の参照ちょうど（ファイルと参照先）だけ。あわせて、次の2つの確認を **新しく足して強くした**。

1. **名前の単位での最小権限**（`AUTHORIZED_MOD_IMPORTS`）
   - `mod.ts` を import する deploy 対象のファイルは、決めた名前しか取れない
   - `bridge.ts` は今使っている 13 個、`types.ts` は 4 個
   - 名前空間の import（`* as`）、`export *`、`SupabaseLedgerBudgetGuard`、`InMemoryBudgetGuard`、`resolveProviderApiKey`、`resolveSecret`、`SecretValue`、`executeAiRequest`（決まりを通らない送信）は、どれも失敗になる
   - 別名を付けた import も、元の名前で数える
2. **Edge 関数の入口**（`AUTHORIZED_ENTRY_POINTS`）
   - provider に届いてよい `<関数>/index.ts` は、今も `market-report-analysis/index.ts` だけ
   - ブリッジはどの関数にもつないでいない
   - 関数がブリッジを import すると、その関数のファイルが「届く」側に出てきて失敗する

拒否の確認に足した例（実際のファイル構成をもとに作った仮の構成）:

- ブリッジが余計な名前を取る（6種類）
- ブリッジが `ledger_guard.ts` を直接参照する
- ブリッジのディレクトリに許可のない新しいファイルやテストを置く
- X の関数やほかの関数の入口がブリッジを読み込む

古い境界（市況レポートの handler）の拒否の確認は、そのまま残している。

## 2. SDK が読む任意の環境変数（`@anthropic-ai/sdk@0.132.1`）

手元のキャッシュにある SDK のソース（`src/client.ts`）と、オフラインの実験で確かめた。

| 環境変数 | 修正前 | 修正後 |
|---|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_LOG` | 読まない（明示しているため） | 読まない |
| `ANTHROPIC_WEBHOOK_SIGNING_KEY` | **読んでいた**（`webhookKey` を渡していなかった） | 読まない（`webhookKey: null`） |
| `ANTHROPIC_CUSTOM_HEADERS` | **毎回読み、送信のヘッダーに混ぜていた** | 読むが、中身は外に出ない |

`ANTHROPIC_CUSTOM_HEADERS` に値があると、修正前は次のように送られていた（オフラインで再現）。

- `x-api-key` が **その値のキーに置き換わる**（費用が別のキーに付く）
- `Authorization` や任意のヘッダーが足される
- `anthropic-version` も変えられる

本番の Edge Secret に、この変数は無い（2026-10-13 に名前で確認）。実害は無いが、F6 の adapter で塞いだ。

- SDK に渡す fetch は、SDK が普段送るヘッダーだけを通す
  - 通すもの: `accept`、`anthropic-version`、`content-type`、`user-agent`、`x-api-key` と、`x-stainless-*`
- `x-api-key`・`anthropic-version`（`2023-06-01`）・`accept`・`content-type` は、adapter 自身の値に固定し直す
- `user-agent` と `x-stainless-*` だけは、まだ値を変えられる。ただし送り先は固定の Anthropic のホストだけ
- `ANTHROPIC_CUSTOM_HEADERS` の読み取り自体は SDK の作りで止められない。運用でも Edge Secret に登録しない（Phase 1d の runbook のとおり）

## 3. H5 への申し送り（必須ではない。F6 は H5 のファイルを変えていない）

1. `offline_run.sh` の `--allow-env` から `ANTHROPIC_WEBHOOK_SIGNING_KEY` を外せる（この PR の後は SDK が読まない）
2. ブリッジの中の `deno.json` と `deno.lock` は、ブリッジのテストの設定。つなぐ関数側の設定と食い違わないか、つなぐときに確かめる
3. 認可（`deps.authorize`）は呼び出し側が渡す。つなぐ担当が、その関数の認可を設計して検証する
4. 呼び出し ID は、テナント・機能・`operationId` から作られる。同じ `operationId` で別の日に呼ぶと、台帳が `ATTEMPT_FINALIZED` で拒否する（二重課金はしない）。`operationId` の決め方は、つなぐ担当が決める

## 4. つなぐ前に必要なもの（どれも別の TASK・別の承認）

- 関数がブリッジを使い始めるとき
  - F6 が `AUTHORIZED_REFERENCES`、`AUTHORIZED_REACHERS`、`AUTHORIZED_ENTRY_POINTS` に、その関数のファイルを足す
  - F6 が `AUTHORIZED_MOD_IMPORTS` を確かめる
- 台帳のポリシー: その機能・モデル・主体（system / user / brand）の枠（本番の DB の変更）
- 機能ごとの品質と費用の評価と、OFF に戻す手順
- テナントの認可と予算の境界（H5 の設計）について、独立したレビュー（Codex Sol（高））
