# N3 hardening — Codex review fixes + H1 / M1 / M2（2026-09-28）

- branch: `claude/n3-hardening-20260928`（base: N3 `1ef3a2af986c1e696f66cf99d80d6160e5a8c44f`）
- worktree: `/Users/yuya/Developer/kabumori-n3-hardening`（Claude 専用。他 workstream と共有しない）
- production_mutation = 0、real_web_search = 0。migration 未適用・deploy なし・Cron なし・secret 変更なし。

## 1. Codex 修正の回収

- Codex review worktree（`/private/tmp/kabumori-n3-review-20260928`、branch `codex/n3-review-20260928`）は**読み取りのみ**で扱った。
  - 編集、stage、commit、reset、checkout は一切していない。
  - 回収前後とも未 commit の差分は 11 件のままだった。
- 回収手順:
  1. `git diff --binary` で tracked 9 ファイルの差分を scratchpad に patch として保存（sha256 `6b8205f7…`）。
  2. untracked 2 ファイル（`docs/news-sources/n3_review.md`、`supabase/functions/_shared/news_discovery/n3_review_test.ts`）をコピー。
  3. 同じ base から作った新しい Claude 専用 worktree に `git apply` した（競合なし）。
- 回収直後に Codex の基準 **112/112 PASS**（型検査込み）を再現した。
- 回収した修正（詳細は `n3_review.md`）:

| 区分 | 内容 |
|---|---|
| 検索予算 | hard cap の競合、REPEATABLE READ の古い snapshot 対策（config 行への no-op UPDATE） |
| URL・制限ドメイン | 末尾ドット付き制限ドメインのすり抜け、危険な URL の受理（localhost / private / local / IP literal / 認証情報付き）、`blocked_domains` を request に反映 |
| 応答処理 | partial response の取り込み禁止（root・search action の completed を要求）、provider エラー時も usage を保持 |
| RPC | `begin_run` / `reserve_search` の再送をやめた（retry 0） |
| 整合性 | search_id と run の一致、escalation の親の制約、終了済み run への insert 競合（FOR UPDATE）、`multiple_weak` は別名 2 件以上、発見専用 raw_reference の allowlist |

## 2. HIGH：invocation 全体の deadline（`run_deadline.ts`）

Supabase Edge Functions の制限（公式 limits ページ、2026-09-28 確認）:

- request idle timeout 150 s（応答が無ければ 504）
- wall clock 150 s（Free）/ 400 s（有料）
- CPU 2 s

observer は処理の最後に応答するため、プランに関係なく run 全体を 150 s より十分短く収める。

| 値 | 設定 | 理由 |
|---|---:|---|
| invocation_budget_ms | 120,000 | 150 s idle timeout に対して 30 s の余裕（cold start・alias 構築・応答） |
| finalization_reserve_ms | 25,000 | この時間には新しい取得・検索を始めない。保存・complete_search・finish_run に使う（RPC timeout 20 s） |
| min_fetch_usable_ms | 3,000 | 使える時間がこれ未満なら source 取得を始めない |
| min_search_usable_ms | 20,000 | 初回検索・ローテーション・トリガー検索の開始条件 |
| min_followup_usable_ms | 40,000 | follow-up（escalation）は最低優先。残り時間が少なければ即座に skip する |

- 数値は `OBSERVER_DEADLINE` だけにある。handler が invocation 開始時に `RunDeadline` を 1 つ作り、pipeline と検索ステージに渡す。
- 対象:
  - DIRECT source と GDELT の各 request：開始前に判定し、timeout は `min(source timeout, 使える時間)` に抑える。
  - 各検索：開始前に判定し、**判定で落ちたものは `reserve_search` をしない**。provider の timeout は使える時間に抑える。
  - DB 保存と finish_run：reserve の中で必ず実行する。
- 残り時間が無い時の順序は「新しい fetch / search を始めない → 取得済み signal を保存 → 検索の usage を保存 → run を finish」。強制終了は待たない。
- 状態:
  - deadline 到達時は `completed_with_errors`、error_summary に `DEADLINE_REACHED:sources_skipped=…:searches_skipped=…`。
  - skip した request は `run_sources.requests[].outcome = DEADLINE_SKIPPED`（source の失敗としては数えない）。
  - `news_discovery_runs.execution`（jsonb **1 列のみ追加**）に deadline_ms、deadline_reached、sources_completed / skipped、searches_completed / skipped、elapsed_ms、signals_persisted（DB で数えた値）を保存する。

## 3. M1：検索費用と保存済み signal の整合

- **順序の変更**：各検索の signal を**先に DB へ保存**し、その後で `complete_search` を呼ぶ。feed の signal も検索の前に保存する（`DiscoveryRun.persist()`）。
- **discovered と persisted を分けた**:
  - `news_discovery_searches.new_signal_count` / `useful_signal_count`：メモリ上で発見した候補（client の値）。
  - `persisted_signal_count` / `persisted_useful_signal_count`（**新規 2 列**）：`complete_search` が `news_discovery_signals.search_id` から**DB で数えた値**。
- **run の集計は DB 由来**：`finish_run` は次の値を行から集計する。client の totals が `{}` でも、実際に使った分は消えない。

| run の列 | 集計元 |
|---|---|
| search_count / search_denied_count | そのrunの検索行 |
| ai_calls / web_search_calls | 検索行の合計と client 値の大きい方 |
| search_result_count | 検索行の合計と client 値の大きい方 |
| search_useful_signal_count | 保存済みの有用 signal を検索行と結合して数える |
| inserted_count | `first_run_id` で数える |

