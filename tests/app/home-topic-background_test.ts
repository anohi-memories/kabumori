// The Home 「今日のトピック」 three-level background series. The approved clean originals
// (Desktop/ゆめちゃん素材/topic_background_{beginner,intermediate,advanced}.png, each RGB 1942x809, no
// screenshot chrome: border strips are light, no editor UI) were converted losslessly
// (cwebp -lossless -exact) and verified pixel-identical: no resize / crop / recolour / retouch.
// RN-only components are checked as text, like the rest of this suite.
import assert from "node:assert/strict";
import test from "node:test";

import { TOPIC_LEVELS, TOPIC_LEVEL_LABEL, type TopicLevel } from "../../src/lib/home-topic.ts";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));

const BACKGROUNDS: ReadonlyArray<readonly [TopicLevel, string]> = [
  ["beginner", "9f7c50c743ebf79b0351ccc512a350bebebfec7705f7ba049a21444995b353c5"],
  ["intermediate", "d62958feecaff9ad5823608ed79b12010381a13ec14df6e192f6c42950539a0d"],
  ["advanced", "d9b32157e2c1cfdef294d2956463a1759b34c88acd8e26a4961115081d1fa3ee"],
];

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

for (const [level, sha] of BACKGROUNDS) {
  test(`topic_background_${level}.webp is the approved lossless WebP, 1942x809`, async () => {
    const bytes = await Deno.readFile(new URL(`assets/images/home/topic_background_${level}.webp`, repoRoot));
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
    assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
    assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), "VP8L", "must stay lossless");
    assert.equal(bytes[20], 0x2f);
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    assert.equal((bits & 0x3fff) + 1, 1942);
    assert.equal(((bits >>> 14) & 0x3fff) + 1, 809);
    assert.equal(await sha256Hex(bytes), sha, "must be the approved file, byte for byte");
  });
}

test("exactly three topic backgrounds exist, one per TopicLevel", async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(new URL("assets/images/home/", repoRoot))) {
    if (entry.name.startsWith("topic_background")) names.push(entry.name);
  }
  assert.deepEqual(
    names.sort(),
    TOPIC_LEVELS.map((level) => `topic_background_${level}.webp`).sort(),
  );
  assert.deepEqual(BACKGROUNDS.map(([level]) => level).sort(), [...TOPIC_LEVELS].sort(), "the pinned set covers every level once");
});

