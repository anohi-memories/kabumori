# Claude Task 2

- task_id: kabumori-eas-linked-push-device-e2e-20260907
- owner: claude
- slot: claude-2
- status: done
- next_owner: user
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

## Report

- task_id: kabumori-eas-linked-push-device-e2e-20260907
- result: Scope A（projectId mainline）・Scope B（Push runtime readiness確認）は完了。Scope C（実機iPhone E2E）はApple Developer認証・証明書発行というユーザー本人操作が必要な地点まで到達し、そこで停止した。projectId本体やアカウントメールアドレスはこのReportに再掲していない。
- scope_a_projectid_mainline:
  - ユーザーの`eas init`によって生じた`app.json`差分を確認：`expo-notifications` plugin等の既存内容には変更なし、追加されたのは`extra.eas.projectId`と`owner`のみで、意図しない差分の混入はなかった
  - この2点のみを`origin/main`ベースの一時worktreeでcommit/push（commit `e768178`、親は本タスクの`in_progress`commit `3f46dec`）
  - 実機development buildを将来作成できるよう、標準的な最小`eas.json`（development/preview/production の3 build profile、`developmentClient: true`）を新規追加。build実行やApple資格情報の設定は行っていない
- scope_b_push_runtime_readiness:
  - `npx expo config --type public --json`で`extra.eas.projectId`が正しく解決されることを確認（値は非表示）
  - `npx eas-cli project:info`でapp.json記載のprojectIdとEAS側のproject IDが一致することを確認（値は非表示）
  - `src/lib/push-notifications.ts`の`resolveProjectId()`が`Constants.expoConfig?.extra?.eas?.projectId`を正しく参照する実装のままであることを確認（コード変更なし、projectId未設定時の`skipped`分岐は今後実機で`registered`に進めるようになる）
  - `src/hooks/use-register-push-token.ts`・`_layout.tsx`・`auth.ts`のauth/layout連携、`Device.isDevice`ガードは前task（`43a2628`）から無変更であることを確認
  - `npx expo export --platform ios`：exit code 0
  - `npx tsc --noEmit`：今回変更した`app.json`/`eas.json`はJSON/設定ファイルでありtsc対象外。src配下の新規エラーなし（既存の`animated-icon.web.tsx`/`theme.ts`の2件のみ、前task同様の既知事象）
- scope_c_physical_iphone_e2e: **停止**。理由と次の1手は以下の通り。
  - `npx eas-cli build:list --limit 5 --non-interactive`で本projectのbuild履歴を確認 → **0件**。development buildはまだ一度も作成されていない
  - 実機へインストールするdevelopment buildを作るには`eas build --platform ios --profile development`の実行が必要
  - このコマンドは初回実行時、Apple Developer Programアカウントとの連携（Apple ID対話的ログイン、証明書/プロビジョニングプロファイルの発行または既存分の選択）を要求する。これはユーザー本人のApple ID・場合によっては有料のApple Developer Program登録が必要な操作であり、勝手に認証情報を要求・入力・記録しないという本タスクの制約に従い、ここで停止した
  - **次にユーザーが行う最短1手**: ターミナルで`npx eas build --platform ios --profile development`を実行し、初回はApple IDでのログインと（Apple Developer Programに未登録なら）登録、証明書発行の対話プロンプトに従う。完了後、TestFlightまたは直接インストールでdevelopment buildを実機に入れれば、ログイン→通知権限→Expo Push Token取得→`device_push_tokens`upsert→logout時削除、の一連が実機で検証できる状態になる
  - 上記が完了すれば、次のClaude slotタスクでtoken upsert/logout cleanupの結果をsecret/token値を晒さずに確認・報告できる
- commit_hash: `e768178`（`origin/main`へpush済み、親は本タスクの`in_progress`commit `3f46dec`）
- push: 完了。push前に2回（in_progress commit時・実装commit時）`origin/main`をfresh-checkし、いずれもdrift無し。
- deploy: 未実施（`send-push-notifications`のproduction deployはexplicitly out of scope）。
- remaining_issues:
  - 実機Push Token取得のE2Eは、ユーザー本人によるEAS development build作成（Apple Developer認証含む）が完了するまで実施不可
  - `send-push-notifications`のsecret登録・`supabase/config.toml`変更・deployは引き続き別タスク
- safety_checks:
  - `supabase/functions/important-news-monitor/**`、Codex現在task対象：一切変更していない
  - `send-push-notifications` production deploy、Supabase secret設定、Cron設定、`supabase/config.toml`、DB migration/DDL/GRANT：一切変更していない
  - important-news-monitor、X投稿系、auto_publish設定：一切変更していない
  - Apple/EASの対話的認証、証明書作成、build実行：一切行っていない（`eas build`は未実行）
  - projectId・アカウントメールアドレス等の個人情報・識別子：このReport・commitメッセージのいずれにも再掲していない
  - 他workstream（stocks sync関連、`.env`、`.claude/launch.json`、`apps/admin`、Codexの`.agent`ファイル等）：一切変更・stage・commitしていない。元の共有作業ディレクトリのgit HEAD・staged内容には触れていない
- next_recommendation: (a) 今回のcommit`e768178`をレビューし問題なければK2、(b) ユーザー本人に`eas build --platform ios --profile development`の実行（Apple ID連携含む）を依頼、(c) development build完了後、次のClaude slotタスクで実機E2E（token upsert・logout cleanup確認）を実施、(d) それと独立に`send-push-notifications`のsecret/config/deployタスクも計画可能

## K2 Review

- decision: approved
- reviewed_by: chatgpt
- result:
  - `app.json` のEAS project連携差分と最小`eas.json`追加を確認し、task scope内の変更として承認
  - commit `e768178` は親 `3f46dec` に対して `app.json` と `eas.json` のみ変更しており、Codex/important-newsやSupabase production領域との競合なし
  - EAS project association、iOS export、Push runtime readinessの確認結果を承認
  - 実機E2EをApple Developer認証が必要な地点で停止した判断は安全方針どおりで妥当
  - production deploy / secret / Cron / DB / `supabase/config.toml` は未変更を維持
- remaining:
  - ユーザー本人による iOS development build 作成・Apple認証
  - development build実機導入後のPush Token upsert / logout cleanup E2E
  - `send-push-notifications` production deployは別タスク
- next_owner: user
