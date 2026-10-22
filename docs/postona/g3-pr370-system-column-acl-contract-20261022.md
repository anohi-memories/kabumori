# G3｜PR #370 のシステム列 ACL の残存 P2：保証の境界・影響・選択肢・G5 との IF（2026-10-22、Issue #318 TASK 19/50）

- task_id: `postona-g3-pr370-system-column-acl-p2-contract-design-20261022`
- 返却先: POSTONA G3のちゃ（Issue #318担当チャット）／完了コード: K3
- 判定: **設計・証跡だけ。PR #370 は CHANGES_REQUIRED_P2 のまま。本番 NO_GO。** この文書は、残ったリスクを受け入れることも、方針を決めることもしない。
- 対象: PR #370 の head `547d9f920b124c9af286408eca696b10c67efe79`（H3 C3 TASK 8 がレビューしたもの）。PR #395 の head `5250fd8d52d6479399801f9c9f8515d7a3ad00eb`。
- 根拠のレビュー: H3 REPORT（Issue #330 コメント 6329700338）・ACCEPT（6330268630）
- 変えたもの: G3 の新しい 2 ファイルだけ（この文書と、使い捨ての PG17 の証跡ランナー `supabase/candidates/postona_pr370_system_column_acl_evidence/system_column_acl_run.sh`）。PR #370・#395 の SQL・ランナー・docs、G4・G5、migrations は変えていない。

## 1. 今の保証の境界（PR #370 `547d9f92`。PG17.11 のローカルの実測）

| 対象 | 確保（claim）から COMMIT まで | 根拠 |
|---|---|---|
| 表の ACL（`pg_class.relacl`） | 直列化する（他の GRANT・REVOKE は待って失敗） | PR #370 の Q2・Q3、H3 の再現 |
| 利用者の列の ACL（`pg_attribute.attacl`、attnum > 0） | 直列化する | PR #370 の T6・T9。この PR の R2・R4 |
| 列の追加・削除、owner、RLS・ポリシー、トリガー、保存オプション | 表のロックで止まる | PostgreSQL のロックの定義と PR #370 の Q/K |
| **システム列の ACL**（tableoid・cmax・xmax・cmin・xmin・ctid） | **直列化しない**。本体・rollback の両方で、最後の確認から COMMIT までに他のセッションの GRANT が commit できる | この PR の R1・R3（H3 の追加の反例と同じ） |
| 役割の membership、既定の権限、関数、他の表 | 直列化しない（主張もしない） | — |

- 本体と rollback の「最後に列の ACL が空であること」の確認は、利用者の列については COMMIT まで保たれる。システム列については、確認した瞬間の事実でしかない。
- 確認をもう 1 回足しても、最後の窓は後ろに動くだけで消えない（H3 の指摘のとおり）。

## 2. 再現（`system_column_acl_run.sh` の R1〜R5。PR #370 の 2 ファイルを `git show 547d9f92` で写して使う）

| 番号 | 何が起きるか | 検証 |
|---|---|---|
| R1 | 本体の最後の確認の後・COMMIT の前に、別の owner のセッションの `GRANT SELECT (ctid) … TO anon` が待たずに commit する。本体も commit する。実行の後に `ctid=anon=r/<owner>` が残る。その実行自身の rollback は `ROLLBACK_COLUMN_ACL_UNSUPPORTED` で止まる。 | 実測 |
| R2 | 同じ場所で利用者の列（`brand_id`）への GRANT は lock timeout（55P03）。列の ACL は残らない。 | 実測（対照） |
| R3 | rollback の最後の DO の後・COMMIT の前に、同じシステム列の GRANT が commit し、rollback も commit する。表の ACL は記録どおりに戻るが、列の ACL が 1 件残る。 | 実測（H3 の追加の反例） |
| R4 | rollback の同じ場所で、利用者の列への GRANT は lock timeout。 | 実測（対照） |
| R5 | 記録の後・REVOKE の前に、owner が付けた `REFERENCES (xmin)` を authenticated へ付ける GRANT が commit する。本体の表単位の REVOKE が、システム列も含む全列から同じ権限を外す。記録に無いので、rollback は戻さない（狭める側だけ。「その実行が取り上げたものを正確に戻す」契約の外）。 | 実測 |

