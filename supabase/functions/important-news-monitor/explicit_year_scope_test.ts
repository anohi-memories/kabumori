// MISSING_EXPLICIT_YEAR scope (2026-10-03). The local check required every year of the body within a
// year of publication, so reference years (prior-year columns, earlier resolution dates, warrant exercise
// periods) failed posts that stated everything the news was about: 90 of 213 generation failures in 30
// days, and no rewrite could fix them. Required years are now the headline and judgement-reason years,
// the year of a labelled event date, and (earnings disclosures only) the first fiscal period when the
// headline and reason carry no year. The fixtures below are the seven real failures, with the original
// headline, reason, generated post and the body text around the flagged years.
import assert from "node:assert/strict";
import test from "node:test";
import {
  explicitYears,
  generateImportantNewsPost,
  type GenerationCandidate,
  type GenerationRunner,
  type GenerationStep,
  localFactIssues,
} from "./post_generation_logic.ts";

const candidate = (overrides: Partial<GenerationCandidate> = {}): GenerationCandidate => ({
  id: "candidate-1",
  sourceType: "tdnet",
  sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
  sourceName: "tdnet",
  title: "通期業績予想の上方修正について",
  bodySummary: "営業利益予想を上方修正",
  companyName: "テスト株式会社",
  companyCode: "1234",
  entityKey: "company:1234",
  category: "earnings_revision_up",
  publishedAt: "2026-08-31T06:00:00.000Z",
  importance: "important",
  affectedEntities: ["テスト株式会社", "1234"],
  japanMarketRelevance: "medium",
  judgementReason: "業績予想の修正で株価材料になりうるため",
  judgementFactStatus: "passed",
  status: "ready_for_generation",
  ...overrides,
});

function scriptedRunner(script: Array<{ step: GenerationStep; payload: unknown }>): { runner: GenerationRunner; calls: GenerationStep[] } {
  const calls: GenerationStep[] = [];
  let index = 0;
  const runner: GenerationRunner = (step) => {
    calls.push(step);
    const entry = script[index];
    if (!entry || entry.step !== step) return Promise.reject(new Error(`UNEXPECTED_STEP_CALL:${step}`));
    index += 1;
    return Promise.resolve({ payload: entry.payload, model: "gpt-6-luna", inputTokens: 100, outputTokens: 50, estimatedCost: 0.00008 });
  };
  return { runner, calls };
}