test("level -> background mapping is exact and covers every TopicLevel exactly once", async () => {
  const card = await read("src/components/home/home-topic-feature.tsx");
  const mapping = card.slice(card.indexOf("TOPIC_BACKGROUND_SOURCES: Record<TopicLevel, ImageSource> = {"), card.indexOf("};", card.indexOf("TOPIC_BACKGROUND_SOURCES: Record")));
  for (const level of TOPIC_LEVELS) {
    const matches = mapping.match(new RegExp(`${level}: require\\('@/assets/images/home/topic_background_${level}\\.webp'\\)`, "g")) ?? [];
    assert.equal(matches.length, 1, `${level} -> its own file, once`);
  }
  assert.equal((mapping.match(/require\(/g) ?? []).length, TOPIC_LEVELS.length);
  // The loaded card draws the background of topic.level and nothing else.
  assert.ok(card.includes("source={TOPIC_BACKGROUND_SOURCES[topic.level]}"));
});

test("the background is chosen from topic.level only: no heuristics, dates or randomness, no network/AI", async () => {
  const card = (await read("src/components/home/home-topic-feature.tsx")).replace(/\/\/.*$/gm, "");
  assert.ok(!/Math\.random|new Date|Date\.now|fetch\(|supabase|\.title\.(?:includes|match|test)|\.body\.(?:includes|match|test)|toLowerCase/.test(card));
  const imports = card.match(/from '[^']+'/g) ?? [];
  assert.ok(!imports.some((i) => /supabase|daily-topic|fetch/.test(i)), "no data-layer import");
});

test("loading / error / empty stay truthful and show no level background", async () => {
  const card = await read("src/components/home/home-topic-feature.tsx");
  assert.ok(card.includes("topicCardStatus(!!topic, loading, error)"));
  assert.ok(card.includes("読み込み中です…"));
  assert.ok(card.includes("今日のトピックは準備中です。"));
  assert.ok(card.includes("もう一度試す"));
  // The background Image only exists inside the loaded branch, so no level is invented without a topic.
  const before = card.slice(0, card.indexOf("loaded && topic ? ("));
  assert.ok(!/<Image/.test(before.slice(before.indexOf("export function HomeTopicFeature"))), "no Image before the loaded branch");
  assert.ok(card.includes("cardPlain"), "the plain neutral card is used when nothing is loaded");
});

test("the card keeps the art's own aspect ratio: no stretching, one cover fill", async () => {
  const tokens = await read("src/constants/home-tokens.ts");
  assert.ok(/artWidth: 1942,/.test(tokens) && /artHeight: 809,/.test(tokens));
  assert.ok(/aspectRatio: 1942 \/ 809,/.test(tokens));
  const card = await read("src/components/home/home-topic-feature.tsx");
  assert.ok(/cardLoaded: \{ aspectRatio: TOPIC_CARD\.aspectRatio \}/.test(card), "the loaded card has the art's ratio for every level");
  assert.ok(card.includes('contentFit="cover"') && !/contentFit="fill"/.test(card), "cover on a same-ratio box is an exact fit");
  assert.ok(card.includes("StyleSheet.absoluteFill"));
});

test("native text and CTA: left quiet area, 2+2 lines, CTA bottom-right, whole card is the one navigation", async () => {
  const tokens = await read("src/constants/home-tokens.ts");
  const width = Number(/textWidth: '(\d+)%'/.exec(tokens)?.[1]);
  assert.ok(width >= 50 && width <= 60, `${width}% should stay within the quiet left area`);
  const card = await read("src/components/home/home-topic-feature.tsx");
  assert.equal((card.match(/numberOfLines=\{2\}/g) ?? []).length, 2, "title and summary are 2 lines max");
  assert.equal((card.match(/onPress=\{onOpen\}/g) ?? []).length, 1, "a single navigation target");
  const pressable = card.slice(card.indexOf("<Pressable\n              onPress={onOpen}"), card.indexOf("</Pressable>", card.indexOf("onPress={onOpen}")));
  assert.ok(pressable.includes("詳しく見る →"), "the CTA is part of the one card Pressable (no second target)");
  assert.ok(/right: TOPIC_CARD\.ctaRight,\s*bottom: TOPIC_CARD\.ctaBottom,/.test(card), "bottom-right");
  assert.ok(card.includes("styles.pressFill") && /pressFill: \{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0/.test(card), "the Pressable fills the card");
});

test("level labels are unchanged and the badge is only level-tinted", async () => {
  assert.deepEqual(TOPIC_LEVEL_LABEL, { beginner: "初心者向け", intermediate: "中級者向け", advanced: "上級者向け" });
  const tokens = await read("src/constants/home-tokens.ts");
  for (const level of TOPIC_LEVELS) assert.ok(new RegExp(`${level}: \\{ background: '#[0-9a-f]{6}', text: '#[0-9a-f]{6}' \\}`).test(tokens), `${level} badge tint`);
});

test("Home section order is unchanged (topic stays between holdings and Ask AI)", async () => {
  const home = await read("src/app/(tabs)/index.tsx");
  const order = ["<HomeHeader", "<HomeReportHero", "<HomeMarketNewsGrid", "<HomeHoldingNewsList", "<HomeTopicFeature", "<HomeAskAiEntry"];
  const positions = order.map((tag) => home.indexOf(tag));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(positions.every((p) => p >= 0));
});