### 実際の影響（検証と推定を分ける）
- **検証した**:
  - 実行の後に、システム列の ACL が残りうる（R1・R3）。「COMMIT の時点で列の ACL は空」という PR #370 の契約は、本体でも rollback でも成り立たない。
  - 残った後は、その実行の rollback が止まる（R1b）。戻せなくなる（可用性の問題）。
  - システム列には owner でも一意のインデックスを作れない（PR #370 の T12）。そのため `REFERENCES (xmin)` だけで外部キーの参照先は作れない。
  - `has_any_column_privilege` はシステム列を数えない（PR #370 の T12）。表単位や利用者の列を見る検査では見つからない。
- **推定（実演していない）**:
  - anon に `SELECT (ctid)` が残っても、RLS は有効で anon 向けのポリシーが無いので、行は返らない見込み。権限を使って読むことは、範囲の外として試していない。そのため、「漏れない」とは主張しない。
  - authenticated に `SELECT (ctid)` が残った場合、自分の行の ctid・xmin などの物理的な位置や版の情報が読める見込み。重要度は低いと推定するが、未検証。
- **前提**: 窓を突けるのは、この表に GRANT できる者だけ（表の owner の membership を持つ管理者、superuser、grant option を持つ役割）。PR #370 は API の役割の grant option を事後条件で見ない（§7 の SELECT の grant option）。インターネットの利用者が単独で起こせるものではない。H3 の重要度判断（P2）を変えない。

## 3. 選択肢

### A1（推奨の候補。決定ではない）: システム列の行も確保する
- やり方: 確保の中で、owner が**自分自身に**全システム列の列権限を GRANT し、同じトランザクションで REVOKE する。
  - 例: `GRANT SELECT (tableoid, cmax, xmax, cmin, xmin, ctid) … TO <owner>` → `REVOKE … FROM <owner>`
  - 各システム列の `pg_attribute` の行は、このトランザクションで書き換えられ、COMMIT まで確保される。ACL は元の値に戻る（一時的な項目は commit されないので、他のセッションからは見えない）。
- 実測（この PR の A1〜A4。試作は**テストの写しの中だけ**で、候補ではない）:
  - A1・A2: 本体と rollback の R1・R3 の割り込みが lock timeout で止まる。結果に列の ACL は無い。
  - A3: 待ち続けた GRANT は COMMIT の後に `tuple concurrently updated` で失敗する。本体と rollback で記録に完全に戻る。
  - A4: 確保だけを実行すると、6 つのシステム列の行の xmin がこのトランザクションになる。ACL は変わらず、表のロックも取らない。他の相手の項目は残る。
  - 追加の測定（手で実行。この PR のランナーには入れていない）: PR #370 のランナー（`547d9f92`、読み取りのみ）を A1 の写しで実行すると、C0〜T11 の 40 場面が通り、T12（「システム列の GRANT が通る」ことを確かめる残りの記録）で予想どおり失敗した。T13・O は、T12 で止まったため未実行。
- A1 に残るもの:
  1. **角のケース**: システム列に、owner から owner 自身への項目がすでにあれば、確保の REVOKE がそれを消す（A4 で実測。狭める側だけ。API の役割には影響しない）。前提で「owner→owner の項目があれば止める」を足しても、確認と確保の間に同じ owner のセッションが自分に付ける場合は残る。
  2. PostgreSQL の実装に依る（GRANT・REVOKE が行を書き換えること、2 つ目の書き手が待つこと）。PG17.11 の実測で、公開の API の保証ではない。xmin の確認で、書き換えが省かれたら止める形にする。
  3. GRANT のイベントトリガー（managed の PostgREST の再読み込みなど）が 2 回動く。managed では NOT_VERIFIED。
  4. 役割の membership、既定の権限は、これでも直列化しない。
- 承認と依存: 製品 SQL の変更なので、**この TASK ではしない**。次の G3 の source TASK として割り当てられ、Codex Sol（高）の限定レビューを受ける必要がある。G5 のファイルは変えずに済む。運用の取り決めも要らない。

### A2: 運用で排他する（保守の時間帯）
- 本体と rollback の実行中は、この表に GRANT できる者（owner の membership を持つ管理者・superuser・grant option を持つ役割）が他の作業をしないと決める。または、接続を止める。
- SQL は変えずに窓を閉じられる。ただし、**承認された運用の契約**が要る（誰が決め、誰が守らせ、どう読み戻すか）。それが無いまま「排他されている」と前提してはいけない。G3 には決められない。

### B: 契約を狭め、残りのリスクを正式に判断してもらう
- PR #370 の契約を「表の ACL と利用者の列の ACL だけ」に改める。システム列の ACL は範囲外と明記する（本体・rollback の両方の窓と、R5 の戻せない狭まりを含める）。
- 黙って受け入れることはできない。ユーザー（またはその委任先）の明示の判断と、docs・完了条件の変更が要る。

