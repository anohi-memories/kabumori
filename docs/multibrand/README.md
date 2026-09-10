# 複垢化（マルチブランド）開発環境

対象ブランド（予定）: かぶモリ（`kabumori`）/ 会社員AIラボ / みお

この文書は、本番のかぶモリを壊さずに複垢化を開発するための作業ルールです。プロジェクト全体のルールは `PROJECT_RULES.md` を優先します。

## 構成

| 項目 | 内容 |
|---|---|
| 作業ディレクトリ | `/Users/yuya/Developer/kabumori-multibrand`（git worktree。本番共有チェックアウト `/Users/yuya/Developer/kabumori` の**外側**に置く） |
| 統合ブランチ | `feature/multibrand-foundation`（`origin/main` 910cbeb 起点） |
| 作業ブランチ | 工程ごとに `feature/multibrand-<工程名>` を切り、統合ブランチへマージする |
| main への反映 | 切替計画（移行SQL・deploy手順・ロールバック手順）の合意までは行わない |
| Supabase | ローカル専用の `supabase/config.toml`（`project_id = "kabumori-multibrand-local"`、未追跡）。remote には **link しない** |
| 検証手段（現在） | Deno 単体テスト（fetch をモックするため本番に接続しない）。基準: 680件 passed |
| 検証手段（将来） | Docker Desktop 導入後、`supabase start` でローカル DB と Edge Function を起動 |

### 作業ディレクトリを本番チェックアウトの外に置く理由

Supabase CLI は、カレントディレクトリから親へさかのぼって最初に見つかった `supabase/config.toml` をプロジェクトのルートとして使います。本番チェックアウトの `supabase/config.toml` と `supabase/.temp/`（link 情報）は git 管理外なので、worktree を `kabumori/` の中に作ると、CLI が本番チェックアウトまでさかのぼり、**本番に link された状態のまま、本番チェックアウト側のコードを deploy する**事故が起きます（2026-09-10 に実際に発生）。この worktree は外側にあり、かつ自前の config.toml を持っているため、この経路はありません。

確認済み: この worktree から `supabase functions list` / `supabase db query --linked` を実行すると、どちらも `Cannot find project ref` で失敗します。

## 作業前チェック

```bash
bash scripts/multibrand/check-safe-env.sh
```

`SAFE` 以外が出たら、Supabase のコマンドを実行しないこと。

## 禁止事項（この worktree で）

- `supabase link` / `--project-ref wsmznyzcvmuitkglfeuj` の指定
- `supabase functions deploy` / `supabase db push` / `supabase secrets set` / `supabase migration repair`
- 本番チェックアウトの `.env` や `supabase/.temp/` のコピー
- 本番 DB への書き込み、Cron の変更、X への実投稿

本番に読み取り専用で確認したいことがある場合は、本番チェックアウト側で行い、変更系のコマンドは実行しない。

## config.toml の再作成（worktree を作り直した場合）

`supabase/config.toml` は、本番チェックアウトの未追跡ファイルと衝突させないため、コミットしていません。作り直すときは次の内容で作成します。

```toml
project_id = "kabumori-multibrand-local"

[functions.x-test-post]
verify_jwt = false

[functions.important-news-monitor]
verify_jwt = false

[functions.send-push-notifications]
verify_jwt = false
```

## 移行方針（実装時の原則）

- DB 変更は**追加だけ**にする。`brand_id` 列は `default 'kabumori'` で追加し、既存行と既存コードの挙動を変えない。
- 既存の unique 制約は、新しい制約（`brand_id` を含む）を追加した後で差し替える。
- X トークンは、既存の `provider='x'` 行をそのまま `kabumori` の行として扱い、既存の環境変数（`X_OAUTH2_*`）へのフォールバックはかぶモリだけに限定する。
- 新ブランドは `is_active=false` で作成し、ブランドごとに明示的に有効化する。
- 同じ内容や似た内容を複数アカウントへ自動投稿しない（X の自動化ルールに違反し、凍結のリスクがある）。ブランド間でネタの重複を防ぐ仕組みを設計に含める。

調査結果は [SURVEY.md](SURVEY.md) にまとめています。正式アーキテクチャ設計（承認待ち）は [ARCHITECTURE.md](ARCHITECTURE.md) です。
