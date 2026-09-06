# Claude Task 2

- task_id: kabumori-mvp-completion-nonapple-20260907
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- purpose: Kabumori MVPのApple加入不要部分を完成に近づける。前回実装 `24ee8bb` のK2レビューで1点修正必須となったため、そこだけ安全に是正する。

## K2 Review

- decision: changes_required
- reviewed_by: chatgpt
- reviewed_commit: `24ee8bb`
- accepted:
  - Push通知タップ時に `important_news` を `/news` へ遷移させる導線追加
  - 重要ニュース閲覧時に本人の `notifications` の該当未読を `read_at` 更新する処理
  - iOS/web export PASS、今回変更ファイルに新規TypeScriptエラーなし
  - DB migration / Cron / X / Apple有料領域 / `important-news-monitor/**` に触れていないこと
- blocking_issue:
  - `alert_settings.important_news` / `push_enabled` の通知設定UIを追加した一方、Report自身が「現時点では設定値を通知生成/送信側が読んでおらず、トグルを切っても実際の通知量は変わらない」と明記している。
  - ユーザーに操作可能な設定として見せる以上、保存できても動作に反映されないトグルはMVPとして誤解を招くため、この状態では承認しない。

## Revision scope

1. `src/components/notification-settings.tsx` / `src/lib/alert-settings.ts` / `src/app/explore.tsx` の今回追加分を見直す。
2. 今回の禁止範囲（`important-news-monitor/**`、`send-push-notifications` production deploy、DB migration/DDL/GRANT、Cron、`supabase/config.toml`、Apple有料領域）を維持したまま、次のどちらかで解消する。
   - 推奨: 実際に効かない通知設定UIをMVPから外し、`24ee8bb`で追加した通知設定ボタン/モーダル/不要なlibを撤回する。
   - もし既存コードだけで設定を確実に反映できる安全な経路があるなら、その根拠を確認して最小実装する。ただし禁止範囲へ入るなら実装せず撤回を選ぶ。
3. Push tap → `/news` と重要ニュース閲覧時の既読化は維持する。
4. 他workstream・Codex対象には触れない。

## Validation

- `npx expo export --platform ios` PASS
- web export可能ならPASS
- TypeScript/relevant checks
- 通知設定UIを残す場合は「OFFにすると実際の通知が止まる」ことをコード経路で証明する。証明できないならUIを残さない。

## Completion criteria

- 非機能トグル問題が解消
- 変更を必要最小限でcommit/push
- TASK末尾に `## Report` を追加
- status: review_required
- next_owner: chatgpt
- control-plane更新をorigin/mainへ同期してからK2可能と報告
