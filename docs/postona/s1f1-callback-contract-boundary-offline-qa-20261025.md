# G4-38：S1-F1 の OAuth の callback・state の契約の G5／G3 との差分と、追加のオフラインの境界 QA（2026-10-25 JST）

- task_id: `postona-g4-s1f1-callback-contract-boundary-offline-qa-20261025`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **MOCK_PASS（偽のデータの模型）／実行時は SOURCE_NOT_VERIFIED／G5・G3 の正本は決めていない／PRODUCTION_NO_GO**
- 土台: PR #502（`0e2afb4d383a6301c3709ab84b3096732c6eb052`）。
- 読んだもの（読み取りだけ）:
  - G5-32 の文書（PR #501 `e0d94c6d…`、`docs/common-account/g5-32-personal-workspace-session-consumer-matrix.md` §1.2・§3.1・§4）
  - G5-33 の候補（PR #506 `bbc52a6b…`、`003_s2_3_workspace_eligibility.sql`、H4 のレビューの待ち）
  - G3 #318 の最新の REPORT（G3-31 まで）

## 1. G4 の質問への答えの状況
| 質問（出したところ） | 答え | 状態 |
|---|---|---|
| Q7（G4-36、R0 の提案と試験の期待） | G5-33 の述語 `private.postona_personal_workspace_eligibility`（`absent`／`own`／`OWN_WORKSPACE_CONFLICT`／`WORKSPACE_OWNER_UNKNOWN`、`003…@G5E:L99, L133-L138`）。R0 がそれを呼ぶ。拒否は既存の v1 の理由に写す | **答えあり（候補）**。PR #506 は H4 のレビューを待っている。G4-36 の `r0Proposed` は「`u_` に他のメンバーがいる」場合を見落としていた（G5 の L137）。この QA の B4 で直した |
| Q8（G4-36、匿名） | S2-1（T13S）が、適用されれば拒否する（G5-32 §3.1） | **候補だけ。結線されていない**。G4 は直ったとは扱わない |
| Q9（G4-36、G3 の共通の負の試験） | G5-32 §4・§5 の負例の表を、G3／G4／G6 が取り込める | **G5 の答えあり**。G3 の採用は未回答 |
| Q10（G4-37、匿名の後の code・結果の読み直し） | — | **未回答** |
| Q11（G4-37、ABA の後は再接続か） | — | **未回答**（G4-24 の C5 の実測では、再接続で戻る） |
| Q12（G4-37、G3 の state と「最後の完了が勝つ」） | G5-32 §3.1: X の state は、hash・始めた人・一度だけ・10分を持つ。ただし再接続で古い state は無効にならず、epoch も無い | **G3 は未回答**。G5 の表の [N] を記録した |

## 2. 差分の表（本人 → 個人の作業場所 → state・callback → owner と接続の世代 → lease・CAS）
| 段 | G4 の今の source | G5 の提案・候補 | G3 | 差分・依存 | 判定の code |
|---|---|---|---|---|---|
| 本人 | Threads: T13（匿名を通す）。**X の live: T13 も R0 も無い**（`XB:15`） | T13S（S2-1）・R0 は匿名を拒否 | Edge が JWT をそのまま渡す必要 | X の live の begin と callback には G5 の門が無い | `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` |
| 個人の作業場所 | Threads は厳しい規則（provisioner）。**X の live は他の brand を再利用し、派生の id の行に `on conflict` で加わる**（`XB:34, L42, L45`） | 述語（4つの答え）。`absent` での作成は「`on conflict` を拒否として扱い、加わらない」 | X の作成は共同所有を許す（G5-32 §1.2） | G4 の X の begin の結線は G4、G3 の X の作成は G3、述語は G5 | `OWN_WORKSPACE_CONFLICT`・`WORKSPACE_OWNER_UNKNOWN` |
| state・callback | 一度だけの消費、始めた人、10分。入口は二重を拒否 | callback での述語の確かめ直しは**未定**（B10） | X の state は一度だけ（epoch は無い） | callback の時点で作業場所の判定をやり直すか（**G5 への新しい質問 Q13**） | `NOT_INITIATOR`・`ALREADY_ATTESTED`・`STATE_NOT_CONSUMABLE` |
| owner と接続の世代 | Threads: `g5oe` を begin で記録し、callback で比べる | R0 の答えに epoch は入らない（G5-33） | X の予約に owner epoch の結び付けは無い（G3 が決める） | **X の callback には epoch が無い**（G4 の X の課題） | `OWNER_EPOCH_CHANGED` |
| lease・CAS | A・C・④・要約・005（隔離候補） | — | — | 製品には未採用 | `LEASE_NOT_HELD` など |