- **保存失敗時**（検索は成功し、signal の保存に失敗）:
  - 検索行は `succeeded` のまま `error_code = SIGNAL_PERSIST_FAILED` で完了する。usage（呼び出し・tool 回数・tokens・結果数・lane・reason）は保持される。
  - **同じ検索の再実行も、その run での追加の検索もしない**（二重課金の防止）。
  - run は `failed`（500）。保存できなかった signal は run の終了処理で DB 書き込みだけ再試行する（検索は再試行しない）。
- **handler の失敗経路**：catch で `totals={}` を渡すのをやめ、それまでの source 進捗と検索 usage を渡す（DB 側でも上記のとおり集計する）。
- **「保存済み有用 signal 1 件あたりの費用」の計算**:

```sql
select s.lane, count(*) searches, sum(s.input_tokens) in_tok, sum(s.output_tokens) out_tok,
       sum(s.web_search_calls) tool_calls, sum(s.persisted_useful_signal_count) persisted_useful,
       round(count(*)::numeric / nullif(sum(s.persisted_useful_signal_count), 0), 2) searches_per_useful
from public.news_discovery_searches s
where s.status in ('succeeded', 'failed') and s.search_day >= current_date - 14
group by 1;
```

## 4. M2：並行 run の dedupe（安全な範囲）

- `insert_signals` の処理順:
  1. バッチ内の `url_key` ごとに `pg_advisory_xact_lock(hashtext('news_discovery_url'), hashtext(url_key))` を**昇順で**取る。バッチ間で deadlock しない。
  2. lock の中で URL 規則を DB 内で判定する。対象は、同じ canonical URL / url_key を持つ既存行が「別 source」、または「同じ source で同じタイトル指紋」の場合。
  3. 該当すれば `duplicates` として返し、書き込まない（エラーにしない）。
- **一意制約は追加していない**。同じ source が同じ URL を新しいタイトルで再利用するケース（ESRI）と、同じ source・同じタイトルで別 URL / 別 id の文書（官邸）を必ず残すため。
- READ COMMITTED（PostgREST の既定）を前提にした lock 方式。lock 取得後の各文は、先行 run が commit した行を見る。

### 意図的に残した dedupe 課題

- **別 source 間のタイトル一致（72 時間）**は application レベル（`find_duplicates`、run 内の in-memory）のまま。並行 run では両方が保存され得る。
  - DB の一意制約にすると官邸の同名文書などを壊すため、しない。
  - 観測 pool の重複率に影響するだけで、既存 monitor / Push / X には未接続。
- **REPEATABLE READ で `insert_signals` を呼ぶ場合**、古い snapshot により URL 重複が保存され得る（予算とは違い、fail-closed にしていない）。PostgREST は READ COMMITTED なので実運用の経路では起きない。

## 5. 検証

### 自動テスト

`deno test --no-config --no-lock --node-modules-dir=none --cached-only --allow-read=supabase …` → **122 passed / 0 failed**（型検査込み。基準 112 から 10 件追加）。

追加した境界テスト:

- deadline の値と上限
- feed 取得中の deadline 到達（残りの source を skip・保存・execution を記録）
- deadline で検索を予約しない / follow-up を先に落とす / provider の timeout を抑える
- 検索成功後の保存失敗（usage 保持・再検索なし・run failed）
- 保存 → complete の順序
- 失敗 run の usage 保持
- DB が判定した URL 重複の受け取り
- punycode / homoglyph / 末尾ドットの制限ドメイン
- `multiple_weak` の別名 2 件以上
- migration の静的検査（M1 / M2 の不変条件）

### 使い捨て PostgreSQL 17（`supabase/tests/news_discovery_observer_run.sh` → `NEWS_DISCOVERY_MIGRATION_PROOF_PASSED`）

1. superuser でない owner でクリーン適用：7 テーブル・7 関数。
2. 既存オブジェクトの指紋 `f40125a68cf49acc742bdeb04e30dc8d` は、適用前後・ロールバック後ですべて一致した。
3. 振る舞い検証 T1〜T11 はすべて合格:
   - Codex の追加分：T1c カタログ read-back（RLS・owner・空の search_path・ACL）、T8b（run をまたぐ参照・弱い alias の主張・raw body の拒否）。
   - **T10（M1）**：DB が数えた保存済み 2・有用 1。client 値の 5 / 4 は採用しない。空 totals の failed run でも search_count / ai_calls / web_search_calls / results / useful / inserted と execution が残る。
   - **T11（M2、逐次）**：別 source の同じ URL は DB 上の重複、同じ source の同じ URL・新しいタイトルは保持。
4. 予算：47/48 から 2 件を同時に予約すると許可は 1 件だけ（READ COMMITTED）。REPEATABLE READ では古い snapshot の側が serialization failure で中止され、cap を守った。
5. **並行 insert（READ COMMITTED）**:
   - A：別 source・同じ canonical URL を 2 run が同時に保存すると、保存 1 件、他方は `duplicates` として返り、run の失敗なし。
   - B：同じ source・同じタイトル・別 URL / 別 id を同時に保存すると 2 件とも残った。
   - C：別 source・同じタイトル・別 URL は DB では両方残った。
6. ロールバックで `news_discovery_*` はすべて消え、再適用もクリーンだった。

### 残る BLOCKER

- 安全な専用 key による **実 OpenAI Web Search smoke** のみ。
  - 対象の組み合わせ：`gpt-5.6-luna`＋web_search＋strict JSON＋required tool＋`max_tool_calls:1`＋`blocked_domains`＋sources / citations の実応答。
  - 加えて、実応答の usage / tool 回数の形と、timeout 時の課金の扱いを確認する。