const REAL_FAILURES: Array<Record<string, string>> = [
  {
    "name": "tdnet （変更）「Kamgras １株式会社による当社株券等に対",
    "sourceType": "tdnet",
    "sourceName": "tdnet",
    "category": "tob",
    "importance": "important",
    "publishedAt": "2026-09-29 23:30:00+00",
    "title": "（変更）「Kamgras １株式会社による当社株券等に対する公開買付けに関する賛同の意見表明及び応募推奨のお知らせ」の一部変更に関するお知らせ",
    "judgementReason": "競合提案がある非公開化TOBで、買付価格を3,680円から3,681円に変更し、期間を10月14日まで延長。価格上昇は1円にとどまり、最重要とするほどの変更は確認できない。",
    "bodySummary": "（TEL 03-5725-4554）\n（変更）「Kamgras １株式会社による当社株券等に対する公開買付けに関する賛同の意見表明\n及び応募推奨のお知らせ」の一部変更に関するお知らせ\n当社が 2026 年５月 12 日付で公表いたしました「Kamgras １株式会社による当社株券 … ます。）（行使期間は 2023 年８\n月７日から 2053 年８月６日まで）１個につき、金１円\n⑩ 2025 年５月 21 日開催の当社取締役会の決議に基づいて発行された新\n株予約権（「第 … ）（行使期間は 2029 年６\n月１日から 2033 年９月 30 日まで）１個につき、金１円\n⑪ 2025 年６月 18 日開催の当社取締役会の決議に基づいて発行された新\n株予約権（「第 … 締役会の決議に基づいて発行された新\n株予約権（「第 20 回新株予約権」といいます。）（行使期間は 2027 年\n3\n＜後略＞\n（変更後）\n公 開 買 付 け の 目 的 非公開化\n買 付 … ます。）（行使期間は 2023 年８\n月７日から 2053 年８月６日まで）１個につき、金１円\n⑩ 2025 年５月 21 日開催の当社取締役会の決議に基づいて発行された新\n株予約権（「第 … ）（行使期間は 2029 年６\n月１日から 2033 年９月 30 日まで）１個につき、金１円\n⑪ 2025 年６月 18 日開催の当社取締役会の決議に基づいて発行された新\n株予約権（「第",
    "sourceUrl": "https://www.release.tdnet.info/inbs/140120260929542370.pdf",
    "text": "【速報】カカクコムの公開買付けで、Kamgras 1は買付価格を1株3,680円から3,681円に変更しました。公開買付期間も2026年10月14日まで延長し、合計105営業日となります。\n\nベインキャピタルとLINEヤフー側の対抗提案もあり、カカクコムの特別委員会は両提案を検討する方針です。取締役会の賛同意見に変更はありません。\n\n出典: https://www.release.tdnet.info/inbs/140120260929542370.pdf"
  },
  {
    "name": "tdnet 非金融資産の減損損失、契約損失引当金、仕入先からの求償請",
    "sourceType": "tdnet",
    "sourceName": "tdnet",
    "category": "earnings",
    "importance": "most_important",
    "publishedAt": "2026-09-30 07:30:00+00",
    "title": "非金融資産の減損損失、契約損失引当金、仕入先からの求償請求に係る和解に伴う債務及び特別調査費用等の計上に関するお知らせ",
    "judgementReason": "非金融資産の減損損失を合計632,135百万円計上し、契約損失引当金等も2026年3月期決算に反映。損失規模が具体的に示されている。",
    "bodySummary": "各 位\n非金融資産の減損損失、契約損失引当金、仕入先からの求償請求に係る和解に伴う債\n務及び特別調査費用等の計上に関するお知らせ\n当社は、2025 年 11 月 14 日付「契約損失引当金及び非金融資産の減損損失並びに仕入先からの求\n償請求の和解に伴う債務の計上に関するお知らせ」 … 引当金、仕入先からの求償請求に係る和解に伴う債\n務及び特別調査費用等の計上に関するお知らせ\n当社は、2025 年 11 月 14 日付「契約損失引当金及び非金融資産の減損損失並びに仕入先か",
    "sourceUrl": "https://www.release.tdnet.info/inbs/140120260930543399.pdf",
    "text": "【重大速報】ニデックは2026年3月期に、非金融資産の減損損失632,135百万円を計上。車載用製品の契約損失引当金22,496百万円と、仕入先からの求償請求の和解に伴う債務4,207百万円も計上し、一連の事案の調査・決算見直しにかかった特別調査費用等も追加しました。\n\nこれらは2026年9月30日公表の2026年3月期決算短信と有価証券報告書に反映されています。\n\n出典: https://www.release.tdnet.info/inbs/140120260930543399.pdf"
  },
  {
    "name": "al_jazeera South Korea’s exports hit re",
    "sourceType": "breaking_market",
    "sourceName": "al_jazeera",
    "category": "semiconductor_ai",
    "importance": "important",
    "publishedAt": "2026-10-01 04:08:15+00",
    "title": "South Korea’s exports hit record high on AI boom",
    "judgementReason": "韓国の9月輸出と半導体出荷が過去最高水準との報道。AI向け需要の強さを示すが、日本企業への具体的な影響は確認できない。",
    "bodySummary": "[単一ソース: Al Jazeera 記事（RSS見出し・本文要約）] Exports jump 83.5 percent to top $120bn for the first time amid ferocious semiconductor demand. 本文冒頭: So … eptember hit $814.5bn, exceeding those for all of 2025, when exports reached a record $709.7bn",
    "sourceUrl": "https://www.aljazeera.com/economy/2026/10/1/south-koreas-exports-hit-record-high-on-ai-boom",
    "text": "【速報】韓国の2026年9月輸出、過去最高の1,209億ドルに\n前年同月比83.5％増で、初めて1,200億ドルを超えました。半導体の輸出は603億ドルと、前年同月比で260％超の増加。月間輸出額の過去最高を更新したと、韓国の暫定通関統計をもとに報じられています。\n\n出典: https://www.aljazeera.com/economy/2026/10/1/south-koreas-exports-hit-record-high-on-ai-boom"
  },
  {
    "name": "tdnet 東京証券取引所 TOKYO PRO Marketへの上場",
    "sourceType": "tdnet",
    "sourceName": "tdnet",
    "category": "earnings",
    "importance": "important",
    "publishedAt": "2026-10-01 23:00:00+00",
    "title": "東京証券取引所 TOKYO PRO Marketへの上場に伴う当社決算情報等のお知らせ",
    "judgementReason": "上場に伴う決算情報の開示。2027年2月期は売上高22.5％減、営業・経常・純損失を予想するが、新規物件の引渡しがない年度による見通しで、既発表業績予想の修正とは確認できない。",
    "bodySummary": "各 位\n会 社 名 ハイネスコーポレーション株式会社\n（コード番号 638A TOKYO PRO Market）\n援ご鞭撻を賜りますよう、よろしくお願い申し上げます。\nなお、2027 年 2 月期（2026 年３月１日から 2027 年２月 28 日まで）における当社の業績予想は … －\n発行者情報提出日 2026月８月28日\n(百万円未満切捨て)\n１． 2026年２月期の連結業績（2025年３月１日～2026年２月28日）\n（１）連結経営成績 (％表示は対前期増減率) … 業利益 経常利益 親会社株主に帰属する\n当期純利益\n百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％\n2025年２月期 1,493 － △342 － △78 － 19 －\n(注) 包括利益  … － △342 － △78 － 19 －\n(注) 包括利益 2026年２月期 209百万円( －％) 2025年２月期 △8百万円( －％)\n１株当たり\n当期純利益\n潜在株式調整後\n１株当た … 純利益\n自己資本\n当期純利益率\n総資産\n経常利益率\n売上高\n営業利益率\n円 銭 円 銭 ％ ％ ％\n2025年２月期 △1,498 △65 2,044 2,491\n２．配当の状況\n年間配当 … 株式数（普通株式）\n① 期末発行済株式数（自己株式を含む） 2026年２月期 1,320,000株 2025年２月期 1,320,000株\n② 期末自己株式数 2026年２月期 －株 20",
    "sourceUrl": "https://www.release.tdnet.info/inbs/140120260925540089.pdf",
    "text": "【速報】ハイネスコーポレーションがTOKYO PRO Marketへの上場に伴い、2026年2月期決算と2027年2月期の業績予想を開示しました。\n\n2027年2月期は、新規物件の竣工・引き渡し予定がなく、売上高は前期比22.5％減の38億1,000万円を予想。営業損失1億300万円、経常損失6,000万円、純損失1億600万円の見通しです。前期は営業・経常・純利益がいずれも黒字でした。📊\n\n出典: https://www.release.tdnet.info/inbs/140120260925540089.pdf"
  },
  {
    "name": "tdnet 「中長期成長戦略2026」",
    "sourceType": "tdnet",
    "sourceName": "tdnet",
    "category": "other_corporate_ir",
    "importance": "important",
    "publishedAt": "2026-10-02 01:00:00+00",
    "title": "「中長期成長戦略2026」",
    "judgementReason": "2030年度の売上高目標を4,150億円から4,440億円、営業利益目標を540億円から568億円へ引き上げた。長期目標の更新であり、直近業績への影響は確認できない。",
    "bodySummary": "各 位\n会社名 ロート製薬株式会社\n代表者名 代表取締役社長 瀬木英俊\n長戦略のもと、持続的な成長を実現するための定量目標を設定しております。このたび、従\n来の 2030 年財務予測に対し、ローリングの考え方に基づき対象期間を 2026 年～2031 年へ更\n新し、2031 年度 … 10％以上を確保し、「健\n全な財務体質」「成長投資」「株主還元向上」の同時実現を目指しております。\n2025 年度 2028 年度 2031 年度\n売上高 3,437 億円 4,050 億",
    "sourceUrl": "https://www.release.tdnet.info/inbs/140120261002544998.pdf",
    "text": "【速報】ロート製薬（4527）が「中長期成長戦略2026」を公表。2030年度の売上高目標を4,150億円から4,440億円、営業利益目標を540億円から568億円に引き上げました。2031年度は売上高4,640億円、営業利益598億円、配当性向40％、DOE4.0％以上を目標に掲げています。長期目標の更新で、直近業績への影響は確認できません。\n\n出典: https://www.release.tdnet.info/inbs/140120261002544998.pdf\n\n出典: https://www.release.tdnet.info/inbs/140120261002544998.pdf"
  },
  {
    "name": "tdnet 経営戦略説明会資料",
    "sourceType": "tdnet",
    "sourceName": "tdnet",
    "category": "other_corporate_ir",
    "importance": "important",
    "publishedAt": "2026-10-02 01:00:00+00",
    "title": "経営戦略説明会資料",
    "judgementReason": "中長期成長計画を更新し、2031年度の売上高4,640億円・営業利益598億円を掲げた。配当性向40％への見通しも示しているが、説明会資料の範囲で、直近の業績修正や大幅な配当変更ではない。",
    "bodySummary": "9 各事業の成長性・市場性に合わせて、 知財ポートフォリオの最適化を図り、企業価値の向上へ 企業価値を高める経営基盤：知財・開発力\n日本の主要参入カテゴリーでのロートのポジション 2024 年度 点眼薬 ( アイケア事業 ) 2025 年度数量シェア １ 位 皮膚用薬 ( スキン … 発力\n日本の主要参入カテゴリーでのロートのポジション 2024 年度 点眼薬 ( アイケア事業 ) 2025 年度数量シェア １ 位 皮膚用薬 ( スキンケア事業 ) 胃腸薬 ( 内服・食 … ( スキンケア事業 ) 日やけ止め ( スキンケア事業 ) リップクリーム ( スキンケア事業 ) 2025 年度数量シェア ２ 位 2025 年度数量シェア ３ 位 2025 年度数量シ …  ( スキンケア事業 ) リップクリーム ( スキンケア事業 ) 2025 年度数量シェア ２ 位 2025 年度数量シェア ３ 位 2025 年度数量シェア １ 位 2025 年度数量シ … リーム ( スキンケア事業 ) 2025 年度数量シェア ２ 位 2025 年度数量シェア ３ 位 2025 年度数量シェア １ 位 2025 年度数量シェア ２ 位 2025 年度数量シ … 025 年度数量シェア ２ 位 2025 年度数量シェア ３ 位 2025 年度数量シェア １ 位 2025 年度数量シェア ２ 位 2025 年度数量シェア １ 位 参照元：インテージ ",
    "sourceUrl": "https://www.release.tdnet.info/inbs/140120261002545003.pdf",
    "text": "【速報】ロート製薬、2031年度の売上高4,640億円を計画\n\n中長期成長計画を更新し、2031年度の営業利益は598億円、配当性向は40％の見通しを示しました。2027年度の売上高・営業利益予想も、従来計画の3,650億円・460億円から3,900億円・487億円へ引き上げています。\n\n出典: https://www.release.tdnet.info/inbs/140120261002545003.pdf"
  },
  {
    "name": "tdnet 自己株式の取得結果および取得終了に関するお知らせ",
    "sourceType": "tdnet",
    "sourceName": "tdnet",
    "category": "share_buyback",
    "importance": "important",
    "publishedAt": "2026-10-02 06:30:00+00",
    "title": "自己株式の取得結果および取得終了に関するお知らせ",
    "judgementReason": "取得上限350億円の自己株式取得を完了し、累計425万800株・約350億円を取得したと公表。規模の大きい還元策の実績だが、新たな取得決定ではない。",
    "bodySummary": "（TEL 03-6743-5007)\n自己株式の取得結果および取得終了に関するお知らせ\n（会社法第 165 条第 2 項の規定による定款の定めに基づく自己株式の取得）\n当社は、2026 年 5 月 14 日開催の取締役会において決議しました、会社法第 165 条第 3 項の規定に … 取得価額の総額 ： 350 億円（上限）\n（４）取 得 期 間 ： 2026 年 5 月 15 日～2027 年 3 月 31 日\n（５）取 得 方 法 ： 東京証券取引所における市場買付",
    "sourceUrl": "https://www.release.tdnet.info/inbs/140120260915536792.pdf",
    "text": "【速報】栗田工、自己株取得を終了\n\n2026年5月の取締役会決議に基づく自己株式の取得が終了しました。2026年10月1日までの累計は425万800株、取得額は約350億円で、取得上限の350億円に達しています。\n\n出典: https://www.release.tdnet.info/inbs/140120260915536792.pdf"
  }
];