## 3. オフラインの QA（`supabase/tests/postona_g4_s1f1_callback_boundary_offline_qa.mjs`）
- 実行: `node supabase/tests/postona_g4_s1f1_callback_boundary_offline_qa.mjs <固定した commit を持つ clone>`
- 結果（2026-10-25 JST）: **13件 MOCK_PASS、source の照合 17/17、欠陥 6/6 を検出**
- 外の判定（述語）は引数として扱った。各件に CURRENT（今の G4）／PROPOSED（変更が要る）／GAP の印を付けた。

| # | 場面 | 結果 |
|---|---|---|
| B1 | 判定が ALLOW（`absent` で作成し、その後は `own`） | PROPOSED の通り |
| B2 | DENY（古い brand） | 作業場所も state も作らない。**ただし CURRENT の X の live はその brand に結び付く** |
| B3 | UNKNOWN（`u_` に所有者が2人） | 安全側で拒否 |
| B4 | `u_` に他のメンバー | `OWN_WORKSPACE_CONFLICT`（G4-36 の模型の見落としを直した） |
| B5 | `absent` なのに行が同時に現れる | 加わらずに拒否 |
| **B6** | **X の live が、自分で作っていない派生の行に加わる**（G5 の C2・C3） | **GAP**（CURRENT は2人目の owner として加わる。PROPOSED は拒否） |
| B7 | 匿名 | **GAP**（T13 は通す。T13S なら拒否） |
| B8・B9 | ログアウトの後の callback、別の人の遅れた callback | 拒否 |
| **B10** | begin の後に、本人がほかの brand を所有した | **CURRENT は接続する**（complete は `u_` の所有だけを見る）。PROPOSED の確かめ直しなら拒否。G5 への質問 Q13 |
| B11 | 所有者の ABA（Threads） | `OWNER_EPOCH_CHANGED` |
| B12 | 結果が分からない後の重複、結果の読み直し | 重複は拒否。読み直しはログアウトの後なら拒否（PROPOSED） |
| B13 | 再接続 | 古いリースは終わる |

| 欠陥 | FAIL になった件 |
|---|---|
| 判定が他のメンバーを見ない | B4 |
| T13S が匿名を通す | B7 |
| UNKNOWN を allow 扱い | B3 |
| `absent` で `on conflict` に加わる | B5 |
| callback が epoch を見ない | B11 |
| 結果の読み直しが session を見ない | B12 |

## 4. 合意が要る条件（短い Q&A）
- **G5**
  - Q13: callback（complete の時点）でも述語を確かめ直すか（B10）。直すなら同じ文の中で行う。
  - Q10・Q11（未回答）は、上の表のまま。
- **G3**
  - Q9・Q12: G5-32 の負例の表と、state の扱いを取り込むか。X の作成が共同所有を許す点は、G3 の判断。
- **G4 自身の課題**（実装は別の TASK。合意の後）:
  - X の live の begin と callback に G5 の門と述語を結線する（B6・B2）。
  - X の callback に owner epoch を持たせるか。
- **OPEN のまま**（#299）: 古い・共有の作業場所の移行（P-1）、locked／ban、ログアウト、保持・削除。

## 5. 残件と NOT_RUN
- 残件: D8、候補 005、H5 の transport、本物の Vault の ACL、独立のセキュリティのレビュー（Codex Sol（高））。PR #124 の authenticated の EXECUTE は有効にしない。Issue #131 は延期のまま。
- NOT_RUN: 本物の DB・Auth・OAuth・Vault・Meta、本番。PR #506 の述語は候補で、レビューの前（G4 は試験の期待の参考にしただけ）。
