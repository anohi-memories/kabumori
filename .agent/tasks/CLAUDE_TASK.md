# Claude Task 2

- task_id: kabumori-voice-gate-product-policy-audit-20260925
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（中）
- purpose: かぶモリの定期配信でVOICEチェックが過剰にfail-closedになっていないかを監査し、Fact/Safetyと文体品質を分離した PASS / WARN / BLOCK 方針を設計する。今回は監査・設計のみ。source変更・deploy禁止。

## Product decision

有料ユーザー向けの定期配信では、
- 少し不自然
- AIっぽい
- 語尾や絵文字が微妙
- 軽い言い回しの違和感
程度で朝刊/大引け等が欠配になるより、Fact/Safetyを満たすレポートが毎日届くことを優先する。

VOICEは原則として「文章品質」の判定に寄せ、
Fact/Safetyと役割を分離する。

目標分類:
- PASS: 問題なし
- WARN: 文体上の軽微な問題。配信は止めない
- BLOCK: 意味破綻・安全上の問題など、本当に配信停止すべきもの

## Critical constraint

現在H2が `kabumori-pr29-plus-v27-validator-final-review-20260925` をレビュー中。
そのレビュー対象ファイルやPRを変更しないこと。

今回はread-only監査・設計だけ。
コード変更、PR作成、merge、deploy、設定変更は禁止。

## Mandatory startup

1. 独立worktree / checkoutを使う。
2. fresh origin/main。
3. 読む:
   - PROJECT_RULES
   - .agent/ORCHESTRATION.md
   - .agent/CURRENT_STATE.md
   - 本TASK
   - 最新G2 report
   - H2の現在TASK
4. H2とファイル競合が起きないことを確認。
5. productionは必要ならread-onlyだけ。

## Audit scope

### A. かぶモリアプリ側

必ず確認:
- personalized-reports の Fact/local/VOICE 相当の全gate
- morning / close
- Pushまでの経路
- どの条件で「保存されない」「通知されない」になるか
- retry/rewriteの有無
- 文体上の問題が配信停止に直結している箇所

### B. 共通/shared側

確認:
- `_shared/kabumori_voice.ts`
- 共通market report packet
- Voice/Fact/Safetyの責務分離
- アプリとXで共通化できるpolicy境界

### C. X側はread-only inventoryのみ

この部屋からX実装TASKは作らない。

ただし統一方針のため、read-onlyで以下を棚卸し:
- morning_report
- close_report
- useful_tip
- morning_greeting
- interaction
- us_premarket_report
- その他 Voice evaluator 利用箇所

各経路について:
- VOICE failで投稿が止まるか
- rewriteがあるか
- rewrite失敗時に元のFact-passed本文を使えるか
- Fact/SafetyとVOICEが混ざっていないか

X側の変更提案は「X担当ちゃへ渡すhandoff案」としてまとめるだけ。

## Required design

### 1. PASS / WARN / BLOCK matrix

最低限以下を分類する。

WARN候補:
- 少しAIっぽい
- 語尾の単調さ
- 軽い冗長
- 絵文字数/位置の違和感
- 見出しが少し不自然
- ニュース記事っぽい文体
- 軽微な日本語のぎこちなさ
- 同義反復
- ブランドトーンからの軽微なズレ

BLOCK候補:
- 意味不明/文意破綻
- 内容が逆転する誤訳
- 明示的な危険な売買推奨
- Fact-passed本文をrewriteで事実変更
- 禁止された断定/捏造
- 個人情報/秘密情報漏洩
- 構造破損で画面/配信が成立しない
- 法令/安全上明確に止めるべき内容

Fact側に残すもの:
- 数値
- 銘柄/主体
- 日付
- 因果
- 根拠
- 市場データとの整合
- unsupported impact
- hallucination

VOICE側に残すもの:
- 自然さ
- 読みやすさ
- ブランドトーン
- 絵文字
- 冗長さ
- 語尾
- AI記事感

### 2. Delivery policy proposal

最低でも次の案を比較する:

A. 現行 fail-closed
B. WARNは1回rewrite、rewrite失敗なら元のFact-passed本文を配信
C. WARNはそのまま配信、非同期改善だけ記録
D. severity閾値方式

推奨案では、
「週に何回も欠配する」ことを避けることを明示的なKPIにする。

### 3. Observability

設計に以下を含める:
- voice_status: pass / warn / block
- warning_codes[]
- rewrite_attempted
- rewrite_succeeded
- fallback_original_used
- delivery_blocked_by
- daily delivery success rate
- block reason breakdown
- Fact pass rate vs Voice warn rate vs true block rate

### 4. Rollout

big-bang禁止。

提案する段階:
1. shadow classification
2. WARN配信許可を一部経路でON
3. 朝刊/大引け
4. その他
5. X側は別部屋で独立レビュー後に切替

## Deliverable

TASK末尾Reportに:
- 現行全経路のgate一覧
- 欠配原因の分類
- Fact / Safety / Voiceの責務分離表
- PASS/WARN/BLOCK定義
- 推奨delivery policy
- 実装影響ファイル候補
- migration要否
- backward compatibility
- rollback
- telemetry
- app側実装TASK案
- X担当ちゃへ渡す完成handoff案
- 推薦実装モデル
- 推薦レビューmodel

今回はsource変更0、production mutation 0。

完了時:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
