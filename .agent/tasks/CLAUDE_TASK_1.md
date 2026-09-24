# Claude Task 1

- task_id: kabumori-mobile-recovery-deeplink-routing-fix-and-e2e-resume-20260924
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus 5.5
- purpose: K1で確認した mobile recovery deep-link の Unmatched Route blockerを最小修正し、既存の同一disposable test accountで残りE2Eを完了する。

## Prior K1 facts

- signup/confirmation PASS
- first login/profile lifecycle/session restore/logout/re-login PASS
- recovery email delivery PASS
- iOSは kabumori://reset-password をアプリへ渡した
- expo-router Unmatched Route で停止
- password変更、Delete Account、最終regressionは未完了
- disposable test accountは再試験用に保持中
- 既存production userへの変更なし

## Scope

1. fresh origin/main と他slotのscopeを確認
2. Expo Router/native linking構成を調査
3. recovery intentだけを正しい既存recovery処理へ渡す最小source fixを実装
   - +native-intent.tsx 等を候補とするがfresh sourceに合わせて判断
   - recovery情報を失わない
   - unrelated unknown routeをcatch-allで握りつぶさない
   - visible tabを増やさない
4. focused recovery-routing tests + existing auth/mobile tests + type/lint/diff check
5. real iPhoneで同じdisposable accountを使って recovery flowを再試験
6. recovery成功後、アプリ内の通常Delete Account flowを実行
7. read-onlyで disposable account/profile/user-owned rowsの削除を確認
8. 最終regression確認

## Safety

- 新しいtest accountを作らない
- 既存production userを変更しない
- password/token/reset URLをTASK/Reportへ記録しない
- Supabase Auth Site URL / email template / provider設定を変更しない
- migration / unrelated deploy / admin manual delete禁止
- H1 queue/dispatcher、G2 admin、他workstreamを変更しない
- confirmation後に到達するunreachable Site URL問題は別blockerとして記録のみ

## Completion / K1

PASS条件:
- recovery deep-linkが実機でrecovery UIへ到達
- recovery flow完了
- 再login確認
- in-app account deletion成功
- disposable auth user/profile/user-owned rows削除確認
- 既存production userへの影響なし

完了時:
- status -> review_required
- next_owner -> chatgpt
- Reportに fresh main、changed files、root cause/fix、test counts、実機Gate C/D/E結果、削除確認、残blockerを記録
- STOP for K1
