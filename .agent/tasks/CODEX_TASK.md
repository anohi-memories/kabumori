# Codex Task

- task_id: expo-ios-push-client-20260909
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high

## Goal

かぶモリExpoアプリで、Apple Developer Program有効化後すぐにiPhone実機Push通知テストへ進めるよう、Expo SDK 57に対応したクライアント側Push通知基盤を実装する。

今回のスコープは **Expoアプリ側のみ**。Supabase migration、Edge Function、production secrets、Apple Developer Portalの変更は行わない。

## Confirmed current state

GitHub main上で以下を確認済み。

- Expo SDK: `~57.0.18`
- `expo-notifications`: `~57.0.17`
- `expo-device`: `~57.0.1`
- `expo-constants`: `~57.0.16`
- `app.json` に `expo-notifications` plugin設定済み
- EAS projectId: `eb80adf3-861e-4a48-a373-2d9a85b58899`
- `eas.json` に developmentClient + internal distribution設定済み
- GitHub code searchでは `getExpoPushTokenAsync` / `Notifications.` のアプリ実装は未検出

## User authorization

ユーザーは2026-09-09にApple Developer Programへ登録し、かぶモリのPush通知実機テストへ進めることを明示している。

Apple側のメンバーシップ有効化は待機中の可能性があるため、Apple Portal / APNs credential作成が必要な工程は無理に進めない。

## Required investigation before write

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `HANDOFF.md`
6. `app.json`, `eas.json`, `package.json`
7. Expoアプリのroute/layout/auth構成、Supabase client構成
8. Expo SDK 57公式ドキュメントのNotifications / Push Notifications / Development Buildsの該当箇所

開始時にorigin/mainをfresh-checkし、既存未コミット変更を他workstreamの所有物として尊重する。

## Implementation scope

Expoアプリ側に、再利用可能なPush通知登録基盤を実装する。

最低限必要:

1. **実機判定**
   - `expo-device` を使い、Push token取得はphysical deviceのみで行う。
   - simulator/emulatorでは安全にskipし、例外でアプリを落とさない。

2. **通知権限**
   - 現在権限を確認。
   - 未許可ならOS permission requestを実行。
   - deniedの場合はアプリを壊さず、呼び出し側が状態を判定できる戻り値にする。

3. **Expo Push Token取得**
   - `Notifications.getExpoPushTokenAsync({ projectId })` をSDK 57公式手順に沿って使用。
   - projectIdはExpo Constants / EAS設定から安全に取得し、ハードコード重複を避ける。
   - projectId欠落時は明示的に失敗理由を返す。
   - tokenをconsoleへ不要に全文出力しない。

4. **Notification handler**
   - foreground受信時の挙動を明示設定。
   - iOSで通知表示をテスト可能にする。
   - SDK 57の型・APIに合わせる。

5. **Notification response listener**
   - 通知タップを受け取れる基盤を用意する。
   - 今回は未知のdeep-link仕様を勝手に決めない。
   - `data` を安全に受け取って将来routingへ繋げられる境界を作る。
   - 既にrouting仕様が存在する場合のみ、その既存仕様へ接続してよい。

6. **ライフサイクル**
   - root layout等の適切な場所でlistenerを1回だけ登録し、cleanupする。
   - Fast Refresh / re-renderでlistenerが重複しない設計にする。

7. **Android compatibility**
   - iOS実機テストが主目的だが、Android側を明確に壊さない。
   - Android channelがSDK 57公式実装上必要なら最小限追加してよい。

## Token persistence boundary

今回、Supabase DB schemaを勝手に追加・変更しない。

- 既存にpush token保存先（table/RPC）が存在する場合のみ、安全性・RLSを確認して既存APIを利用してよい。
- 保存先が存在しない場合は、token取得まで実装し、保存処理は明確なTODO/境界として残す。
- migration、RLS変更、RPC追加、Edge Function変更は禁止。

Reportには以下を明記する:
- 既存保存先の有無
- tokenをどこまで取得できる実装になったか
- server persistenceに何が不足しているか

## App config check

`app.json` のiOS `bundleIdentifier` が未設定なら、**勝手なidentifierを決めてproduction向け変更しない**。

Reportで「Apple Developer有効化後/EAS build前に必要」と明示し、候補や現在値を確認する。

既にプロジェクト内で正式Bundle IDが決定済みなら、その根拠を確認した上で使用してよい。

## Verification

最低限:

- `npm run lint`
- TypeScript/Expoの既存チェック手段があれば実行
- import/type errorなし
- listener cleanup確認
- simulatorでtoken取得を強行しないこと
- permission denied pathでcrashしないこと
- projectIdがEAS projectIdへ解決されることをコード上確認

Apple Developerメンバーシップ有効化前で実機build/Push受信まで実施できない場合、それを未実施として正直にReportする。成功扱いにしない。

## Safety / prohibited

禁止:
- Supabase migration/schema/RLS/GRANT/RPC変更
- Edge Function変更/deploy
- production secrets変更
- APNs key/certificate/token等の秘密情報を表示・commit・ログ出力
- Apple Developer Portalを推測で変更
- EAS production submit
- App Store submission
- X投稿関連ファイル・scheduler・production設定変更
- Web admin変更
- 既存未コミット変更のstage/commit
- 他slotのTASK/Report変更

## Scope / conflicts

このTASKはExpoクライアントのPush基盤専用。

他slotが同時にExpo root layout、app.json、package.json、通知関連ファイルを変更中なら競合するため開始せず報告する。

push直前にorigin/mainをfresh-checkする。

## Completion

作業終了時:

- `status: review_required`
- `next_owner: chatgpt`
- `.agent/CODEX_REPORT.md` を更新
- `.agent/ORCHESTRATION.md` の規定どおりGitHubへ同期

Report必須:
- task_id
- result
- changed_files
- 実装したPushフロー
- Expo SDK 57公式仕様との整合
- token保存先の有無
- Bundle ID確認結果
- tests
- commit_hash
- push
- deploy
- Apple側で残る手動作業
- 実機Pushテスト未実施/実施の事実
- remaining_issues
- safety_checks
- next_recommendation
