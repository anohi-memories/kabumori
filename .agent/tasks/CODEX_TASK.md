# Codex Task

- task_id: kabumori-mobile-holdings-watch-split-and-news-detail-quality-20260922
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: 実機QAで判明した「銘柄画面で保有と監視を分けたい」と「重要ニュースの詳しい内容が実質的に詳細ではない」を改善する。色・アイコンの本格調整は今回は行わない。

## User feedback — real-device QA 2026-09-22

1. 銘柄画面
- 検索統合は概ねOK。
- 登録銘柄一覧は、保有と監視を同じ一覧に混ぜず、別で見たい。

2. 重要ニュース
- 要点の重複は改善したが、「詳しい内容」がまだ詳細ではない。
- 実機例:
  - 国連/フーシ派記事: 詳細が「中東情勢の緊迫化…日本株への具体的な影響は確認できない」程度。
  - ホルムズ海峡タンカー記事: 詳細が実質空で警告表示のみ。
  - 北朝鮮ミサイル記事: 詳細が市場影響の一般論で、出来事自体の追加情報が薄い。
- ユーザー期待は、要点の繰り返しではなく、出来事について追加で理解できる内容。

3. Visual polish
- 各ページの見た目の統一は概ねOK。
- 色・アイコン・細かなビジュアルは今後別タスクで詰める。今回の主目的に含めない。

## Model policy

- **Lunaで実施。**
- UI分割、ニュースデータ経路の調査、deterministic presentation改善、source candidate/testsはLuna。
- Sol不要 unless production mutationやAuth/RLS/security boundaryが必要になる。今回はproduction mutation禁止。

## Scope / safety

Allowed:
- root Kabumori app: `src/app/**`, relevant components/libs/tests.
- important-news generation/presentation source and tests if required to make detail semantically correct.
- local/source candidate only for backend producer changes.

Forbidden in this H1:
- production DB mutation
- migration apply
- Edge Function production deploy
- Cron change
- secret/Vault/provider credential change
- X/Push behavior changes unrelated to important-news app copy
- H2/social-mobile files
- G1/G2 workstream files
- visual redesign of icons/colors beyond what is needed for the requested behavior

## Goal A — split holdings and watch in 銘柄 screen

Current:
- `/explore` integrates search and registered stocks.
- Empty query currently shows all tracked stocks together.

Target UX:
- Search field remains at the top.
- When query is non-empty: show search results as now.
- When query is empty: show registered stocks separated clearly into:
  - `保有`
  - `監視`

Preferred interaction:
- segmented control/toggle `保有 | 監視`, with counts if clean.
- default should be `保有` when holdings exist; if no holdings but watches exist, show `監視`.
- preserve current edit/delete/register flow.
- after registering or changing tracking_type, the item appears in the correct section without needing app restart.
- empty states must be section-specific:
  - no holdings -> `保有銘柄はまだありません`
  - no watch -> `監視銘柄はまだありません`
- search mode should not be broken by the filter state.

Alternative acceptable:
- two stacked sections if segmented control creates native-tab/keyboard issues, but holdings and watch must not be mixed.

Tests:
- holding/watch partition
- default section selection
- empty states
- update after tracking type change if helper logic is extracted.

## Goal B — redefine what 「詳しい内容」 means

The display must have clear semantic roles:

- `要点`: 2–4 concise facts sufficient for quick scanning.
- `詳しい内容`: additional event facts/context that were NOT already shown in 要点.
- `市場との関係` or equivalent: why this matters to the user's stocks/market.

Do NOT use generic market commentary as the main `詳しい内容` if event details are available.

Good detail examples:
- who/what/where/when
- sequence of events
- official/source attribution
- quantities/distances/casualties/affected assets
- what is confirmed vs not confirmed
- prior/related context already present in the source
- operational status after the event

Bad detail examples:
- merely repeating headline/key points
- generic `日本株への影響が注目されます`
- generic `地政学リスクとして重要です`
- a warning icon with no explanation when source-backed detail exists

## Goal C — diagnose source of shallow detail before changing behavior

First trace the full data path for the three classes visible in screenshots:
- AP / breaking-market style item
- UN News / official source item
- North Korea / geopolitical item

Determine for each:
1. raw/stored source text available to the pipeline,
2. generated/stored `app_summary_ja`,
3. `app_key_points_ja`,
4. `app_detail_ja`,
5. `verified_text`,
6. which field `buildNewsPresentation()` selects,
7. whether detail is shallow because:
   - producer generated shallow `app_detail_ja`,
   - the RPC omits richer source-backed fields,
   - presentation de-dup removes too much,
   - fallback prioritization selects the wrong source.

Do not guess. Document evidence in CODEX_REPORT.

## Goal D — improve detail quality at the correct layer

