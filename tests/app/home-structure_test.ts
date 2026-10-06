// Structure of the rebuilt Home (visual reference: the user's ideal Home mock). The screen is React
// Native, so its structure is pinned by reading the source as text, like the rest of this suite.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
// Source with line and JSX comments removed, for "must not contain" checks.
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("Home renders the sections in the reference order", async () => {
  const home = await read("src/app/(tabs)/index.tsx");
  const order = ["<HomeHeader", "<HomeReportHero", "<HomeMarketNewsGrid", "<HomeHoldingNewsList", "<HomeTopicFeature", "<HomeAskAiEntry"];
  const positions = order.map((tag) => home.indexOf(tag));
  for (const [index, position] of positions.entries()) assert.ok(position >= 0, `${order[index]} missing`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sections are out of order");
});

test("the old white-card Home components are gone", async () => {
  for (const name of ["report-highlight-card", "topic-card", "home-news-section", "ask-ai-entry"]) {
    await assert.rejects(Deno.stat(new URL(`src/components/home/${name}.tsx`, repoRoot)), `${name}.tsx should be deleted`);
  }
  const home = await code("src/app/(tabs)/index.tsx");
  assert.ok(!/\b(ReportHighlightCard|TopicCard|HomeNewsSection|AskAiEntry)\b/.test(home));
});

test("the huge greeting heading is gone: the header is compact", async () => {
  const home = await read("src/app/(tabs)/index.tsx");
  assert.ok(!/fontSize:\s*32/.test(home));
  assert.ok(!/eyebrow/.test(home), "no KABUMORI eyebrow + big title block");
  const header = await code("src/components/home/home-header.tsx");
  assert.ok(header.includes("router.push('/settings')"), "the existing settings entry stays");
  assert.ok(!/bell|通知/.test(header.replace(/アカウント・通知・規約・ログアウトの設定を開きます/, "")), "no fake notification control");
});

test("asset slots: header logo, Hero background and the three topic backgrounds are wired", async () => {
  const header = await read("src/components/home/home-header.tsx");
  assert.ok(/export const HEADER_LOGO_SOURCE: ImageSource = require\('@\/assets\/images\/home\/kabumori_header_logo\.webp'\);/.test(header));
  assert.ok(/HEADER_LOGO_SLOT = \{ width: 132, height: 34 \}/.test(header));
  assert.ok(header.includes('contentFit="contain"'), "logo is shown uncropped");
  const hero = await read("src/components/home/home-report-hero.tsx");
  assert.ok(/export const HERO_BACKGROUND_SOURCE: ImageSource = require\('@\/assets\/images\/home\/report_hero_background\.webp'\);/.test(hero));
  const topic = await read("src/components/home/home-topic-feature.tsx");
  for (const level of ["beginner", "intermediate", "advanced"]) {
    assert.ok(topic.includes(`${level}: require('@/assets/images/home/topic_background_${level}.webp'),`), level);
  }
  const names: string[] = [];
  for await (const entry of Deno.readDir(new URL("assets/images/home/", repoRoot))) names.push(entry.name);
  assert.deepEqual(
    names.sort(),
    ["kabumori_header_logo.webp", "report_hero_background.webp", "topic_background_advanced.webp", "topic_background_beginner.webp", "topic_background_intermediate.webp"],
    "only assets that exist may be required",
  );
});

test("the Hero draws none of the baked-in art text natively (no double display)", async () => {
  const hero = await code("src/components/home/home-report-hero.tsx");
  // The title, description and the 今日のポイント label are in the picture; only the VoiceOver label mentions them.
  const withoutLabel = hero.replace(/const HERO_ART_LABEL = '[^']*';/, "");
  for (const baked of ["かぶモリレポート", "今日の市場とあなたの保有銘柄への影響をAIが整理しました", "今日のポイント", ">今日の<"]) {
    assert.ok(!withoutLabel.includes(baked), `"${baked}" must not be drawn as native text`);
  }
  assert.ok(/HERO_ART_LABEL = '今日のかぶモリレポート。/.test(await read("src/components/home/home-report-hero.tsx")));
});

test("the Hero keeps only the live UI: report kind, numbered points and the CTA", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  assert.ok(hero.includes("REPORT_KIND_LABEL[report.report_type]") && hero.includes("morning: '朝刊', close: '大引け'"), "朝刊 / 大引け stays live and short");
  assert.ok(hero.includes("HOME_COLORS.point[index]") && hero.includes("{index + 1}"), "numbered circles stay native");
  assert.ok(hero.includes("レポートを見る →"));
});

test("the Hero shows 1-3 points: only real points, never an empty placeholder row", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  const tokens = await read("src/constants/home-tokens.ts");
  assert.ok(/maxPoints: 3/.test(tokens));
  assert.ok(/points\.filter\(\(point\) => point\.trim\(\)\.length > 0\)\.slice\(0, HERO\.maxPoints\)/.test(hero));
  assert.ok(/shownPoints\.map\(/.test(hero), "rows come only from the real points");
  assert.ok(!/Array\.from\(\{ length: HERO\.maxPoints/.test(hero) && !/\[0, 1, 2\]/.test(hero), "no fixed 3-row placeholder");
  assert.ok(/point: \['#e5484d', '#2f7fd8', '#f5a524'\]/.test(tokens), "red / blue / orange numbered circles");
  assert.ok(/numberOfLines=\{2\}/.test(hero), "each point is at most two lines");
});

test("layer order: background -> character -> points -> CTA, and only the CTA navigates", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  const bg = hero.indexOf("<Image\n          source={HERO_BACKGROUND_SOURCE}");
  const character = hero.indexOf("<CharacterSlot source=");
  const points = hero.indexOf("styles.pointsColumn");
  const cta = hero.indexOf("onPress={onOpen}");
  assert.ok(bg > 0 && bg < character && character < points && points < cta, "z-order is defined by render order");
  assert.equal((hero.match(/onPress=\{onOpen\}/g) ?? []).length, 1, "only the CTA opens the report");
  const pointRow = hero.slice(hero.indexOf("styles.pointRow"), hero.indexOf("styles.pointText"));
  assert.ok(!/Pressable/.test(pointRow), "point rows are not navigation targets");
  // The CTA is opaque (deep green) and rendered last, so it covers the character where they overlap.
  assert.ok(/backgroundColor: hasReport \? HOME_COLORS\.deepGreen : palette\.soft/.test(hero));
});

test("the Hero keeps its loading / error / empty branches and the CTA is disabled without a report", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  assert.ok(hero.includes("reportCardStatus(hasReport, loading, error)"));
  for (const branch of ["'loading'", "'error'", "'report'"]) assert.ok(hero.includes(`status === ${branch}`), branch);
  assert.ok(hero.includes("disabled={!hasReport}"));
});

test("the Hero is sized from the art's own aspect ratio, not fixed pixels", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  assert.ok(hero.includes("heroArtHeight(width)") && hero.includes("minHeight: artHeight"));
  assert.ok(hero.includes("aspectRatio: HERO_ART_ASPECT"));
  assert.ok(hero.includes("paddingTop: heroPointsTop(artHeight)"), "points start under the baked underline");
});

