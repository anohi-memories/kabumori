# Claude Task 2

- task_id: kabumori-eas-linked-push-device-e2e-20260907
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- purpose: ユーザー側でExpo/EASログインとKabumori project連携が完了したため、`extra.eas.projectId` を安全にmainへ反映し、実機iPhoneでExpo Push Tokenを取得できるところまでEAS/Push実行環境を整えて検証する。

## User-side completion already done

ユーザー本人が以下を完了済み。

- Expoアカウント作成・ログイン
- `npx eas-cli@latest whoami` でログイン確認
- KabumoriのExpo/EAS project作成
- `npx eas-cli@latest init --id <projectId>` 成功
- CLI表示: `Project successfully linked ... (modified app.json)`

projectIdそのものやメール等の個人情報・認証情報をReportへ再掲しないこと。

## First checks

1. `.agent/ORCHESTRATION.md` と `.agent/CURRENT_STATE.md` を読む。
2. 作業開始時に最新 `origin/main` とworktreeのdirty/stale状態を確認する。
3. `app.json` の `extra.eas.projectId` が正しく反映されていることを確認する。
4. 他workstreamの未コミット差分を変更・stage・commitしない。
5. Codex task `important-news-freshness-coverage-fix-20260906` の対象である `supabase/functions/important-news-monitor/**` には触れない。

## Scope

### A. EAS projectId mainline

- ユーザー操作で生じた `app.json` のprojectId差分を確認する。
- projectId以外の意図しない差分が混ざっていないことを確認する。
- 安全なら必要最小限でcommitし、`.agent`運用ルールに従ってorigin/mainへ同期する。

### B. Push runtime readiness

既にmainline済みのPush foundationを前提に確認する。

- `expo-notifications` plugin/configが解決すること
- `src/lib/push-notifications.ts`
- `src/hooks/use-register-push-token.ts`
- auth/layout連携
- `Device.isDevice` 等の実機ガード
- EAS projectId取得経路

必要なら実機Push Token取得のための最小EAS設定（例: `eas.json`）を追加してよい。ただし既存設定・別workstreamとの競合を確認してから行う。

### C. Physical iPhone E2E

可能な範囲で、実機iPhoneにdevelopment buildを入れて以下を確認する。

1. ログイン
2. 通知権限要求
3. Expo Push Token取得
4. `device_push_tokens` に本人tokenがupsertされる
5. logout時に当該端末token削除がbest-effortで走る

Apple/EASの対話的認証、端末操作、証明書作成などユーザー本人の操作が必要になった場合は、勝手に認証情報を要求・記録せず、その時点で停止して「次にユーザーが行う最短1手」をReportする。

## Explicitly out of scope

今回は以下を触らない。

- `send-push-notifications` のproduction deploy
- Supabase secret設定
- Cron設定
- `supabase/config.toml` の変更（stocks sync側未コミット差分と競合し得るため）
- DB migration / DDL / GRANT
- important-news-monitor
- X投稿系
- auto_publish設定

`send-push-notifications` deployは別タスクに分離する。

## Validation

最低限:

- `npx expo config --type public` 等でprojectId/config解決確認
- iOS export PASS
- TypeScript/relevant checks（既知の無関係エラーは切り分けて報告）
- EAS CLI project association確認
- 実機E2Eを実施できた場合はtoken upsert/logout cleanupの結果を、secret/token値を晒さずに報告

## Completion criteria

- projectId差分が安全にmainへ反映済み
- EAS/Push runtime readiness確認済み
- 実機E2Eが完了、またはユーザー本人操作が必要な地点まで安全に到達
- 他workstreamに触れていない
- TASK末尾に `## Report` を追加
- 完了なら `status: review_required`
- `next_owner: chatgpt`
- control-plane更新をorigin/mainへ同期してからK2可能と報告
