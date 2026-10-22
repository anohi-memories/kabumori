# G3｜Supabase Data API の権限の既定変更（2026-10-30）の G3 影響一覧と明示 GRANT の責任境界（2026-10-22、Issue #318 TASK 20/50）

- task_id: `postona-g3-data-api-grant-impact-inventory-20261022`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **読み取りの調査と docs だけ。** 製品 SQL・migration・GRANT・ACL・RLS・Auth・Edge は変えていない。本番は NO_GO。修正はどれも別の TASK で、独立のレビューとユーザーの承認が要る。
- 期限: 影響一覧は 2026-10-27（G5 の指令 `SUPABASE-DATA-API-20261030-CROSS-SLOT`）。変更の適用は 2026-10-30。
- 根拠の印:
  - [O] 一次情報（Supabase の changelog）
  - [M] origin/main `0c42933c` のソース
  - [C] G3 の Draft PR の候補（未適用）
  - [D] 使い捨ての PG17 での実測（この TASK の模型、または G5 #441）
  - [E] 推定
  - [U] 未確認

## 1. 一次情報の照合 [O]
出典: Supabase Changelog・GitHub Discussion #45329「Breaking Change: Tables not exposed to Data and GraphQL API automatically」。2026-04-28 公開。2026-10-22 JST に G3 が読んだ。

| 項目 | 一次情報の内容 | G3 の扱い |
|---|---|---|
| 既存のプロジェクトへの適用日 | 2026-10-30。本文に加えて、コメントで引用されたメールの文が「既存プロジェクトは 10/30 まで今の既定のまま」と述べる。 | G5 の文書と一致。適用日そのものは本文で確認 |
| 変わる既定 | `public` の新しい表に、`select, insert, update, delete` を anon・authenticated・service_role へ自動で付けなくなる。既定を戻す SQL は、シーケンスの `usage, select` も外す。 | 確認 |
| 対象のスキーマ | `public` だけ。storage・auth・realtime・独自のスキーマは今の付与と既定を保つ。 | 確認 |
| 既存の表 | 今の付与を保ち、到達できる（本文と、保守者のコメント）。 | 確認。**旧表への影響は無い** |
| 作り方 | SQL editor・migration・Management API・MCP・CLI のどれでも同じ。 | 確認。**再作成（db reset・preview・空からの再構築）は「新しい表」として影響を受ける** |
| TRUNCATE・REFERENCES・TRIGGER | 公開された revoke の SQL ではこの 3 つが残る、とコメントにある。保守者は答えていない。 | **[U]**。そのため §3 は 2 つの模型（postA・postB）で測った |
| 関数の EXECUTE | 本文の範囲外。PUBLIC の EXECUTE は PostgreSQL の既定のまま、と保守者が答えている。 | 関数は影響外として扱う（R-11 は維持） |
| どの役割の既定か | 本文の SQL は `for role postgres in schema public` だけ。`supabase_admin` の既定が残るという報告があるが、未確認。 | **[U]** |
| ローカルの CLI | `config.toml` の `auto_expose_new_tables = false` で、`supabase start`・`db reset` が revoke を流す（保守者）。この設定は 10/30 に削除予定。 | 参考 |

## 2. 調べた範囲（G3 所有のソース）
- 候補 SQL [C]（G3 スタックの先頭 PR #392 `f34aab97` の木と、PR #370 `547d9f92`）:
  - `postona_x_reservations/001〜006`
  - `postona_threads_reservations/007`
  - `postona_x_oauth_t13_guard/001`
  - `postona_x_publish_enabled_t13_guard/001`
  - `postona_x_publish_entitlement/001・002`
  - `postona_brand_memberships_privileges/001`（各 rollback を含む）
- Edge [C][M]:
  - `postona-x-reservations`・`postona-x-reservation-worker`・`postona-x-single-post`（`_shared/postona_reservations`）
  - Threads の dispatcher・worker
  - x-test-post（G3 の PR #349・#352 が変更を持つ）