const candidateOf = (fixture: Record<string, string>): GenerationCandidate => ({
  id: "replay",
  sourceType: fixture.sourceType,
  sourceUrl: fixture.sourceUrl,
  sourceName: fixture.sourceName,
  title: fixture.title,
  bodySummary: fixture.bodySummary,
  companyName: null,
  companyCode: null,
  entityKey: null,
  category: fixture.category as GenerationCandidate["category"],
  publishedAt: new Date(fixture.publishedAt).toISOString(),
  importance: fixture.importance as GenerationCandidate["importance"],
  affectedEntities: [],
  japanMarketRelevance: "low",
  judgementReason: fixture.judgementReason,
  judgementFactStatus: "passed",
  status: "ready_for_generation",
});

/** The rule before 2026-10-03: the headline/reason years plus every body year within a year of publication. */
function legacyRequiredYears(c: GenerationCandidate): string[] {
  const head = [c.title, c.judgementReason].filter((v): v is string => !!v && v.trim().length > 0).join("\n");
  const headlineYears = head.match(/(?:19|20)\d{2}/gu) ?? [];
  const published = Number(c.publishedAt.slice(0, 4));
  const bodyYears = (c.bodySummary ?? "").match(/(?:19|20)\d{2}/gu) ?? [];
  return [...new Set([...headlineYears, ...bodyYears.filter((year) => Math.abs(Number(year) - published) <= 1)])];
}

