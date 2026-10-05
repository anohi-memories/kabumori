// The topic detail screen is React Native, so its contract is pinned by reading the source as text,
// like the rest of this suite: safety (deterministic fetch + exact id check) is unchanged, the
// 「かぶモリ学習ノート」 layout renders in the agreed order, and rendering adds no network/AI/database call.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));
const code = async (path: string) => (await read(path)).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

test("the safe fetch contract is unchanged: exact (level, jstDate), id verified, fail-closed", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(screen.includes("useLocalSearchParams<{ id?: string; level?: string; jstDate?: string }>()"));
  assert.ok(screen.includes("if (!isTopicLevel(level) || !jstDate || !id) {"));
  assert.ok(screen.includes("fetchDailyTopic(level, jstDate)"));
  assert.ok(screen.includes("if (!result || result.id !== id) {"), "a different id is a mismatch");
  assert.ok(screen.includes("setStatus('mismatch')"));
  assert.ok(screen.includes(".catch(() => {") && screen.includes("setStatus('error')"));
  assert.ok(screen.includes("今日のトピックを取得できませんでした。もう一度お試しください。"));
  assert.ok(screen.includes("この内容は表示できません。Homeに戻ってもう一度開き直してください。"));
  assert.ok(screen.includes("edges={['top', 'bottom']}") && screen.includes("<BackButton />"), "safe area + back button kept");
});

test("rendering the learning content makes no network, AI or database call of its own", async () => {
  const screen = await code("src/app/topic-detail.tsx");
  const imports = screen.match(/from '[^']+'/g) ?? [];
  assert.deepEqual(
    [...new Set(imports)].sort(),
    [
      "from '@/components/back-button'",
      "from '@/constants/kabumori-theme'",
      "from '@/lib/daily-topic'",
      "from '@/lib/home-topic'",
      "from '@/lib/topic-detail-catalog'",
      "from '@/lib/topic-detail-presentation'",
      "from 'expo-image'",
      "from 'expo-router'",
      "from 'react'",
      "from 'react-native'",
      "from 'react-native-safe-area-context'",
    ].sort(),
  );
  assert.equal((screen.match(/fetchDailyTopic\(/g) ?? []).length, 1, "the one existing deterministic fetch only");
  assert.ok(!/fetch\(|supabase|XMLHttp|openai|anthropic|\.rpc\(/i.test(screen));
  const catalog = (await read("src/lib/topic-detail-catalog.ts")).replace(/\/\/.*$/gm, "");
  assert.ok(!/^import /m.test(catalog) && !/fetch\(|supabase|await |async /.test(catalog), "the catalog is static data");
});

test("new params reset the screen to loading, never showing the previous topic", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  const effect = screen.slice(screen.indexOf("useEffect(() => {"), screen.indexOf("fetchDailyTopic(level, jstDate)"));
  assert.ok(effect.includes("setTopic(null);\n    setStatus('loading');"));
});

test("reading order: back -> notebook label -> Hero (badge, category, title, summary) -> numbered steps -> example -> takeaway", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  const order = [
    "<BackButton />",
    'accessibilityLabel="かぶモリ学習ノート"',
    "styles.hero,",
    "TOPIC_LEVEL_LABEL[topic.level]",
    "{topic.category}",
    "styles.title}>{topic.title}",
    "styles.summary}>{topic.body}",
    "detail.sections.map(",
  ];
  const positions = order.map((needle) => screen.indexOf(needle));
  for (const [index, position] of positions.entries()) assert.ok(position >= 0, `${order[index]} missing`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sections are out of order");
  // The role blocks inside DetailSection: example and takeaway are special; steps are numbered.
  const section = screen.slice(screen.indexOf("function DetailSection"));
  assert.ok(section.indexOf("section.role === 'example'") < section.indexOf("section.role === 'takeaway'"));
  assert.ok(section.includes("topicDetailStepNumber(section.role)"));
});

test("the old generic TODAY'S TOPIC eyebrow is gone (a past topic no longer looks like today's)", async () => {
  const screen = await code("src/app/topic-detail.tsx");
  assert.ok(!/TODAY|eyebrow/i.test(screen));
  assert.ok((await read("src/app/topic-detail.tsx")).includes("かぶモリ学習ノート"));
});

test("the summary lives inside the Hero as the fetched topic.body, once, with no separate intro card", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.equal((screen.match(/topic\.body/g) ?? []).length, 1, "the summary is shown exactly once");
  assert.ok(!/styles\.intro|introText/.test(screen));
  const hero = screen.slice(screen.indexOf("styles.hero,"), screen.indexOf("{detail ? ("));
  assert.ok(hero.includes("{topic.body}") && hero.includes("{topic.title}") && hero.includes("{topic.category}"));
});

test("Hero art: the existing canonical level artwork, level-only mapping, never stretched or regenerated", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  for (const level of ["beginner", "intermediate", "advanced"]) {
    assert.ok(screen.includes(`${level}: require('@/assets/images/home/topic_background_${level}.webp'),`), level);
  }
  assert.ok(screen.includes("HERO_ART[topic.level]"), "chosen from topic.level only");
  assert.ok(screen.includes('contentFit="cover"') && !/contentFit="fill"/.test(screen));
  assert.ok(screen.includes("heroWidth / TOPIC_DETAIL_ART_ASPECT"), "the art keeps its own aspect ratio");
  assert.ok(screen.includes("pointerEvents=\"none\""), "decoration never takes touches");
  assert.ok(screen.includes("accessible={false}"), "the art is hidden from the accessibility tree");
  // No new image files for the detail screen: the canonical topic backgrounds are reused untouched.
  const names: string[] = [];
  for await (const entry of Deno.readDir(new URL("assets/images/home/", repoRoot))) names.push(entry.name);
  assert.deepEqual(
    names.sort(),
    ["kabumori_header_logo.webp", "report_hero_background.webp", "topic_background_advanced.webp", "topic_background_beginner.webp", "topic_background_intermediate.webp"],
  );
});

test("the art wash is built from non-overlapping strips (no banding) and keeps the right side clear", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(/WASH_STRIPS = 20;/.test(screen) && /WASH_CLEAR_FROM = 12;/.test(screen), "the right 40% has no wash");
  assert.ok(/flex: 1,\s*backgroundColor: colors\.hero,/.test(screen), "equal flex strips cannot overlap");
  assert.ok(/bottom: \(FADE_STRIPS - 1 - index\) \* FADE_STRIP_HEIGHT/.test(screen), "2pt non-overlapping bottom fade strips");
});