test("Home data orchestration is unchanged: same three fetches, refresh, JST rollover", async () => {
  const home = await read("src/app/(tabs)/index.tsx");
  for (const needle of [
    "fetchMyImportantStockNews()",
    "fetchRecentReports()",
    "fetchDailyTopic(level, today)",
    "RefreshControl",
    "setTodayJstValue(today)",
    "topicKeyMatches(topicKey, currentTopicKey)",
    "useFocusEffect",
  ]) {
    assert.ok(home.includes(needle), needle);
  }
});

test("the rebuilt sections keep their navigation targets", async () => {
  const market = await read("src/components/home/home-market-news-grid.tsx");
  const holding = await read("src/components/home/home-holding-news-list.tsx");
  const topic = await read("src/components/home/home-topic-feature.tsx");
  const ask = await read("src/components/home/home-ask-ai-entry.tsx");
  const header = await read("src/components/home/home-section-header.tsx");
  assert.ok(market.includes("pathname: '/news-detail'") && holding.includes("pathname: '/news-detail'"));
  assert.ok(header.includes("href = '/news'") && topic.includes('href="/topics"'));
  assert.ok(ask.includes("router.push('/ai')"));
  assert.ok(topic.includes("topicCardStatus(!!topic, loading, error)"));
});

test("Ask AI stays honest: no fake text box or question chips", async () => {
  const ask = await code("src/components/home/home-ask-ai-entry.tsx");
  assert.ok(ask.includes("準備中"));
  assert.ok(!/TextInput|QUESTION_CHIPS|chip/i.test(ask));
});

test("the news blocks use category tiles, never a fetched or invented image", async () => {
  for (const path of ["src/components/home/home-market-news-grid.tsx", "src/components/home/home-holding-news-list.tsx"]) {
    const text = await read(path);
    assert.ok(!/uri:|https?:\/\//.test(text), `${path} must not load remote images`);
    assert.ok(!/<Image\b/.test(text), `${path} uses tiles, not images`);
  }
});

test("all Home sections share the gutter/radius tokens", async () => {
  const tokens = await read("src/constants/home-tokens.ts");
  assert.ok(/gutter: 16/.test(tokens));
  const home = await read("src/app/(tabs)/index.tsx");
  assert.ok(home.includes("HOME_LAYOUT.gutter") && home.includes("HOME_LAYOUT.sectionGap"));
});
