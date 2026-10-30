# V3 将来の自動化との互換仕様（最小・DEFAULT_DENY、候補・未適用）

G10 `orchestration-v3-g10-automation-readiness-default-deny-20261018` で作った**候補**。依頼の出所は Issue #244 のコメント 6248731966。

- 今は何も自動では動かさない。GitHub Actions のworkflow、AIの自動起動、credentialの登録、課金、Vercel / Netlifyの設定、既存のCLI・パーサ・CASには手を入れていない。
- この文書は、将来の自動化を後付けする時に**守る条件**を先に決めておくもの。
- 判定の参照実装は、テストの中だけにある（`tests/agent_v3/automation_readiness.test.ts`）。本番のコードではない。

## 1. すでにある土台（再実装しない）

| 能力 | 場所 |
| --- | --- |
| slotごとに1つのTASK正本（先頭のヘッダー）と、そこから作る索引（`source_digest`・`task_blob`） | `SPEC.md` の1・2 |
| 呼び出し側が見た状態（`task_id`・`status`・TASKのSHA256）の照合。違えば `CONFLICT_SAME_SLOT` | `SPEC.md` の3の2 |
| 1件＝1commit、fast-forwardだけのCAS、読み戻し（5項目）、答えが分からない時は `PUBLISHED_UNVERIFIED` | `SPEC.md` の3・9 |
| 追記だけのarchive（バイトの写し・SHA256・MANIFEST・HISTORY_INDEX・idleへの戻しを1commit） | `SPEC.md` の5 |
| `return_to`・`completion_code` の1対1、状態遷移の制限、上書き禁止 | `SPEC.md` の4、`PROJECT_RULES.md` |
| 安全・方針による拒否は、言い換え・分割・再送をせずに止める | `SPEC.md` の6 |

自動化は、これらを**そのまま使う**。新しいTASK正本、別の状態ファイル、別の書き込み経路は作らない。

## 2. 自動実行の許可情報（任意・既定は拒否）

TASKヘッダーに、任意の `automation_*` 項目を書ける。今のパーサは知らない項目をそのまま読むので、パーサの変更はいらない。**どれか1つでも欠けている、未知の値、条件に合わない場合は、自動実行しない（manualとして扱う）。**

| 項目 | 取れる値 | 意味 |
| --- | --- | --- |
| `automation_mode` | `manual`（既定。項目が無い時もこれ） / `offline_source_only`（将来用） | `manual` なら自動実行しない |
| `automation_executor` | `claude_code` / `codex` | 枠の担当と一致すること（G→`claude_code`、H→`codex`） |
| `automation_allowed_paths` | リポジトリ内の相対パスの前置きを `,` 区切り | 変更してよい範囲。`..`・絶対パス・空の区切りは不可。保護されたパスと重なれば不可 |
| `automation_approval_class` | `offline_no_human` / `human_required` | `offline_source_only` で使えるのは `offline_no_human` だけ。`human_required` は自動実行しない |
| `automation_max_runs` | 整数 1〜3 | 同じ `task_id` の自動実行の最大回数 |
| `automation_budget_usd` | `0` | 有料APIを使わないこと。0以外は自動実行しない |
| `automation_depends_on` | `枠:task_id` を `,` 区切り（最大2件） | 前の工程。全部が受入済み・archive済みであること |

保護されたパス（`automation_allowed_paths` と重なってはいけない）:

`.agent/`、`.agent_v2/`、`.agent_v3_gh/`（ツールの1commitの書き込みだけが触る）、`.github/`、`supabase/`、`PROJECT_RULES.md`、`AGENTS.md`、`CLAUDE.md`、`HANDOFF.md`、`.env`

実行を頼む側（将来のtrigger）は、次を一緒に渡す。TASKは自分のSHA256を持てないので、照合用の値は外から渡す。

- `task_id`
- 承認した時のTASKのSHA256（`show` の `task_sha256`）
- 実行の通し番号（何回目か）

## 3. 自動実行してよい条件（すべて必要）

