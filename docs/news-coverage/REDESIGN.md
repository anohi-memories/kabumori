# ニュース収集の広さと通知の分離 — 設計（Phase 1）

- 作成日: 2026-09-12
- 担当: Claude slot 1（G1 / `broad-market-news-collection-and-user-notification-control-20260912`）
- 位置づけ: **監査＋設計＋未接続のローカル実装のみ**。本番のDB・Function・Cron・通知・設定は変更していない。
- 関連コード（いずれも `index.ts` から import されていない）
  - `supabase/functions/important-news-monitor/news_coverage_logic.ts`
  - `supabase/functions/important-news-monitor/news_collection_scope_proposal.ts`
  - `supabase/functions/important-news-monitor/news_coverage_logic_test.ts`

## 1. 現状（監査で確認した事実）

### 1.1 収集の広さ

| レーン | 取得元 | 実際の広さ |
| --- | --- | --- |
| `tdnet` / `company_ir` | TDnet一覧HTML＋開示PDF | 国内の適時開示はほぼ網羅 |
| `market_macro` | 公式RSS 5本（日銀・FRB・USTR・UN平和安全・EIA） | 中央銀行と通商・国連の一部のみ |
| `breaking_market` | OpenAI web_search、検索トピック4本 | 1サイクル（20分）に2検索のみ |

- `breaking_market` は1サイクルで「固定1本（critical_market_events）＋ローテーション1本」。ローテーション対象は3本なので、各トピックは**約1時間に1回**しか検索されない。
- 検索トピック4本の内容は、①主要指標・緊急政策・市況、②関税・輸出規制・FRB圧力、③戦争・台湾・中東・ホルムズ、④銀行破綻・中国政策。
- **北朝鮮・Jアラート・地震・津波・台風・取引所障害・コモディティ・米国株セッション・日本株セッションを狙うトピックは1本も無い。**
- 日本語の一次情報（気象庁・防衛省・首相官邸・JPX）は取得元に含まれていない。
- カテゴリ enum（`IMPORTANT_NEWS_CATEGORIES`、30種）に**災害（地震・津波）を表すものが無い**。近いのは `major_security_incident` のみ。
- 1レーンあたりの保存上限は余裕がある（macro 30件／breaking 15件／全体100件）。つまり**制約は上限ではなく「取得元と検索トピックの数」**。

### 1.2 実データ（本番、read-only）

- 直近7日: candidate 599件。うち市場全体（`company_code is null`）は**80件**。
- 市場全体80件のアプリ内 severity: critical 4 / high 9 / medium 8 / **low 59**。
- 直近24時間: tdnet 54件、market_macro 3件、breaking_market 2件（合計59件）。市場全体はわずか5件。

### 1.3 通知の条件（現行）

- 個別銘柄: publish成功時に producer が作成（X tier = important/most_important、Fact passed）。
- 市場全体: `enqueue_market_critical_notifications`。条件は「`market_critical_news=true`（既定OFF）＋`push_enabled`＋`important_news`」×「severity critical」×「登録銘柄の業種一致」×「公開6時間以内」×「Fact passedの日本語テキストあり」。
- `alert_settings` は用途別のbooleanが並ぶだけで、**重要度のしきい値やカテゴリ別の設定は無い**。

## 2. 取りこぼしの追跡

### 2.1 北朝鮮のミサイル発射（2026-09-12）

| 段階 | 結果 |
| --- | --- |
| source discovery / query | **ここで落ちた。** ミサイル・北朝鮮・Jアラートを狙う検索トピックが存在せず、防衛省などの一次情報も取得元に無い |
| fetch 以降 | 到達せず |

- 本番の `important_news_candidates` を直近3日分、`north korea|missile|ballistic|北朝鮮|ミサイル` 等で検索しても**該当0件**。候補として保存された形跡がない。
- 「仕様どおり落ちた」のではなく、**そもそも探していない**。

### 2.2 ホルムズ海峡・タンカーリスク

該当3件が保存されていた。落ちた段階は事象ごとに違う。

| 保存日時(UTC) | タイトル | importance | 関連度 | アプリ severity | 状態 | 落ちた段階 |
| --- | --- | --- | --- | --- | --- | --- |
| 09-09 12:20 | ペルシャ湾北部でタンカーが飛翔体に被弾 | no_post | medium | **low** | rejected | judgement（X基準で no_post）→ severity low でアプリ非表示 |
| 09-10 08:40 | 米イラン衝突で原油100ドル超、アジア株下落 | no_post | high | **medium** | rejected | judgement → 市場ニュースは critical/high のみ表示のため**アプリ非表示** |
| 09-11 14:20 | フーシ派が紅海入口のマユン島を掌握 | important | high | high | published | 通過（Xにも投稿、アプリにも表示） |