for (const fixture of REAL_FAILURES) {
  test(`replay: ${fixture.name} — the old rule failed it on a reference year, the new rule does not`, () => {
    const target = candidateOf(fixture);
    const legacyMissing = legacyRequiredYears(target).filter((year) => !fixture.text.includes(year));
    assert.ok(legacyMissing.length > 0, "the old rule required a year the post does not state");
    assert.ok(!localFactIssues(target, fixture.text).includes("MISSING_EXPLICIT_YEAR"), `required now: ${explicitYears(target)}`);
    for (const year of explicitYears(target)) assert.ok(fixture.text.includes(year), `${year} is stated`);
    for (const year of explicitYears(target)) assert.ok(legacyRequiredYears(target).includes(year), "never stricter than before");
  });
}

test("replay: a year the headline or reason requires still fails when removed from the post", () => {
  const byName = (name: string) => REAL_FAILURES.find((fixture) => fixture.name.includes(name))!;
  // Hainess: the reason names 2027年2月期; Rohto: the title/reason name 2026 and 2030, resp. 2031.
  for (const [name, year] of [["TOKYO PRO Market", "2027"], ["中長期成長戦略2026", "2030"], ["経営戦略説明会資料", "2031"]] as const) {
    const fixture = byName(name);
    const target = candidateOf(fixture);
    assert.ok(explicitYears(target).includes(year), `${name} requires ${year}`);
    assert.ok(!fixture.sourceUrl.includes(year), "the source URL cannot supply the year");
    assert.ok(localFactIssues(target, fixture.text.replaceAll(year, "")).includes("MISSING_EXPLICIT_YEAR"), `${name} without ${year}`);
  }
});

