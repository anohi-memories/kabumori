# Codex Task

- task_id: x-multibrand-phase3k-ai-lab-first-live-test-20260916
- owner: codex
- slot: codex-1
- status: in_progress
- next_owner: codex
- priority: high
- recommended_model: Sol High
- purpose: 2026-09-16 JSTから会社員AIラボの実投稿テストを段階的に開始する。OAuth write readinessを安全に本番反映し、本人確認後に1件の制御された実投稿を確認し、その成功時のみ10枠の自動投稿テストを開始する。

## C1 review — 2026-09-16

C1判定: **PASS（Phase A source candidate）**。

承認対象は exact commit `a469dcc50acc443efd65ebb933d527d3b21f5dca`。

確認済み:
- production `x-oauth-connect` v17 の12 runtime filesと一致する既知baseline `13cb948684785cdd189882b7434b981fabf96385`をbaseにしている。
- 実装変更はAI Lab OAuth scopeを `tweet.read users.read offline.access` → `tweet.read users.read tweet.write offline.access` にする最小変更。
- `media.write` / `like.write` / `follows.write` は追加されていない。
- Kabumori scopeは変更していない。
- `ai_salaryman_lab_x` / `kaishain_ai_lab` 固定routing、Vault destination、callback時の `/2/users/me` 本人確認、`publish_mode=dry_run`、`publish_enabled=false` を維持。
- candidate内にX投稿endpoint/media upload追加なし。
- tests 25/25 PASS、changed filesの`deno check` PASS、対象x-oauth-connect filesのfmt check PASS、`git diff --check` PASS。
- C1時点までproduction change / OAuth再認可 / token変更 / X write / media write / window activationは0。

このC1は、上記exact candidateを本番`x-oauth-connect`へdeployしてread-back検証したうえで、既承認の2026-09-16 controlled testを継続することを承認する。範囲外変更が必要になった場合は停止してC1へ戻す。

## Continuation steps

### Phase A — deploy + OAuth reauthorization

1. fresh-check `origin/main`、production Function state、他slot競合を確認。
2. exact commit `a469dcc50acc443efd65ebb933d527d3b21f5dca` の `x-oauth-connect` runtimeだけをproductionへ反映する。`verify_jwt=false`を維持。
3. deploy後sourceをread-backし、承認candidateとbyte-levelで一致確認する。
4. AI Lab account pathだけでOAuth再認可を開始し、要求scopeを正確に以下へする:
   - `tweet.read`
   - `tweet.write`
   - `users.read`
   - `offline.access`
5. callbackで `/2/users/me` usernameが**exactly `kaishain_ai_lab`**であることを確認してからVault-backed token refsを受理する。
6. handle mismatch、scope mismatch、token routing異常があればpublishを有効化せず停止してC1へ戻す。

### Phase B — controlled first real post

Phase A成功後のみ:
- 10 posting windowsはinactiveのまま。
- AI Lab `brand_post`を1件だけproduction pathで準備。
- server-side ruleで280 Unicode code points以下、cross-brand dedupe PASSを確認。
- AI Labのみ `publish_mode=live` / `publish_enabled=true` にする。
- **1件だけ** text-only X postを実行。
- returned X post id、terminal completion、fingerprint/duplicate-resend safety、`kaishain_ai_lab`上への表示を確認。
- uncertaintyがあれば自動retry禁止、10枠は有効化せず停止。

### Phase C — 10-slot test schedule

Phase Bが明確に成功した場合のみ:
- 既存AI Lab `brand_post` 10行だけ `is_active=true`。
- window時刻/timezone/slot/probabilityは変更しない。
- Cron cadence変更なし。
- activation前のmissed slotsをbackfillしない。
- 2026-09-16の残りwindow以降をprospectiveに開始。

## Existing approved schedule

1. 07:30–08:30
2. 09:00–10:00
3. 10:30–11:30
4. 12:00–13:00
5. 13:30–14:30
6. 15:30–16:30
7. 17:30–18:30
8. 19:00–20:00
9. 20:30–21:30
10. 22:00–23:00

All: `brand_id=ai_salaryman_lab`, `post_type=brand_post`, `timezone=Asia/Tokyo`, `daily_probability=1.0`.

## Automatic stop conditions

以下のどれかがあれば10枠をinactiveへ戻し、AI Lab publishingを安全側へ戻せる範囲で戻して停止:
- wrong X account/handle
- duplicate/suspected duplicate
- over-280 dispatch
- Kabumori/Mio route use
- token refresh/routing anomaly
- completion uncertainty / replay risk
- repeated generation loop
- unexpected media call
- 1 slotから複数投稿
- unexpected scheduler/backfill behavior

## Still prohibited

- `media.write` / media upload
- Kabumori OAuth/token/handle/publish/schedule/Cron変更
- Mio変更
- unrelated Function deploy
- unrelated DB/schema/RPC/migration変更
- `supabase db push`
- migration history repair/reconcile
- 10枠の時刻/slot/probability変更
- failed evidence削除
- secret/token/password/2FA表示

## Completion evidence

Reportに最低限記録:
- deployed x-oauth-connect version + exact source match
- exact OAuth scopes
- `/2/users/me` usernameのみ
- first real post id/timestamp/character count
- fingerprint/completion result
- AI Lab flags before/after
- 10 posting-window active state before/after
- prospective planner result
- naturally executed scheduled posts during observation
- X text-write count / media-write count
- Kabumori/Mio unchanged evidence

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT.md`更新
- 必要なcontrol/report/current-state metadataだけ同期

本タスクはcontrolled rollout。異常時は継続しない。