- 判定理由には「保存済み情報だけでは安全に確定できないため投稿対象外」と記録されている。これは**X投稿の可否基準**であり、アプリ表示や通知の基準として使うには厳しすぎる。
- `deriveNewsSeverity` は、Fact未確認の市場ニュースを**構造上 medium 以上に上げない**。そして `get_my_important_stock_news` の市場フィードは critical / high しか出さない。結果として「収集できたのに誰にも届かない」帯（medium と low）が生まれている。

### 2.3 根本原因

1. **収集が検索トピック4本・RSS 5本に固定**され、安全保障・災害・物流・金融インフラを誰も探していない（北朝鮮の直接原因）。
2. **1サイクル2検索の予算**で、ローテーションが1時間に1周。速報性が必要な事象に間に合わない。
3. **1つの `importance` がX投稿とアプリ表示の両方を決めている**ため、「Xには出さないがアプリには出したい」ニュースが rejected として消える。
4. **市場フィードが critical / high のみ**で、medium 以下は保存されていても表示されない（ホルムズの直接原因）。
5. **通知の広さをユーザーが選べない**（market_critical_news の ON/OFF のみ）。「多めに通知」を選ぶ手段が無い。
6. **災害カテゴリが無い**ため、地震・津波は分類先すら無い。

## 3. 設計

### 3.1 3層に分ける

```
Collection（広く集める）→ Classification（重要度・カテゴリ・関連度）→ Notification policy（ユーザー設定で判定）
```

- 収集の可否は「一次情報のURLと時刻が検証できるか」だけで決める（`shouldStoreForCoverage`）。
- **「登録銘柄と関係が薄い」「通知がうるさい」を収集段階の理由にしない。**

### 3.2 収集範囲（`news_collection_scope_proposal.ts`）

追加する検索トピック7本（既存4本は維持）。

| key | slot | 主な対象 |
| --- | --- | --- |
| `japan_security_emergency` | 固定 | 北朝鮮ミサイル・Jアラート・EEZ・台湾海峡 |
| `disaster_infrastructure` | 固定 | 地震・津波・噴火・台風・停電・製油所停止 |
| `shipping_chokepoints` | 回転 | ホルムズ・スエズ・紅海・パナマ・タンカー・運賃 |
| `financial_system_infrastructure` | 回転 | 取引所障害・決済障害・銀行破綻・サイバー攻撃 |
| `commodities_energy_supply` | 回転 | OPEC・原油供給・LNG・金・銅・レアアース |
| `us_market_session` | 回転 | 米国指数・半導体・AI設備投資・米金利 |
| `japan_market_session` | 回転 | 日経・TOPIX・円相場・日銀・経済対策 |

追加する公式RSS 8本（いずれも一次情報。配信の実在はwiring前に個別確認が必要）。

- 気象庁（地震・火山／気象警報）、防衛省、財務省、JPX、首相官邸、米財務省、米商務省BIS

検索コスト（明示）: 固定3本＋回転1本 = **1サイクル4検索（時間12回）**。現行は2検索（時間6回）。回転8本で一周160分。

### 3.3 重要度（`news_coverage_logic.ts`）

`emergency / critical / high / medium / low` の5段階。

- 既存の `deriveNewsSeverity`（SQLと文字列一致でミラーされている）は**変更しない**。その結果に `emergency` を上乗せする形で `classifyCoverage` が返す。
- `emergency` は**業種一致を不要**にする。ただし誤報防止のゲートは維持する。
  - 一次情報ホスト（Reuters・AP・Bloomberg・日経・各政府機関・気象庁・防衛省・JPX 等）かつ https
  - 公開から6時間以内、時刻がパースできる
  - 事象パターン**と**深刻度パターンの両方に一致（「北朝鮮と協議」「防災訓練」は emergency にならない）
  - 企業コード付きの開示は対象外
- emergency クラス: `missile_near_japan` / `war_escalation` / `chokepoint_disruption` / `taiwan_contingency` / `major_disaster` / `emergency_monetary_action` / `market_infrastructure_failure` / `oil_supply_disruption`

### 3.4 カテゴリ