### If producer/app-copy generation is the problem
Create a **source candidate only** that changes the prompt/schema/logic so:
- `app_summary_ja` = short lead summary,
- `app_key_points_ja` = concise distinct facts,
- `app_detail_ja` = additional source-backed event detail/context, ideally 2–4 short paragraphs when source material supports it,
- market impact/relevance is kept separate from event detail,
- no unsupported facts or predictive claims.

Preserve Fact-check/grounding boundary.

### If presentation is the problem
Fix `buildNewsPresentation()` so:
- detail uses source-backed remaining content before generic relevance commentary,
- de-dup removes only actual duplicates and does not discard materially different facts,
- no-detail state uses explanatory copy, never a bare warning emoji/icon.

### If both are involved
Fix both as source candidate, but keep production deployment forbidden.

## Goal E — safe fallback for thin-source news

Some source items genuinely have little source text.

For those:
- show concise 要点,
- show `追加の詳細情報は元記事で確認できます` or equivalent,
- keep source link,
- do not invent filler,
- never show a bare `⚠️` as the entire 詳しい内容 section.

## Goal F — test quality with realistic fixtures

Add/adjust regression fixtures representing:
1. tanker strike / crew injuries / vessel status / no closure confirmed,
2. North Korea missile test / range / splashdown / official assessment,
3. UN/Houthi item with attempted strike + displacement context,
4. truly thin source with no extra details.

Assertions:
- key points and detail do not duplicate,
- detail contains additional event facts when fixture contains them,
- generic market-impact language is not substituted for available event detail,
- thin-source fallback is readable and non-empty,
- no unsupported new facts are added.

## Goal G — no visual polish creep

Do not spend this task redesigning:
- tab icons
- palette
- typography system
- badge colors
- animation

Record visual polish ideas separately in report only.

## Verification

Minimum:
- fresh `origin/main`
- no file overlap with active H2/G1/G2
- relevant app/news tests PASS
- app-scope TypeScript PASS
- Expo web export PASS
- `git diff --check` PASS
- source/readback proves holdings/watch separation and search preservation
- source/readback proves detail semantics above
- production mutation = 0

If important-news producer source is changed:
- run its relevant Deno/unit tests/type check,
- do not deploy it.

## Deliverables / C1

Update `.agent/CODEX_REPORT.md` with:
1. changed files
2. exact holdings/watch UX
3. evidence-based root cause for shallow news detail
4. exact data-path fields used before/after
5. whether fix is app-only or app + producer candidate
6. realistic fixture results
7. all verification results
8. production mutation = 0
9. explicit note: colors/icons visual polish deferred

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**


## Completion record — 2026-09-22

- final_commit: 0225efc66501502b32336998d4b48a71bdfece29
- pull_request: https://github.com/anohi-memories/kabumori/pull/7 (open; C1 review required)
- diagnosis: production read-only fields traced; app-only presentation layer selected. Producer/deploy/migration changes: none.
- verification: 50 relevant tests passed; app-scope TypeScript, Expo export, and diff check passed.
- production_mutation: 0
- visual_polish: deferred
- next_owner: chatgpt


## Final C1 review — 2026-09-22

**PASS — PR #7 candidate accepted.**

Accepted:
- `/explore` separates registered rows into `保有 | 監視` segments with counts.
- Default section behavior is correct: holdings preferred when present; watch shown when it is the only populated section; empty registered state is handled explicitly.
- Integrated stock search remains independent of the segment state.
- Register/edit/delete refreshes the registered rows so tracking-type changes move to the correct segment without restart.
- Important News verified-post presentation now partitions two concise event facts into 要点 and keeps remaining distinct event/status facts for 詳しい内容.
- Generic market-impact filler is excluded from 詳しい内容.
- Thin-source items remain fail-closed and are not padded with invented prose.
- No display-time AI call was added.
- Producer/app-copy generation and production backend were not changed.
- Relevant tests 50/50, app-scope TypeScript, Expo web export, and diff-check passed.
- Production mutation = 0.
- Main-side drift since branch base is control/report only; no Kabumori implementation overlap detected.

Known limitation / follow-up:
- This candidate improves only facts already present in the Fact-passed Japanese `verified_text`.
- Production read-only diagnosis showed richer English `body_summary` can exist while `app_*_ja` fields are NULL. Facts that never made it into `verified_text` still cannot appear as Japanese detail without a future producer/app-copy generation improvement.
- Therefore real-device QA should verify whether the three reported examples are now sufficiently detailed. If still too shallow, the next task should improve the producer/app-copy path rather than adding display-time translation/AI.

Colors/icons/visual polish remains deferred.

C1 judgment:
- Candidate is approved.
- Next H1 should freshen PR #7 onto current main, rerun checks, and merge if no conflict appears.

**Recommended model: Luna.**