- main の migration [M]: `public.brand_memberships` を作る `20260918120000`。x-test-post が使う表を作る migration。
- G3 スタックに migration は無い（`git diff origin/main...f34aab97 -- supabase/migrations` が 0 件）。
- 走査の道具: G5 の `common_account_data_api_grants_scan.py`（G5 PR #424 `f13ce2fd` から `git show` で読み出した。変えていない）。G3 の候補（テスト以外）と main の 117 個の migration にかけた。

## 3. 影響一覧

世界の模型（[D]、この TASK の模型。§7 の付録）:
- **pre**: 表の owner の既定が「表に all」（今のプラットフォームの模型）
- **postA**: 既定が何も付けない
- **postB**: 既定が `truncate, references, trigger, maintain` だけを付ける（§1 の未確認のコメントの場合）

| # | オブジェクト | 作成元 | ロール | 必要な操作 | 今の明示 GRANT | 症状（旧表／再作成） | 担当 owner | 修正の候補 | 根拠 | 確度 | 優先度 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `public.brand_memberships` | main `20260918120000` | authenticated | 自分の行の SELECT（アプリ・admin・consult・dry-run・history-learning が利用者の JWT で読む） | `grant select … to authenticated` あり | 旧表: 影響なし。再作成: postA・postB とも SELECT は残る | 案: G3（G5 Q1） | なし | [M][D] | 高 | — |
| 1 | 同上 | 同上 | service_role | **ソースでは直接の使用が見つからない**（書き込みは表の owner の definer RPC と FK の cascade） | **なし**（既定に頼っている。migration のコメントは「service_role だけが書く」と書く） | 旧表: 影響なし。再作成: postA・postB とも service_role の DML は無くなる。今のソースでは症状は出ない見込み [E] | 案: G3 | migration を R-2・R-3 の形に書き直す（`revoke all … from public, anon, authenticated, service_role` → `grant select … to authenticated`）。service_role の付与は、使う道が示された場合だけ（R-6） | [M][D] | 中（ソースの走査だけ。本番のコードの外の利用は [U]） | 高（作り直しの前） |
| 1 | 同上 | 同上 | anon・PUBLIC | なし | `revoke all … from anon` あり。PUBLIC への revoke は無い | 再作成 postB: authenticated・service_role に TRIGGER・TRUNCATE・REFERENCES・MAINTAIN が付く（G5 の L-1 は install を拒む）。postA: 付かない | 案: G3 | 上と同じ書き直しで、どちらの世界でも同じ ACL になる | [D] | 高 | 高 |
| 2 | PR #370 の `001`（候補） | G3 [C] | — | 001 の事後条件「service_role の SELECT・INSERT・UPDATE・DELETE が残る」 | — | pre: 適用できる。**postA・postB: `BM_PRIV_POSTCONDITION_SERVICE_ROLE_DML_LOST` で止まる**（何も変えない）。postB では authenticated の TRIGGER などが残るので、001 自体はまだ要る | G3 | G5 Q6 の (b): この事後条件を「前提の報告」に変える。service_role の DML を要件から外すかは 1 と一緒に決める。(a) 明示の GRANT は R-6 の根拠が要る | [D]（G5 #441 と同じ結果を G3 も再現） | 高 | 高 |
| 3 | `postona_x_resv.*`（batches・reservations・audit・single_post_bindings） | G3 [C]（未適用） | anon・authenticated・service_role | なし（definer の関数だけ） | スキーマと全部の表・シーケンス・関数に `revoke all … from public, anon, authenticated, service_role` | **影響なし**。独自のスキーマは変更の対象外 [O]。Edge は専用のログインの役割（`postona_resv_api`・`postona_resv_worker` の member）で**Postgres に直接**つなぐ（`POSTONA_RESV_DATABASE_URL`）。Data API を使わない | G3 | なし | [C][O] | 高 | — |
| 4 | `postona_threads_resv.reservations` | G3 [C]（未適用） | 同上 | 同上 | 同上（専用の役割に schema USAGE と関数の EXECUTE だけ） | **影響なし**（3 と同じ理由） | G3 | なし | [C][O] | 高 | — |
| 5 | `public.social_mobile_account_deletion_x_unconfirmed`・`…_ack_receipts` | G3 [C]（`postona_x_publish_entitlement/002`） | API の役割 | なし（definer の関数を service_role が EXECUTE） | 作成と同じファイルで RLS を有効にし、`revoke all … from public, anon, authenticated, service_role` | **影響なし**（どの世界でも付与なし）。R-2・R-3 に沿っている | G3 | なし | [C] | 高 | — |
| 6 | `public` の G3 の関数（T13 の guard 2 つ、`check_/set_x_account_publish_authority`、`postona_x_stop_*`、削除の saga の関数） | G3 [C] | 1 つの役割ずつ | EXECUTE | `revoke all … from public, anon, authenticated, service_role` ＋ 明示の EXECUTE | **影響なし**（関数は変更の対象外 [O]。R-11 は満たしている） | G3 | なし | [C][O] | 高 | — |
| 7 | x-test-post が REST で使う 12 の表（tips・scheduled_posts・interaction_topics・market_contexts・market_holidays・useful_tips・useful_tip_verifications・oauth_token_store・morning_report_runs・close_report_runs・us_premarket_report_runs・publish_claims）と、admin_users・post_v2_content_snapshots | main の各 migration | service_role（REST） | 使う操作は GET・POST・PATCH だけ（ソースから抽出） | 使う操作は、どれも作成の migration で service_role に明示の付与がある（走査と目視） | **影響なし**。旧表はもちろん、作成の migration で作り直しても、pre・postA・postB の 3 つの世界で必要な権限がそろう（12 表 × 3 世界 = 36/36。migration の失敗は 0） | 表の owner は G3 ではない（Kabumori のレポート・X bot の持ち主。G3 は x-test-post の Edge の変更だけを持つ） | なし | [M][D] | 高 | — |
| 8 | x-test-post の RPC（`fail_scheduled_post`・`get_shared_market_report`・`read_x_publish_credential_for_resume_v2` など） | main | service_role | EXECUTE | 関数ごと | **影響なし**（関数は対象外） | 各関数の持ち主 | なし | [O][M] | 中 | — |
| 9 | migration の外にある表: `brands`・`social_accounts`・`social_account_oauth_states`・`published_content_fingerprints`・`brand_settings`・`daily_content_plans`。`brand_id` の列 4 つ | migration なし（本番と fixture だけ） | service_role（REST。`_shared/brand/brand_context.ts` が brands・social_accounts・brand_settings を、`ai_lab_brand_post_store.ts` が published_content_fingerprints を読む）、authenticated（policy） | 読み取り | 本番の付与は [U] | 旧表: 10/30 では壊れない。**どの世界でも作り直せない**（G5 C-5、G4 の実測）。10/30 の後に migration を足さずに手で作り直すと、REST の読み取りは 42501 になる見込み [E] | G4 の提案: social_accounts・oauth_states・brands は G4、published_content_fingerprints は G3。brand_settings・daily_content_plans・brand_id の列は未定 | 持ち主を決めたうえで、作成の migration（R-2・R-3）を各持ち主の TASK で用意する | [M][E] | 中 | 中（作り直しの前に必要） |

