# G9 R2: 外部AI送信ゲートと許諾の表現（2026-10-11 JST）

TASK: `api-optimization-b-g9-r2-licenses-and-external-call-gate-20261011`（API最適化 B / 返却先 K9）
ブランチ: `claude/g9-fixture-rights-cost-eval-20261011`（`b6020dbb` から継続）。変更範囲は `tools/provider-compare/` と `docs/model-optimization/` のみ。

有料API呼び出し・`count_tokens` の実ネットワーク呼び出し・本番DB・実キーは一切使っていない。テストはすべて pure mock とローカルファイル、`--allow-net` なしのサブプロセスで動く。PR #115 は変更していない。

## 1. K9 の指摘と、直したこと

| 指摘 | 原因 | R2 での対応 |
|---|---|---|
| `rights_unconfirmed` の本文が、ハッシュ一致だけで外部へ送れる | `resolveRunnableCases` が一致した本文を「実行可能」にし、live は fixture の種別しか見ていなかった | 外部送信の可否を**別の層**（`external_send_gate.ts`）で、ケースごとに判定。ハッシュ一致・`--runtime-bodies`・`PROVIDER_COMPARE_ALLOW_PAID` はいずれも許諾として扱わない |
| `probe_cli --fixtures legacy` が通る | 既定は rights_safe だったが legacy も受け付け、キー探索が先だった | legacy を**最初に**拒否（`LEGACY_FIXTURES_REFUSED_FOR_EXTERNAL_CALLS`）。キー探索・ケース読込・ネットワークより前 |
| 通常の `cli` が既定で legacy | 既存テストとの互換 | 既定を `rights_safe` に変更。legacy は `--fixtures legacy` の明示時のみ（ローカル専用、live は拒否） |
| ハッシュ一致 ≠ 許諾の表現が無い | 台帳が無い | 許諾台帳 `fixtures/body_licences.json`（空）と記録の形式を定義 |

## 2. 構造（ローカル利用と外部送信の分離）

```
fixture_loader ──(ローカルのみ)──▶ ready cases + provenance + manifest + licences
                                         │
                       planExternalSend()  ← external_send_gate.ts（純粋関数。ネットワーク・env・ファイル無し）
                                         │
              ┌──────────────────────────┴───────────────────────────┐
         allowedCases                                           blocked（理由コード付き）
              │
   cli live / probe_cli だけがこれを使う          dry-run / mock / plan-only は計画を表示するだけ
```

- **ローカル利用**（dry-run の見積もり、mock、`--plan-only`、指標計算）: `--runtime-bodies` で付けた本文を使ってよい。何も外へ出ない。
- **外部送信**（`cli --mode live`、`probe_cli` の models list / count_tokens）: `planExternalSend` が許可したケースだけ。
- **キー探索より前**にゲートを通す。許可ケースが0件なら `EXTERNAL_SEND_NO_ELIGIBLE_CASES` で、キーを探す前に止まる。
- **二重化**: live では provider を `guardProvider` で包み、許可されていない `caseId`、または許可されていないケースの本文（先頭・中央・末尾の50文字）を含むペイロードは、内側の provider を呼ばずに `EXTERNAL_SEND_BLOCKED`（attempts 0、費用 0）を返す。`probe_cli` も送る直前に `assertRequestsSendable` で全リクエストを再確認する。

### 判定規則（`decideExternalSend`）

| 入力 | 判定 | コード |
|---|---|---|
| legacy fixture | 常に不可 | `blocked_legacy_fixtures` |
| manifest 項目なし / 由来が不明 / 由来と権利状態が不一致 | 不可（fail closed） | `blocked_provenance_unknown` |
| 本文なし ＋ ホストが公開利用条件の許可リストにある | 可 | `allowed_no_body` |
| 本文なし ＋ ホストが許可リストに無い（見出しと保存済み投稿が送られる） | 許諾記録が必要（`title`,`recorded_text`） | `blocked_rights_unconfirmed_no_licence` ほか |
| 保存済み本文（open_terms） | 可 | `allowed_open_terms` |
| 実行時に付けた本文（`attached_verified`、rights_unconfirmed） | 許諾記録が必要（`title`,`body`,`recorded_text`） | `blocked_rights_unconfirmed_no_licence` ほか |

出荷時の台帳は**空**なので、TDnet / BBC / Al Jazeera / AP の18件はどの経路でも送れない。

## 3. 許諾の表現（`fixtures/body_licences.json`）

`ハッシュ一致`は「このテキストはマニフェストが指紋を取ったテキストである」ことしか示さない。`--runtime-bodies` の指定や有料実行の opt-in は、運用者の意思であって出版者の許諾ではない。許諾は次の記録でのみ表す。

```json
{
  "caseId": "…",
  "state": "licence_confirmed | denied",
  "scope": "external_provider_send",
  "bodySha256": "<マニフェストの bodySha256 / 本文なしは null>",
  "providers": ["anthropic", "openai"],
  "covers": ["title", "body", "recorded_text"],
  "evidenceRef": "契約番号 / 利用条件URLと取得日 / 書面の返信 など、後から確認できる参照",
  "confirmedBy": "確認者",
  "confirmedOn": "YYYY-MM-DD",
  "expiresOn": "YYYY-MM-DD（任意）"
}
```

