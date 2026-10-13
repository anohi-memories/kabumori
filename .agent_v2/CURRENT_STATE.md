# Current State v2（新系統・現在有効な情報だけ）

- 更新: 2026-10-13 JST。最終比較main `103aaae104a146182b52554a5baa98e6d33529da`（作業中の新割当を保持）。PR #172上の整理候補であり、main反映・正式移行は未実施。
- 各TASK先頭・ACTIVE_TASKが現在の割当の正本。旧CURRENT_STATEの過去ready記述や実装Reportの返却時statusで、done枠を再開しない。履歴はHISTORY_INDEXとarchiveから参照する。

## 移行の状態・30枠

- PR #155 merge `4e80c79dc42c11fbc1ca105665514b0dd32842d3`により新系統は有効。旧G/Hで始めたTASKは旧系統で完結し、新規TASKからF/Jへ移す。単独Fは引き続き30枠統括。
- 最新TASK先頭とACTIVEのtask_id/status/owner/next_owner/return_toを照合。旧G1〜G10/H1〜H5は全done/next_owner:none、新F1/F3〜F6/F8はdone/none、F2はready/next_owner:claude、J1はready/next_owner:codex、F7/F9/F10/J2〜J5はidle/task_id:none。現TASKの二重task_idなし。継続TASKはF2/J1の2件、最新ヘッダー上のreview_required/完了返却待ちは0。正式移行はこの2件の完結待ち。未割当return_toの注釈差はnoneとして一致。今回は他slotの完了判定・割当を変更していない。
- 製品の独立Security review・production HOLDは残っている。実装Reportに残るreview_requiredは返却当時の記録であり、TASK先頭/ACTIVEのdoneを再割当する根拠にしない。
- 初回snapshot `archive/2026-10-12-initial-migration/`と最終候補 `archive/2026-10-13-final-migration-preflight-b7ce2c4f/`を保持。前回最終候補のSHA256 64/64を今回再照合。PR #172が未マージのため、main上の保存済みとは扱わない。
- PR #172元HEAD `8e65a71e3dc7b144ec511fa853ffe08e522dc827`を保全ブランチ `backup/pr172-pre-conflict-prep-8e65a71-20261013`に固定し、GitHub read-back一致。変更前の本書と移行TASKを新しいappend-only archiveへ保存・2/2実復元検証。
- 詳細は `migrations/CONFLICT_RECONCILIATION_20261013.md`、正式移行制御は `migrations/FULL_MIGRATION_20261013.md`。旧方式の削除、`.agent_v2`→`.agent`昇格、コードの名称復帰、15枠への切替は未実施。

## 旧管理差分・worktreeの保留条件

- open PR46件（#172含む）の全変更ファイルを確認。#172以外で管理基盤を変えるのは#10/#11/#161。3件のHEADは保存済みsnapshotと同一。旧管理11パスの差分は現行管理へ戻さず、保存済み原文・patchを履歴として参照する。PR本体・branch・stateは変更していないため、旧差分のmerge経路は未解消。
- #10の2026-09監査文書はarchiveで保持し、現在のリリース判断に昇格しない。#11のcaller認証課題は今回解決確認していない。#161はmainのC5受入done/noneを優先し、正式実装Reportは保存済み原文で参照する。source PR159と本番審査は別。
- 134登録worktree/checkoutの境界をread-onlyで確認。旧 `/Users/yuya/Developer/kabumori`に旧管理7ファイルと共有HANDOFF.mdの未コミット変更がある。触らず保持し、正式切替前に担当者が扱いを確定する。登録だけ残る不在worktree1件もあり、pruneせず稼働/保全状態の確認を残す。今回専用worktreeとその他の存在するcheckoutには、開始時に今回のv2変更対象の未コミット変更なし。
- 旧CURRENT_STATEには過去ready記述が残る。F2の旧診断TASKはmainでarchive済み、新TASK/ACTIVEはreadyで一致。新割当をこの整理で上書きしない。main前進前の30枠証拠は歴史的観測として保持し、最新照合は `archive/2026-10-13-main-advance-103aaae1/SLOT_METADATA.json` を参照する。

## かぶモリアプリ・F1/F2

- F1の現TASKは `kabumori-f1-ai-ask-v1-phase-b0-security-preflight-20261013`、L1で設計候補受入済み、TASK先頭/ACTIVEはdone/none。Draft PR171 HEAD `0beda46186efe1db680909f369e2571609851d81`にPhase B0の事前設計。D1〜D8のユーザー判断、B1実装、独立Security review、認証・費用・鮮度・データ分離のゲートは残る。実AI/本人保有情報/production接続は未完。以前のPhase A TASKはarchive済み、PR166はDraft/未マージ。
- F2の現TASKは `kabumori-f2-opus-primary-morning-close-handler-20261013`、ready/claude、推薦Opus5.5（高）、F2→L2、返却先かぶモリアプリG2のちゃ（新F2担当）。PR170のF6ソースを保護してhandler側の朝刊・大引けOpus PRIMARY接続とoffline検証を担当。旧診断TASKはmainでarchive済み。PR143/149/158はmainへ通常merge済みで、古いmergeable=falseは現在のマージ待ち条件ではない。
- sourceのmain統合はproduction公開を意味しない。managed DB/migration・Edge・Cron・実Expo push・EAS・課金API・アプリ公開は、本番read-only事前確認とセキュリティ/段階導入の別承認が必要。旧自動個別レポートの本番停止は今回未実施・未検証。