まとめ:
- **10/30 の当日に壊れる G3 のものは無い**（既存の表は付与を保つ [O]。G3 の候補は未適用で、独自のスキーマか明示の revoke。x-test-post は明示の付与）。
- **作り直す場合に問題になるのは 2 つ**: `brand_memberships` の service_role・PUBLIC の扱いと、それに依る PR #370 の 001 の事後条件（#1・#2）。それに、migration の外の表（#9）。

## 4. 責任の境界と G4 の 3 つの質問への G3 の答え（**提案。決定は担当ちゃ・ユーザー**）
- G4 の質問（#318 コメント 6317113668）:
  1. 持ち主の提案:
     - `social_accounts`・`social_account_oauth_states` は G4 → G3 は**同意する**。
     - `brands` は G4（案） → G3 は**同意する**。publish_mode などを G3 が読むのは、読み取りの依存として扱う。
     - `published_content_fingerprints` は G3（案） → G3 は**引き受ける用意がある**。ただし、読む側に AI Lab のブランド投稿（`ai_lab_brand_post_store.ts`）があるので、担当ちゃの確認を条件とする。
  2. `brand_settings`・`daily_content_plans`・4 つの表の `brand_id` の列:
     - `brand_settings` と `brand_id` の列: 読む側は `_shared/brand`（ブランド投稿）と X の自動投稿の migration。G3 は候補の一つだが、**G3 だけでは決めない**（AI Lab・Kabumori のレポートの持ち主にも関わる）。
     - `daily_content_plans`: main で使うのは social-mobile の削除の候補（`20260928160000`）だけ。G3 の投稿の道では使っていない。**G3 ではない**と考える（持ち主は UNKNOWN）。
  3. G3 の新しい候補の表は R-2・R-3 に沿っているか → **沿っている**（§3 の #3〜#5。作成と同じファイルで RLS・revoke all・最小の付与）。沿っていないのは main の `brand_memberships` の migration（#1）だけ。