- **本文に紐づく**: `bodySha256` が現在の本文と違えば無効（`blocked_licence_hash_mismatch`）。許諾後に本文が変わっても自動では通らない。
- **送信先に紐づく**: 実行が触れる全 provider が `providers` に含まれること（`blocked_licence_provider`）。
- **送信内容に紐づく**: `covers` が `title` / `body` / `recorded_text` を含むこと（`blocked_licence_scope`）。
- **期間**: `confirmedOn` が未来、または `expiresOn` を過ぎていれば無効。
- **否認**: `state: "denied"` の記録があれば、確認記録があっても不可（`blocked_licence_denied`）。出版者の拒否や「利用条件を確認した結果、不可」を残せる。
- **構造検査は厳格**: 不正な記録（短いハッシュ、空の `evidenceRef`、未知の状態など）は読込時に `LICENCE_REGISTER_INVALID` で実行全体を止める。黙って読み飛ばさない。
- **現時点の前提**: 新たな許諾は無い。TDnet / BBC / Al Jazeera / AP は不可のまま。台帳への追記はレビュー対象のコミットとして行い、`evidenceRef` を必須にすることで後から監査できる。台帳に追記しただけで外部送信が始まる（コードの変更は不要）ので、追記は必ず所有者の確認を経ること。

## 4. 送信ペイロードと引用の残余リスク

- 見出し（`title`）と `recorded.generation.text`（本番が保存した投稿文）は、出典の文言を**引用している可能性がある**。本文を外した派生ファイルでも、これらは残っている。
- そのため、(a) 許諾記録は `title` と `recorded_text` を明示的に含めさせ、(b) 本文なしでも許可リスト外のホストのケースは許諾記録を要求し、(c) `cli live` / `probe_cli` は送信前にケースごとの送信内容の大きさ（`titleChars` / `bodyChars` / `recordedTextChars`）を表示する（本文は表示しない）。
- 現在の出荷データで外部送信が許可される4件（公的機関2件の本文付き + 日銀の本文なし2件）は、すべて許可リスト（政府・中央銀行・国連）のホストで、見出しも保存済み投稿も当該ホストの文書に基づく。
- **許可リスト自体**は、リポジトリの方針（`body_policy.ts`）であって、ページ単位の個別確認ではない。許可リストを広げる判断は別の判断として扱う。
- `eval_expansion.json`（本文あり27件）と `eval_nopost_sample.json`（同9件）は `cli` / `probe_cli` からは読み込まれない。本文が入っているのはすべて許可リストのホスト。将来これらを外部送信の経路に載せる場合は、同じゲートを通すこと。
- `judgement_detail` のように、直前のモデルの判定（`reason` など）を入力に含む課題もある。これらも `recorded_text` に含めて扱う。

## 5. 残る権利上の事項（隠さずに記録）

1. **`fixtures/cases.json` には、18件の第三者本文が今も入っている。** 本ブランチでは変更していない（PR #115 のテストが本文を前提とするため、置き換えは所有者の判断）。`legacy` は警告付きでローカル専用に残してある。
2. **Git 履歴にも残っている。** `cases.json` を導入したのは `8f430557`（PR #115 の head）で、`origin/claude/b-claude-api-compare-20261009`、`origin/claude/b-news-eval-prep-20261010`、`origin/claude/g9-fixture-rights-cost-eval-20261011` に含まれる。履歴の書き換え・force push は行っていない。
3. **過去に一度、18件を含む fixture 本文を Anthropic の無料 `count_tokens` へ送っている**（Phase 2 の L0。当時の報告で開示済み）。取り消せない。以後の送信は上記ゲートで止まる。
4. TDnet の PDF 取得は 403（迂回しない）。TDnet の利用条件は未確認のまま。
5. 所有者向けの移行手順は別紙 `PR115_BODY_REMOVAL_MIGRATION_PLAN_2026-10-11.md`。

## 6. 検証

| 項目 | 結果 |
|---|---|
| `deno test --no-config -A tools/provider-compare/` | 299 件すべて成功（既存 284 + 新規 15。既存の1件はテストの前提「既定は legacy」を「既定は rights_safe、legacy は明示」に更新） |
| `deno check` / `deno lint` | 対象ファイルでエラーなし |
| 変異テスト | ゲートの `attached_verified` を無条件許可に書き換えると、8件のテストが失敗することを確認（戻し済み） |
| `rights_safe + runtimeBodies(18) + live` | 18件は blocked（`blocked_rights_unconfirmed_no_licence`）。CLI は `--cases` で TDnet 1件に絞ると、キー探索前に `EXTERNAL_SEND_NO_ELIGIBLE_CASES` |
| 全課題 × 全22件を mock vendor で送信 | 内側の provider に届いた `caseId` に18件は含まれず、届いたペイロードに18件の本文は含まれない |
| `probe_cli --fixtures legacy` | キー探索・ケース読込・ネットワークの前に拒否（`--allow-net` なしのサブプロセスで確認） |
| 既定のオフライン | 安全な4件（公的機関2 + 本文なし2）。2件の公式本文は検証済み。ハッシュ不一致・欠落は従来どおり除外 |
| `--plan-only` | キーを読まず、ネットワークを使わず、送る予定のリクエスト数と許可/不許可の理由を表示 |