test("example is a tinted outlined card with a bulb; the takeaway is a calm accent-line block; steps are numbered circles", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(/exampleCard: \{ borderRadius: 18, borderWidth: 1/.test(screen));
  assert.ok(screen.includes("styles.bulb") && screen.includes("💡"));
  assert.ok(/takeaway: \{ borderRadius: 18, borderLeftWidth: 5/.test(screen));
  assert.ok(/stepCircle: \{ width: 38, height: 38, borderRadius: 19/.test(screen));
  assert.ok(!/stepCard|section: \{[^}]*borderWidth/.test(screen), "ordinary steps are not cards");
});

test("an uncovered title falls back truthfully: the Hero summary plus 準備中, nothing invented", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(screen.includes("この用語の詳しい解説は準備中です。"));
  assert.ok(screen.includes("topicDetailFor(topic.title)"));
});

test("long titles and badges wrap instead of colliding or clipping", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(/badgeRow: \{[^}]*flexWrap: 'wrap'/.test(screen), "level/category wrap on narrow widths");
  assert.ok(!/numberOfLines/.test(screen), "no truncation anywhere on the detail screen");
});

test("body copy is 15-16pt with a comfortable line height", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(/body: \{ color: INK, fontSize: 15\.5, lineHeight: 26 \}/.test(screen));
  assert.ok(/summary: \{[^}]*fontSize: 15\.5, lineHeight: 25/.test(screen));
});

test("Home TOP behavior is untouched by this change", async () => {
  const card = await read("src/components/home/home-topic-feature.tsx");
  assert.ok(card.includes("{topic.body}") && card.includes("numberOfLines={2}"));
  assert.ok(!card.includes("topic-detail-catalog") && !card.includes("topic-detail-presentation"), "the Home card does not use the detail modules");
});