- G5（#441 の Q1〜Q6）との整合:
  - Q1: `brand_memberships` の列の ACL は「既定で禁止、許可リストは空」が G5 の提案。G3 の 001 の「列の ACL があれば止める」と矛盾しない。
  - Q2: L-1 を列とシステム列に広げるのは G5 の別の TASK（G5 の第 20 TASK が進行中）。G3 の SQL は変えない。
  - Q6: G3 の模型でも G5 と同じ結果になった（post では 001 が `SERVICE_ROLE_DML_LOST` で止まる）。直す場所は表の migration と 001（どちらも G3）。
  - 作成の migration の持ち主（`brand_memberships`）は**まだ決まっていない**（G5 は G3 を提案）。
- G6 など: 共有のパスの競合は無い（G6 の `ai_ledger` は独自のスキーマで影響なし、G5 C-2）。G3 の調査は G4・G5・G6 のファイルを変えていない。

## 5. 要対応の項目と別 TASK の候補（どれも未着手。割り当ては担当ちゃ）
| # | 内容 | 担当（案） | 期限（案） | 依存 | 隔離の試験 | rollback | 独立のレビュー |
|---|---|---|---|---|---|---|---|
| T-1 | `brand_memberships` の作成の migration を R-2・R-3 の形にする案（新しい migration として、`revoke all … from public, anon, authenticated, service_role` → `grant select … to authenticated`）。service_role の付与をするかは、使う道の調査の結果で決める | G3 | 10/30 より前に案を出す（適用は承認の後） | 持ち主の決定、G5 Q1 の承認、PR #370 の方針（A1・A2・B・C） | PG17 で pre・postA・postB の 3 つの世界、既存の付与がある表への再適用（旧表）、利用者の自分の行の読み取り、拒否の確認 | 新しい migration の逆（付与を元に戻す）は既存の表の ACL の記録が要る（PR #370 の prestate の考え方） | Codex Sol（高） |
| T-2 | PR #370 の 001 の事後条件 `SERVICE_ROLE_DML_LOST` を、post の世界で止まらない形にする（G5 Q6 の (b)） | G3 | T-1 と同時 | T-1、PR #370 の P2 の方針 | PG17 の 3 つの世界で 001 と rollback。PR #370 の既存の回帰 | 001 の rollback（prestate の行）は変えない | Codex Sol（高） |
| T-3 | 本番の読み取りの監査（`brand_memberships`・x-test-post の表・migration の外の表の ACL、owner、既定の権限、`supabase_admin` の既定） | 担当ちゃが割り当て（G5 の監査 SQL を使う） | 10/27〜10/30 | ユーザーの承認（読み取りの接続） | — | 読み取りだけ | — |
| T-4 | `published_content_fingerprints` などの migration の外の表の作成の migration | 持ち主の決定の後、各持ち主 | 作り直しの前 | §4 の持ち主の決定 | PG17 の空の DB から、R-2・R-3 | 新しい migration の逆 | Codex Sol（高） |
| T-5 | `service_role` で `brand_memberships` を直接使う道が本番のコードの外（手作業・外部の仕組み）にあるかの確認 | G3（docs）と担当ちゃ | T-1 の前 | — | — | — | — |

