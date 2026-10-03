// The topic detail screen is React Native, so its contract is pinned by reading the source as text,
// like the rest of this suite: safety (deterministic fetch + exact id check) is unchanged, the new
// learning flow renders in the agreed order, and rendering adds no network/AI/database call.
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
    imports.sort(),
    [
      "from '@/components/back-button'",
      "from '@/constants/home-tokens'",
      "from '@/constants/kabumori-theme'",
      "from '@/lib/daily-topic'",
      "from '@/lib/home-topic'",
      "from '@/lib/topic-detail-catalog'",
      "from 'expo-router'",
      "from 'react'",
      "from 'react-native'",
      "from 'react-native-safe-area-context'",
    ].sort(),
  );
  assert.equal((screen.match(/fetchDailyTopic\(/g) ?? []).length, 1, "the one existing deterministic fetch only");
  assert.ok(!/fetch\(|supabase|XMLHttp|openai|anthropic|\.rpc\(/i.test(screen));
  const catalog = (await read("src/lib/topic-detail-catalog.ts")).replace(/\/\/.*$/gm, "");
  assert.ok(!/import |fetch\(|supabase|await |async /.test(catalog.replace(/^export type[^]*?\n\n/gm, "")), "the catalog is static data");
});

test("reading order: identity -> intro summary -> catalog sections in role order", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  const order = [
    "styles.eyebrow",
    "TOPIC_LEVEL_LABEL[topic.level]",
    "topic.category",
    "styles.title}>{topic.title}",
    "styles.introText}>{topic.body}",
    "detail.sections.map(",
  ];
  const positions = order.map((needle) => screen.indexOf(needle));
  for (const [index, position] of positions.entries()) assert.ok(position >= 0, `${order[index]} missing`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sections are out of order");
});

test("the intro is the Home summary (topic.body) in its own card, separate from the learning sections", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  const intro = screen.slice(screen.indexOf("styles.intro,"), screen.indexOf("{detail ? ("));
  assert.ok(intro.includes("{topic.body}"));
  assert.ok(!/topic\.body/.test(screen.slice(screen.indexOf("{detail ? ("))), "topic.body is not repeated below the intro");
});

test("the example is a visually identifiable card and the takeaway is a distinct calm block", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(screen.includes("section.role === 'example'") && screen.includes("styles.exampleCard"));
  assert.ok(screen.includes("section.role === 'takeaway'") && screen.includes("styles.takeaway"));
  assert.ok(/takeaway: \{ borderRadius: 14, borderLeftWidth: 4/.test(screen), "accent-bar block");
  assert.ok(/exampleCard: \{ borderRadius: 14, borderWidth: 1/.test(screen));
});

test("level accents are the Home topic tints (green / blue / lavender) and labels are unchanged", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(screen.includes("TOPIC_CARD.badge[topic.level]"));
  assert.ok(/beginner: '#eef7f0'/.test(screen) && /intermediate: '#edf5fc'/.test(screen) && /advanced: '#f2effc'/.test(screen));
  const { TOPIC_LEVEL_LABEL } = await import("../../src/lib/home-topic.ts");
  assert.deepEqual(TOPIC_LEVEL_LABEL, { beginner: "初心者向け", intermediate: "中級者向け", advanced: "上級者向け" });
});

test("an uncovered title falls back truthfully: intro summary plus 準備中, nothing invented", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(screen.includes("この用語の詳しい解説は準備中です。"));
  assert.ok(screen.includes("topicDetailFor(topic.title)"));
});

test("long titles and badges wrap instead of colliding or clipping", async () => {
  const screen = await read("src/app/topic-detail.tsx");
  assert.ok(/badgeRow: \{[^}]*flexWrap: 'wrap'/.test(screen), "level/category wrap on narrow widths");
  assert.ok(!/numberOfLines/.test(screen), "no truncation anywhere on the detail screen");
});

test("Home TOP behavior is untouched by this change", async () => {
  // The Home card keeps its short summary + CTA; this screen is the only consumer of the catalog.
  const card = await read("src/components/home/home-topic-feature.tsx");
  assert.ok(card.includes("{topic.body}") && card.includes("numberOfLines={2}"));
  assert.ok(!card.includes("topic-detail-catalog"), "the Home card does not use the detail catalog");
});