1. 枠が切り替え表に載っている（V3の枠）。
2. TASKの `status` が `ready` か `in_progress`。
3. 2の許可情報がそろっていて、`automation_mode: offline_source_only`、`automation_approval_class: offline_no_human`、`automation_budget_usd: 0`。
4. 渡された `task_id` とSHA256が、mainの今のTASKと一致する（古いSHAは拒否）。
5. 実行の通し番号が `automation_max_runs` 以下。
6. `automation_depends_on` の各工程が、受入（K / C / L / V）済み、かつarchive済み。
7. 前の工程を含めて、連続して自動で進めるのは**最大3工程**まで。
8. 次のどれにも当たらない（当たれば止める）。
   - `CHANGES_REQUIRED`、未解決のP1 / P2。
   - 答えが分からない公開（`PUBLISHED_UNVERIFIED`）。
   - 未archiveの `done`。
   - 二重割当（用途の組の両方にTASKがある）。
   - 変更するパスや担当の競合、読み戻しの不一致。

自動実行が終わったら、ツールで `review_required / next_owner: chatgpt` にする。受入（K / C）は自動ではしない。`return_to`・`completion_code`・`next_owner` の意味は変えない。

## 4. 必ず人間の承認がいるもの（自動実行の対象にしない）

- Auth / RLS / RPC / DB schema / SECURITY DEFINER
- OAuth / token / Vault / secrets
- SNSへの実投稿、外部APIへの実書き込み
- 有料AI・有料APIの呼び出し
- Cron、EAS
- merge、deploy、managed / productionの操作
- `PROJECT_RULES.md`・各ORCHESTRATION・切り替え表の変更

## 5. 将来のGitHub Actionsに求めること（今は作らない）

- **起動**: 信頼できるtriggerとrefだけ（例: 保護されたmainからの `workflow_dispatch`）。forkやPRの本文、Issueのコメントだけで権限を上げない。
- **権限**: 最小限。書き込みは、ツールの1commitの経路だけ。secretsはログに出さない。
- **同時実行**: 枠ごとに1つ（concurrency）。実行中はlease（期限つき）を持つ。
- **冪等**: 実行キーは `task_id` ＋ TASKのSHA256 ＋ baseのcommit。同じキーでは2回実行しない。
- **期限と取消**: 承認には期限を付ける。人がいつでも取り消せる。
- **監査**: 誰が・いつ・どのキーで実行し、何をcommitしたかを残す。
- **deployの副作用**: mainへのcommitで、Vercelがadminの本番deployを行う（`PILOT_RULES.md` の4）。自動化を有効にする前に、Vercel側の除外を確かめる。

## 6. 拒否の理由コード（テストの参照実装と同じ）

| コード | 意味 |
| --- | --- |
| `MANUAL` | `automation_mode` が無い、または `manual` |
| `UNKNOWN_VALUE` | 許可情報に未知の値がある |
| `MISSING_FIELD` | `offline_source_only` に必要な項目が欠けている |
| `NOT_CUT_OVER` | 枠が切り替え表に無い |
| `BAD_STATUS` | `status` が `ready` / `in_progress` でない |
| `EXECUTOR_MISMATCH` | 担当と `automation_executor` が合わない |
| `HUMAN_APPROVAL_REQUIRED` | `automation_approval_class` が `human_required` |
| `BUDGET_NOT_ZERO` | `automation_budget_usd` が0でない |
| `BAD_PATH` | 許可パスに `..`・絶対パス・空の区切りがある、または保護されたパスと重なる |
| `STALE_SHA` | 渡された `task_id` / SHA256 が今のTASKと違う |
| `RUN_LIMIT` | 実行回数が上限を超える、または上限が1〜3の整数でない |
| `DEPENDENCY_NOT_DONE` | 前の工程が受入済み・archive済みでない |
| `CHAIN_TOO_LONG` | 連続する自動の工程が3を超える |
| `STOP_CONDITION` | 3の8に当たる |

## 7. この仕様を本当に使う前に（別TASK）

1. ルールの改訂（`PROJECT_RULES.md` に、この節への参照と承認の手順を足す）。
2. 判定を、ツールのコード（`scripts/agent_v3/`）に入れる。今の参照実装はテストの中だけ。
3. GitHub Actionsのworkflowを、5の条件で作る（権限・concurrency・監査）。
4. Vercel側の除外の確認。
5. 1枠・1工程の試験運用。

どれも、ユーザーまたは統括の明示的な承認が必要。