- PR #370 の A1・A2・B・C の選択とは独立に扱える。ただし T-1・T-2 は同じファイルに触るので、順番は担当ちゃが決める。
- G3 はリスクの受け入れをしない。

## 6. 未解決と NOT_VERIFIED
- PR #370 の P2（システム列の ACL の窓）、P7・U8・U9 は未解決のまま。本番は NO_GO。
- [U]:
  - 本番の ACL・owner・既定の権限（`postgres` と `supabase_admin` の両方）
  - 10/30 の後の新しい既定が TRUNCATE・REFERENCES・TRIGGER を付けるか（§1）
  - preview branch・ローカルの CLI の 10/30 の後の動き
  - Data API が公開するスキーマ、GraphQL の有無
  - 本番のコードの外で service_role が `brand_memberships` に書くか
- この模型は `brand_memberships` の migration の作成部分（41〜66 行）だけを空の DB で流したもの。migration 全体（前提の検査と他の表の policy）は流していない（空の DB では `PHASE4_PREFLIGHT_MISSING_TABLE:brands` で止まる、G4・G5 の実測）。

## 7. 付録: 実行した確認
- G5 の走査（読み取り）: G3 の候補（テスト以外）→ public の新しい表は 2 つ（#5）で、どちらも明示の revoke。public の外の表は走査の対象外なので目視で確認した（#3・#4）。main の 117 個の migration → x-test-post の 14 の表はどれも明示の付与あり。migration の外の表は 5 つ（4 つの土台の表と、動的 SQL で作られる `ai_lab_topic_claims`。G5 の C-3・C-5 と同じ）。
- x-test-post の REST の操作の抽出: テスト以外の 29 ファイルから、`/rest/v1/<表>` と直後の `method` を読み取った（§3 #7）。
- 模型（使い捨ての PG17.11、ローカルのソケットだけ、偽の役割）。各世界で、次の 3 つを実行した:
  1. `brand_memberships` の作成部分（`20260918120000` の 41〜66 行）を流して権限を読む。
  2. PR #370 の 001（`git show 547d9f92`）を当てる。
  3. x-test-post の表の作成の migration 9 個を順に流し、service_role に必要な操作の権限を確かめる。

  | 世界 | brand_memberships（作成の後） | PR #370 の 001 | x-test-post の表 |
  |---|---|---|---|
  | pre | authenticated＝MAINTAIN・REFERENCES・SELECT・TRIGGER・TRUNCATE、service_role＝8 つすべて | 適用できる（authenticated＝MAINTAIN・SELECT） | 12/12 ok |
  | postA | authenticated＝SELECT、service_role＝なし | `SERVICE_ROLE_DML_LOST` で止まる | 12/12 ok |
  | postB | authenticated＝MAINTAIN・REFERENCES・SELECT・TRIGGER・TRUNCATE、service_role＝MAINTAIN・REFERENCES・TRIGGER・TRUNCATE | `SERVICE_ROLE_DML_LOST` で止まる | 12/12 ok |

  模型のスクリプトは G3 の作業用の一時ファイルで、この PR には入れていない（docs だけの PR のため）。各世界の既定の付与は、表の owner の `alter default privileges in schema public` で作った（postA は付与なし）。
