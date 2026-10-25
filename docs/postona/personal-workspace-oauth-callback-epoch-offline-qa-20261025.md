# G4-36：個人の作業場所・X の begin・Threads の callback・epoch のオフラインの負の QA（2026-10-25 JST）

- task_id: `postona-g4-personal-workspace-oauth-callback-epoch-offline-qa-20261025`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **MOCK_PASS（偽のデータの模型だけ）／SOURCE_NOT_VERIFIED（実行時の動作は未確認）／S1-F1 の食い違いを模型で固定／PRODUCTION_NO_GO**
  - DB・network・OAuth は使っていない。模型の結果は「source の規則がどう決めるか」を示すだけで、製品の PASS ではない。
  - 製品の SQL・既存の候補・G3／G5／H5 のファイル・既存の PR の head・G4-35 の文書は変えていない。
  - G5 の R0 は**外の判定として引数で渡した**（今の候補と、G5 の §4.1 の提案の2つ）。G4 が「唯一の作業場所」の正本を決めることはしない。
- 土台: PR #484（`69409c7900ad7c9a4cff7924dd1ea221e2c4c733`）。版の固定は G4-35 と同じ（main `0c42933c…`、G4 `b963683b…`、G4X `39ab57ab`、G5S `21a5cad4…`、G3X `6aae11a2…`）。

## 1. 新しいファイル
- `supabase/tests/postona_g4_personal_workspace_oauth_offline_qa.mjs`
  - 模型（判定点ごとに、固定した source の行から書いた）
  - source の行の照合（`git show`。ローカルの clone だけを使う）
  - 欠陥の切り替え（`G4_36_MUTANT`）
- この文書
- 実行: `node supabase/tests/postona_g4_personal_workspace_oauth_offline_qa.mjs <固定した commit を持つ clone>`

## 2. 検査の点（G4 が持つ範囲）と、その根拠の行
| 検査の点 | 模型の判定 | 根拠（G4-35 の表の行。runner が照合） |
|---|---|---|
| session の本人（T13）。混ぜた claims・失効・ロック | `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`／`ACCOUNT_LOCKED` | T13 `@G5S:L118, L133, L156` |
| 匿名の session | T13 は通す（S1-F2、**GAP**）、R0 は拒否 | R0 `@G5S:L144` |
| 唯一の作業場所 | provisioner: 他の所有・種類・共有・削除の途中で拒否。X の live: 1つなら再利用 | `…workspace_candidate.sql@G4:L139-L165`、X `@main:L27-L39`、X の v2 `@G4X:L179` |
| begin の state | 期限は10分以内、hash の重複は拒否 | `@G4:L188, L191, L193, L214` |
| callback（入口・complete） | 他人の state、二重、期限切れ、HMAC、本人の所有、Threads の利用者の一致 | 入口 `001@G4:L251, L256`、complete `@G4:L270-L307` |
| owner epoch／サービスの世代 | 記録と違えば拒否 | `001@G4:L280, L283` |
| 切断の後 | state は消え、claim は拒否 | 切断 `@G4:L187` |
| リース・二重の送信 | 2つ目の claim は `LEASE_HELD`、再接続の後の古いリースは `LEASE_NOT_HELD` | rotation `@G4:L234, L311`、A（G4-27） |

## 3. 結果（`node …offline_qa.mjs /Users/yuya/Developer/kabumori-fresh`、2026-10-25 JST）
- **18件 MOCK_PASS、source の照合 35/35**。最終の行は `POSTONA_G4_PERSONAL_WORKSPACE_OAUTH_OFFLINE_QA_MOCK_PASS`。
- 欠陥 4種を入れると、どれも FAIL になる:

  | 欠陥 | FAIL になった件 |
  |---|---|
  | provisioner がほかの所有を見ない | N2・N2b |
  | state を1回だけにしない | N7・N7b |
  | epoch を比べない | N9 |
  | 再接続でリースを残す | N10 |

| # | 場面 | 模型の結果 |
|---|---|---|
| N1 | 他人の state で callback | `THREADS_BINDING_NOT_INITIATOR` |
| **N2** | 古い brand L を1つだけ所有 | **食い違い**: X の live は L、provisioner は `WORKSPACE_CONFLICT`、R0（今）は allow、R0（提案）は deny |
| N2b | brand を2つ所有 | X の live は `MULTIPLE_OWNED…`、provisioner は `WORKSPACE_CONFLICT` |
| **N2c** | 共有された `u_` | **食い違い**: X の live は再利用、provisioner は `WORKSPACE_SHARED` |
| N3・N4 | ロック、削除の途中 | `ACCOUNT_LOCKED`、`…DELETION_IN_PROGRESS` |
| **N5** | 匿名の session | **GAP**: Threads の begin は T13 を通る、R0 は拒否 |
| N6・N6b | begin と callback の間のログアウト、混ぜた claims | `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` |
| N7・N7b・N7c | 二重の callback、遅れた callback、10分を超える期限・hash の重複 | `ALREADY_ATTESTED`、`STATE_NOT_CONSUMABLE`、`STATE_INPUT_INVALID` |
| N8 | 切断の後の callback・token | callback は拒否、claim は `ACCOUNT_NOT_FOUND` |
| N9 | 古い owner epoch・サービスの世代 | `OWNER_EPOCH_CHANGED`・`SERVICE_GENERATION_CHANGED` |
| N10 | 再接続の後の古いリース | `LEASE_NOT_HELD` |
| N11 | 2つの worker が同じアカウントを claim | `LEASE_HELD` |
| N12・N13 | 別の Threads の利用者、attestation の無い交換 | `IDENTITY_ACCOUNT_MISMATCH`、`ATTESTATION_INVALID` |

**この模型の限界**
- 模型は source を写したもので、本物の SQL を実行していない（SOURCE_NOT_VERIFIED）。
- 本物の SQL での実測は、G4-24〜34 の隔離 PG17 にある分だけ（N1・N8 の一部・N9・N10・N11・N12 の近い形）。
- N2・N2c・N5・N6・N7 の本物の実測は、まだ無い。

## 4. G5・G3 への質問と順（G4-35 §6 に加えて）
- **G5**
  - Q7: R0 の「ほかの所有を見ない」を直すなら、模型の `r0Proposed` と同じ判定でよいか。N2 の表を、G5 の試験の期待にそのまま使えるか。
  - Q8: T13 の匿名の拒否（S2-1）が入ったら、N5 の GAP の期待を「拒否」に変える。G5 の匿名の claim の修正（第25TASK）は**完了していない**ものとして扱う。
- **G3**（idle。始めない）
  - Q9: X の live の begin を規則に合わせるとき、N2・N2b・N2c の期待（provisioner と同じ code）を共通の負の試験にするか。
- **順**: #299 の決定（古い作業場所・locked／ban・ログアウト・保持）→ G5 の述語と S2-1 → G3／G4 の X の begin → 本物の SQL で N1〜N13 を隔離 PG17 で実測。どの SQL も Codex Sol（高）のレビューを受ける。

## 5. 未解決のまま扱うもの
- OPEN のまま: locked／ban、古い作業場所の移行、ログアウト、保持
- D8、候補 005（token の読み出し）、H5 の transport、本物の Vault の ACL
- PR #124 の authenticated の EXECUTE は有効にしない。Issue #131 は延期のまま。

## 6. NOT_RUN
本物の DB・OAuth・Auth・Vault、本番、G3／G5 の実装との結線。