test("a year-less headline and body event-dates: only labelled event dates keep their year", () => {
  const base = { title: "重要な市場発表", judgementReason: null as string | null };
  const labelled = candidate({ ...base, bodySummary: "発表日 2026-09-09、適用日 2027-03-31。2025年の実績を前年同期比較。取締役会は2025年5月21日に決議。" });
  assert.deepEqual(explicitYears(labelled).sort(), ["2026", "2027"]);
  const spaced = candidate({ ...base, bodySummary: "発 表 日 2026 年 9 月 9 日 / 適 用 日 : 2027 年 3 月 31 日" });
  assert.deepEqual(explicitYears(spaced).sort(), ["2026", "2027"]);
  const source = `\n\n出典: ${labelled.sourceUrl}`;
  assert.deepEqual(localFactIssues(labelled, `【速報】発表は2026年9月9日、適用は2027年3月31日です。${source}`), []);
  assert.ok(localFactIssues(labelled, `【速報】発表は9月9日、適用は2027年3月31日です。${source}`).includes("MISSING_EXPLICIT_YEAR"));
  assert.ok(localFactIssues(labelled, `【速報】発表は2026年9月9日、適用は3月31日です。${source}`).includes("MISSING_EXPLICIT_YEAR"));
});

test("reference years are not required: comparison, earlier resolution date, exercise period, history", () => {
  const target = candidate({
    title: "重要な市場発表",
    judgementReason: null,
    category: "tob",
    bodySummary: "2025年5月21日開催の取締役会の決議に基づく。行使期間は2027年3月から。2025年2月期は赤字。前年(2025年)比で増加。1930年関税法。",
  });
  assert.deepEqual(explicitYears(target), []);
  assert.deepEqual(localFactIssues(target, `【速報】内容です。\n\n出典: ${target.sourceUrl}`), []);
});