### C: 候補を止める
- PR #370 を、A1・A2・B のどれかが決まるまで止める（Draft のまま、適用の手順に進まない）。G5 の L-1 の前提（PR #303 の install）も止まったままになる。
- いちばん安全だが、G5 の owner epoch（PR #303）と、その上の流れが進まない。

| | 窓を閉じるか | 新しい承認 | 残るもの | G5 への影響 |
|---|---|---|---|---|
| A1 | 閉じる（PG17.11 実測） | 次の source TASK と H3 のレビュー | 角のケース、実装依存、membership | なし（G5 の L-1 は表単位のまま） |
| A2 | 運用で閉じる | 運用の契約の承認 | 守られなかった場合 | なし |
| B | 閉じない | リスクの受け入れの判断 | システム列の窓（本体・rollback）、R5 | なし |
| C | — | — | 進まない | PR #303 以降が止まる |

- G3 の推奨: **A1 を次の source TASK の候補にする**。そのうえで、A1 でも残るもの（角のケース・membership・managed）を B の形で明記し、判断を求める。この推奨は決定ではない。

## 4. G5 との境界と質問（G5 のファイルと Issue 本文は変えていない）
- G5 #303・#371 の L-1 検査（`private.account_lifecycle_owner_epoch_exposure()`）は `has_table_privilege` だけを見る。G5 の木の `001_brand_owner_epoch.sql` の 93〜100 行で確認した。列を通した INSERT・UPDATE・REFERENCES、システム列は見ない。
- G3 の候補が列の ACL を止めても、G5 の install の後に付いた列の権限は G5 の検査では見えない。これは G5 の判断の範囲。
- G5 PR #424（Data API 2026-10-30）の D-2 は、別の表で authenticated に**列単位**の SELECT を提案している。「プロジェクト全体で列の ACL を禁止する」とは決められず、表ごとの方針が要る。
- G5 への質問（1 件のコメントで照会する）:
  1. `brand_memberships` で将来の列の ACL は「全面禁止」か「許可したものだけ」か。誰が決めるか。
  2. L-1 の検査（exposure）を、列（`has_any_column_privilege`）とシステム列（`pg_attribute.attacl` の非 NULL）まで広げるか。広げるなら G5 の別の TASK か。
  3. システム列の SELECT・REFERENCES を、保証の範囲から外すこと（B）を G5 として許すか。
  4. 管理者の DDL と membership の変更を排他する運用（A2）が要る場合、誰が承認して実施するか。
  5. managed での「値の同じ ALTER・GRANT が行を書き換えること」と、イベントトリガーの副作用を、G5 の managed の使い捨ての環境（Phase 11・13）で確かめる道はあるか。
  6. Data API 2026-10-30 での `brand_memberships` の owner と明示の GRANT の決定は、G3 の 001 の前提（owner として実行・既定の付与の模型）とどう噛み合うか。
- MAINTAIN と SELECT の grant option の方針、managed の役割の構成、P7・U8・U9 は未解決のまま。

## 5. 承認の関門（後続）
1. ユーザー（または委任先）が、A1・A2・B・C のどれで進めるかを決める。
2. A1 なら: G3 の source TASK（PR #370 の本体・rollback・ランナー・docs）→ Codex Sol（高）の限定レビュー。
3. A2 なら: 運用の契約の文書と承認 → 本番の手順へ反映。
4. B なら: 正式なリスクの受け入れの記録と、PR #370 の docs・完了条件の変更 → H3 のレビュー。
5. どれでも: managed の読み取り（別の承認）、G5 の質問への回答、MAINTAIN・SELECT の grant option の決定。本番は NO_GO のまま。

## 6. テストと NOT_VERIFIED
- `system_column_acl_run.sh` → `SYSTEM_COLUMN_ACL_EVIDENCE_ALL_PASS`（R1〜R5、A1〜A4。PG17.11、READ COMMITTED、ローカルのソケットだけ）。
  - R の各場面は、**残りがあることを確かめるもの**。PR #370 が直されると R1・R3・R5 は失敗するように作ってある（その時は、この PR の期待を更新する）。PASS は security PASS ではない。
  - A の各場面は試作の実測で、候補の PASS ではない。
- NOT_VERIFIED:
  - managed（PG17.6・supautils・イベントトリガー）
  - 全ての分離レベル・全ての競合・将来の PostgreSQL
  - システム列の権限を使って何が読めるか（実演しない）
  - A1 の試作での PR #370 のランナーの T13・O
  - 役割の membership の変更との競合
