# Claude Task 1

- task_id: morning-greeting-production-recovery-verify-20260908
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- purpose: `morning_greeting` のX画像投稿403復旧後、本番でdry-runを確認し、全安全条件を満たした場合のみ今日分のmanual publishを1回だけ実施して復旧を完了確認する。

## Background / confirmed state

- 2026-09-08 06:56 JST頃のscheduled `morning_greeting` は `MORNING_GREETING_MEDIA_UPLOAD_FAILED:403` で安全停止。
- 当該runではX投稿なし、`x_post_id=null`、二重投稿なし。
- 原因は旧OAuth 2.0 user tokenに `media.write` scopeが無かった可能性が極めて高い。
- 2026-09-08 14:39:29 JST、本番 `oauth_token_store` のX tokenを `media.write` 付き新tokenへ安全反映済み。
- token本文/ciphertextは表示していない。
- 新tokenで `POST https://api.x.com/2/media/upload` の非投稿テストに成功済み:
  - media id: `2097199343459823616`
  - `expires_after_secs=86400`
  - 1x1 PNGを正常認識
  - `/2/tweets` は呼んでいないためX投稿なし
- よってX media upload権限自体は復旧確認済み。
- Claude slot2は `morning-report-us-holiday-session-labeling-20260908` を担当中。
- Codexは重要ニュース系task担当中。競合させない。

## Goal

1. production `x-test-post` で `morning_greeting` dry-runを1回実行し、安全条件を確認する。
2. dry-runが完全成功した場合のみ、今日2026-09-08分の `morning_greeting` manual publishを**1回だけ**実行する。
3. 投稿後にDB/logをread-only確認し、画像付き投稿成功・重複なしを確認する。

## Required pre-checks

実行前に必ず確認:

1. production `x-test-post` の現在version / ACTIVE状態。
2. 今日2026-09-08の `morning_greeting` について:
   - `publish_claims`
   - `post_execution_logs`
   - `x_post_id`
   をread-only確認。
3. 既に今日分が `posted` / `x_post_id`ありなら**絶対に再投稿しない**。
4. failed claimが残っている場合、既存manual publish pathが安全に再実行可能かコード/現行挙動を確認。安全ゲートを迂回するDB直書きはしない。
5. production deployは今回の目的に必須か確認。単にtoken更新だけで既存production codeが動くならdeployしない。

## Step 1: morning_greeting dry-run

productionでdry-runを1回だけ実行。

確認項目:
- HTTP成功
- payload ready
- 本文生成成功
- 文字数validator pass（既存100〜300文字ルール）
- 画像生成/取得成功
- 画像テーマ/既存validator pass
- 既存Voice/安全チェックがある場合pass
- `wouldPublish` / publish直前相当まで到達
- X media upload / `/2/tweets` 実呼び出し **0件**
- DBにposted扱いを作らない

ひとつでもfailならmanual publishへ進まず停止・Report。

## Step 2: manual publish

**Step 1が完全成功した場合のみ**実行可。

- 今日2026-09-08分を1回だけmanual publish。
- 既存claim / duplicate preventionを必ず尊重。
- `/2/media/upload` 成功後のみ `/2/tweets` へ進む既存順序を維持。
- 同じ実行内/再実行で二重投稿しない。
- 失敗時に追加retryや別経路投稿を勝手に行わない。

## Step 3: post verification

manual publish成功後、read-onlyで確認:

- `publish_claims.status=posted` 相当
- `x_post_id` が1件のみ
- `post_execution_logs` が成功
- media upload 403再発なし
- duplicateなし
- 今日分の投稿が1件のみ

可能ならX API responseの投稿IDまで確認するが、token/secretは絶対表示しない。

## Production policy

今回許可:
- read-only DB/log確認
- production `morning_greeting` dry-run 1回
- dry-run完全成功後の today manual publish 1回

禁止:
- unrelated Edge Function deploy
- DB migration/schema/GRANT
- Cron変更
- `posting_windows`変更
- secrets/tokenの表示
- OAuth token再発行/再認証
- Codex重要ニュース領域変更
- Claude slot2朝刊休場判定領域変更
- close_report変更
- failed時の無制限retry
- duplicate防止の迂回

## Completion

完了時:
- `status: review_required`
- `next_owner: chatgpt`
- `## Report`追記

Report必須:
- production x-test-post version
- pre-check結果
- dry-run結果
- manual publish実施有無
- manual publishした場合のx_post_id（secretではない）
- `publish_claims` / logs結果
- duplicateなし確認
- deploy有無
- production変更内容（投稿以外に変更が無いこと）
- 失敗時はerror code / safe diagnosticsのみ