## J1 AIに聞く Phase B0 独立レビュー

- J1 `kabumori-j1-ai-ask-b0-independent-security-review-20261013`はready/codex、推薦Sol（高）、J1→V1、返却先かぶモリアプリG1のちゃ（新F1担当）。PR171/166と既存G2/F5/G6等の境界をread-onlyで独立設計レビューする。今回の移行レビュー枠へ転用せず、J1 TASK/Reportを保護する。B1実装・本番API/DB/Edge・有料API・merge/deployは別TASK/承認。

## POSTONA・F3/F4

- F3 `postona-f3-x-reservation-live-boundary-source-integration-20261012`はdone/none。Draft PR168 HEAD `4b491668d030d1e9ecefacf0448fdd06d5ce57fc`、依存PR145→151→163は未マージ。X予約Edge/Auth/DBのソース候補であり、本番保存・X実投稿はNO_GO。X本人確認Issue131、F5/G5の実契約、managed Auth/owner、独立統合レビューを要する。旧G3のTASKは旧系統で保持。
- F4の現TASKは `postona-f4-threads-t13-authenticated-writer-integration-20261013`、done/none。Draft PR169 HEAD `fd15430ddcd640c5c7389582f37f1b478fc7204c`は保護PR167の上。以前のdisconnect TASKはarchive済み。T13/F5 owner-service guard・終了サービスのdisconnect・OAuth cleanupはsource候補、全ゲートOFF。
- F5のadapter登録/service_deletion owner lease/remote-unverified方針/SQL guard順序、F3のX writer guard、H5 managed owner/Auth、独立Sol（高）統合Security reviewが未完。本物のMeta/Threads接続・deauthorize・実投稿・DB/Edge適用は別承認。PR124/135/139/144/154/159/167/169のsource候補を移行準備でmergeしない。

## 共通アカウント・F5

- F5 `common-account-f5-phase5-app-auth-entitlement-integration-20261012`はdone/none。Draft PR165 HEAD `4638891f6c7ff432e08d462019594e1ec3d66f07`、依存PR121/152も未マージ。旧G5の修正は旧系統で完結。
- G5-owned backend契約・本人共通ID/service entitlementのsource候補。G1/G2/F1アプリUI/Auth、G3/F3/G4/F4 POSTONA/Threads、H5 transportの接続は所有者ごとの新TASK・独立worktreeで扱う。managed Auth/DBの証明、権限・SQL・lifecycle統合レビュー、production gateは残る。

## 共通AI基盤・F6

- F6 `common-ai-f6-opus-primary-close-report-v0-20261013`はTASK先頭/ACTIVE done/none。Draft PR170 HEAD `46b27326360e66ec843f79bae6d01584088869d0`はOpus PRIMARY大引けV0のoffline source候補。handler.tsのF2所有部分は未変更、配線パッチを添付しただけで、既定OFF・未配線。本日の本番切替成功とは扱わない。
- 最新のユーザー方針は朝刊・大引け両方のOpus PRIMARYへ進め、失敗時自動OpenAI fallbackは延期。既存30日期限キーの初期利用意図はあるが、秘密値を取得/表示せず、実Secret/deploy/課金は別の安全ゲート。F6のclose-only候補をF2所有handlerで両サイクルへ接続する。月額$5等の台帳上限は維持し、継続する両サイクル運用の予算可否は未確認。影響対象handlerの所有者調整、費用上限/予算ledger/検証、独立レビュー、production read-only gateと明示承認が必要。
- 共通AI shadow stack PR148→150→153→157→162はDraft/未マージ。実有料API・秘密情報・DB/Edge適用をこの移行準備では実行していない。

## ニュース・MIC・残りslot

- F8 `news-improvement-a-jp-official-diagnostics-j1a-f8-20261012`はdone/none。Draft PR164 HEAD `141d851267898ff7e28151a9e7e73121a3bb75aa`、本番NO_GO。J1-bは未割当であり、先に現TASK/Reportのarchive・SHA256・restore・索引を確認。PR116/129とG9を保護。
- 旧G7=MIC、旧G8=ニュース改善A、旧G9=API最適化Bの明示指定を維持。F7/F9/F10へ用途を自動継承・再割当しない。J1は上記AI設計レビューready、J2〜J4は未割当レビュー枠、J5は臨時実装優先枠として保持。

## production安全・次工程

- production DB/Auth/RLS/migration/RPC/Edge/secrets/Cron/workflow/実投稿/有料API/EAS/deployはTASKの明示承認と安全ゲートが必要。共通アカウント優先は変更境界が競合する場合のみ。production mutation windowは実write直前に開きread-back後に閉じる。秘密情報は表示・記録・commitしない。
- F2/J1の継続TASKは担当先で完結させる。次は3PRの旧管理差分を含むmerge経路の除外/close/supersedeの担当判断、旧checkout未コミット変更と不在登録worktreeの確認、fresh mainと全30枠再確認。今回は他PRの整理操作をしていない。
- 正式昇格には切替時の追加snapshot、F/J現TASK/Reportの保存、実装slotの明示割当とreturn_to/completion_code、独立Sol（高）レビューが必要。推薦実装Opus5.5（高）。その後もmain merge・本番変更は別判断。現在の開始/完了コードは継続する。