test("earnings disclosures without a headline year keep their first fiscal period; other categories do not", () => {
  const body = "業績予想の修正について。2027年2月期第2四半期(累計)連結業績予想数値の修正。前期2026年2月期実績。";
  const earnings = candidate({ title: "業績予想の修正に関するお知らせ", judgementReason: null, category: "earnings_revision_up", bodySummary: body });
  assert.deepEqual(explicitYears(earnings), ["2027"]);
  const source = `\n\n出典: ${earnings.sourceUrl}`;
  assert.ok(localFactIssues(earnings, `【速報】第2四半期累計の業績予想を上方修正しました。${source}`).includes("MISSING_EXPLICIT_YEAR"));
  assert.deepEqual(localFactIssues(earnings, `【速報】2027年2月期第2四半期累計の業績予想を上方修正しました。${source}`), []);
  const tob = candidate({ title: "公開買付けの開始に関するお知らせ", judgementReason: null, category: "tob", bodySummary: "所有割合は2026年7月31日公表の「2027年3月期第1四半期決算短信」に記載。" });
  assert.deepEqual(explicitYears(tob), []);
});

test("the required set never exceeds the old rule's (ASCII years near publication)", () => {
  for (const bodySummary of [
    "発表日 ２０２６年９月９日、適用日 2027-03-31、2030年度目標、2024年実績",
    "効力発生日 2028年4月1日。2027年2月期第2四半期。",
    null,
  ]) {
    for (const category of ["earnings", "tob", "ma"] as const) {
      const target = candidate({ title: "お知らせ", judgementReason: "理由", category, bodySummary, publishedAt: "2026-09-30T00:00:00.000Z" });
      const old = new Set(legacyRequiredYears(target));
      for (const year of explicitYears(target)) assert.ok(old.has(year), `${category} ${year}`);
    }
  }
});

test("a post with only reference years missing is not retried; a missing headline year still is", async () => {
  const peripheral = candidate({
    title: "自己株式の取得結果に関するお知らせ",
    judgementReason: "取得上限350億円の自己株式取得を完了",
    bodySummary: "取得期間: 2026年5月15日~2027年3月31日。累計425万株。",
    publishedAt: "2026-10-02T00:00:00.000Z",
  });
  const ok = scriptedRunner([
    { step: "draft", payload: { text: "自己株式の取得を終了しました。累計は425万株です。", sufficient_information: true, notes: [] } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: true, issues: [] } },
  ]);
  const passed = await generateImportantNewsPost(peripheral, ok.runner);
  assert.deepEqual(ok.calls, ["draft", "fact", "voice"], "no wasted fact_retry");
  assert.equal(passed.status, "ready_for_publish");

  const needed = candidate({ title: "2027年1月期第2四半期決算短信", bodySummary: "決算短信", publishedAt: "2026-09-11T00:00:00.000Z" });
  const retried = scriptedRunner([
    { step: "draft", payload: { text: "第2四半期の決算を発表しました。", sufficient_information: true, notes: [] } },
    { step: "fact_retry", payload: { text: "2027年1月期第2四半期の決算を発表しました。" } },
    { step: "fact", payload: { passed: true, issues: [] } },
    { step: "voice", payload: { passed: true, issues: [] } },
  ]);
  const result = await generateImportantNewsPost(needed, retried.runner);
  assert.deepEqual(retried.calls, ["draft", "fact_retry", "fact", "voice"]);
  assert.equal(result.status, "ready_for_publish");
});