## Report

- task_id: morning-greeting-production-recovery-verify-20260908
- result: Step 1（dry-run）は完全成功。Step 2（manual publish）は**ユーザー判断により今回は実施せず**、明日以降の定時Cron自然実行に委ねることになった。X実投稿は今回0件。

### production x-test-post version

- `x-test-post`: **v89 / ACTIVE**（`verify_jwt: false`）。前タスク（`x-test-post-deploy-verify-20260907`）でのv88から、Claude slot 2のX media scope reauthタスク（診断強化コミット`1088081`）で既にv89へdeploy済みだったことを確認。今回はdeployしていない（token更新のみで既存production codeが動作するため、pre-check5の判断どおり）。

### pre-check結果

- `scheduled_posts`: 今日（2026-09-08 JST）の`morning_greeting`行は1件のみ、`scheduled_for: 2026-09-07 21:55:22+00`（=06:55 JST）、`status: failed`、`attempt_count: 1`。
- `publish_claims`: 同上1件のみ、`status: failed`、`error_code: MORNING_GREETING_MEDIA_UPLOAD_FAILED:403`、`x_post_id: null`。
- `post_execution_logs`: `started`→`failed`の2件、`x_post_id`はいずれも`null`。
- 今日分の`posted`/`x_post_id`あり行は**存在しない** → 再投稿リスクなしを確認。
- 既存manual publish path（`publish_morning_greeting_manual`モード）はコード上、`resolveAdminAuthorization()`で実在の管理者Supabase Authセッション（`admin_users`登録済みuser_id）を必須とする設計を確認（`admin_auth_logic.ts`）。サービスロール/anon keyでの迂回は不可能（意図的な安全ゲートと判断）。DB直書きでの迂回はしていない。

### dry-run結果（Step 1）

`test_morning_greeting_payload`モードで本番へ1回POST:

- HTTP 200 / `success: true` / `payload_ready: true`
- 本文: 116文字（既存100〜300文字validator範囲内、`retry_count: 0`で初回accept）
- 「おはよう」必須判定・テーマ整合性（`theme_match: true`、`theme: "generic"`）を満たす
- 画像: `generated/2026-09-08.png`、`image_exists: true`
- `x_api_called: 0` / `x_posted: false` — X API呼び出しは一切なし
- dry-run前後でread-only確認: `scheduled_posts`/`publish_claims`に新規行なし（DBにposted扱いを作らないことを確認）

**Step 1は確認項目すべてPASS。**

ユーザーへ本文・画像・安全確認結果を提示し、Step 2（実投稿）の実行可否を確認したところ、**ユーザーは「2」（今日の手動publishは行わず、明日以降の定時Cron自然実行に委ねる）を選択**。加えて、manual publish path自体が管理者ログインセッションを要求する設計であり、この場での実行手段を私は保持していないことも判明済み。

### manual publish実施有無

- **未実施**。上記の理由（ユーザー判断、および管理者認証の構造的制約）により、今日分のStep 2/Step 3は実行していない。

### duplicateなし確認

- 上記pre-check・dry-run後確認のとおり、今日分の`morning_greeting`は`failed`1件のみで変化なし。二重投稿・二重claimは発生していない。

### deploy有無

- **なし**。production `x-test-post`は既存のv89のまま。

### production変更内容

- **なし**。今回のセッションで実行したのは read-only DB確認（複数回）と、副作用のないdry-run HTTP呼び出し1回のみ。DB migration/schema/GRANT、Cron、secrets/token、`posting_windows`、他Edge Functionへの変更は一切なし。X実投稿も0件。

### remaining_issues / next_recommendation

- media upload権限の本番復旧そのものは、dry-run結果と非投稿テスト（トークンローテーション時点で確認済み、media id `2097199343459823616`）から見て解消されていると判断してよい。ただし**実際の投稿成功は今回未確認**のまま。
- 次回の定時Cron（明日06:30-07:00 JST帯）で`morning_greeting`が自然実行された際、`MORNING_GREETING_MEDIA_UPLOAD_FAILED:403`が再発しないか、read-onlyで確認することを推奨。
- 今日分（2026-09-08）の投稿は結果として見送られたため、今日のmorning_greetingは欠番のまま。再投稿するかどうかは別途ユーザー/ちゃっぴー判断（今回のタスクスコープ外）。