16カテゴリ（geopolitics / disaster / monetary_policy / fx / rates / oil_energy / commodities / shipping_logistics / semiconductors / ai_tech / us_market / japan_market / regulation_policy / corporate / earnings / financial_system）。

- 既存30カテゴリからの対応表＋見出しのキーワードで**複数付与**する。タンカー攻撃は geopolitics だけでなく shipping_logistics と oil_energy にも入る。
- カテゴリが1つも付かない状態を作らない（カテゴリ別フィルタから漏れるため）。

### 3.5 通知プリセット

| プリセット | 個別銘柄 | 市場全体 | emergency |
| --- | --- | --- | --- |
| 静かめ | critical 以上 | なし | 受け取る |
| 標準 | high 以上 | critical 以上 | 受け取る |
| 多め | medium 以上 | high 以上 | 受け取る |
| 全部通知 | medium 以上 | medium 以上 | 受け取る |

- `low` はどのプリセットでも通知しない（アプリの一覧には残す）。
- カテゴリ別OFFを併用できる。全カテゴリがOFFのときだけ通知を止める。
- emergency は専用スイッチ（既定ON）。プリセットのしきい値には従わない。
- 判定順は「push_enabled → 通知マスタ → 重複 → Fact passedの日本語テキスト → カテゴリ → emergency → 銘柄/業種一致 → しきい値」。**プリセットを広げてもFactゲートと重複防止は超えられない。**

### 3.6 既存との互換

- `market_critical_news=true` のユーザー = 「標準」。OFFのユーザー = 「静かめ」。
- 今日の2つのproducerの挙動は「標準」で再現される（個別high通知あり／市場critical通知あり／市場highは通知なし）。
- 唯一の意図的な差分: 「静かめ」でも emergency は届く。**emergency の既定をONにするかはK1判断**（OFF既定にもできる）。

## 4. schema変更案（expand-only、未適用）

```sql
-- 1) 通知の広さ（ユーザー設定）
alter table public.alert_settings
  add column if not exists notification_preset text not null default 'standard'
    check (notification_preset in ('quiet', 'standard', 'many', 'all')),
  add column if not exists emergency_alerts boolean not null default true;
grant select, insert, update (notification_preset) on public.alert_settings to authenticated;
grant select, insert, update (emergency_alerts) on public.alert_settings to authenticated;

-- 2) カテゴリ別OFF（行で持つ。将来のカテゴリ追加でschema変更が不要）
create table if not exists public.alert_category_settings (
  user_id uuid not null references public.profiles(id) on delete cascade,
  category text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);
-- RLS: 本人のみ select/insert/update/delete

-- 3) 分類の保存（既存列は変更しない）
alter table public.important_news_candidates
  add column if not exists coverage_categories text[] not null default '{}',
  add column if not exists coverage_severity text,
  add column if not exists emergency_class text,
  add column if not exists coverage_classified_at timestamptz;
create index if not exists idx_inc_coverage_severity_time
  on public.important_news_candidates (coverage_severity, published_at desc);
create index if not exists idx_inc_coverage_categories
  on public.important_news_candidates using gin (coverage_categories);

-- 4) 災害カテゴリを既存enumへ追加（check制約の拡張のみ）
--    'disaster' を important_news_candidates.category の許容値に追加する。
```

- `importance` / `japan_market_relevance` / `fact_check_status` / X投稿系の列と関数には触れない。
- フィードRPCは、市場ニュースのしきい値を「critical/high」から「プリセットに応じた値」へ広げる別バージョンを作る（既存関数はそのまま残し、段階的に切り替える）。

## 5. rollout 案（各段階でK1確認）

1. **分類の追記のみ**（schema 3・4を適用、分類を書くだけ。表示も通知も変えない）。実データでemergency検出の精度を確認する。
2. **アプリ表示を広げる**（フィードを medium まで表示、カテゴリ表示を追加）。通知は変えない。
3. **収集を広げる**（検索トピックとRSSを追加、検索予算を4/サイクルへ）。ここで初めてコストが増える。
4. **通知プリセットとカテゴリ設定を導入**（既定は現行互換。UIを追加）。
5. **emergency 通知を有効化**（既定ON/OFFはK1判断）。

## 6. 未接続であることの確認

- `index.ts` は新モジュールを import していない。
- 本番のDB・Function・Cron・通知・ユーザー設定は変更していない。
- `news_severity_logic.ts` と SQL ミラーの一致テストは引き続き合格している。
