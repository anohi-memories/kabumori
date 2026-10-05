import assert from "node:assert/strict";
import test from "node:test";

import { TOPIC_DETAIL_CATALOG, TOPIC_DETAIL_ROLES } from "../../src/lib/topic-detail-catalog.ts";
import { TOPIC_LEVELS } from "../../src/lib/home-topic.ts";
import {
  splitTrailingCaution,
  TOPIC_DETAIL_ART_ASPECT,
  TOPIC_DETAIL_ART_CLEAR_RATIO,
  TOPIC_DETAIL_LEVEL_COLORS,
  topicDetailStepNumber,
  topicDetailTitleStyle,
} from "../../src/lib/topic-detail-presentation.ts";

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("the three levels have one colour system: green / blue / lavender, each with the same keys", () => {
  assert.deepEqual(Object.keys(TOPIC_DETAIL_LEVEL_COLORS).sort(), [...TOPIC_LEVELS].sort());
  for (const level of TOPIC_LEVELS) {
    assert.deepEqual(Object.keys(TOPIC_DETAIL_LEVEL_COLORS[level]).sort(), ["badge", "hero", "outline", "soft", "strong"]);
  }
  // pale green / pale blue / pale lavender hero tints
  const hue = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return { r, g, b };
  };
  const green = hue(TOPIC_DETAIL_LEVEL_COLORS.beginner.hero);
  const blue = hue(TOPIC_DETAIL_LEVEL_COLORS.intermediate.hero);
  const lavender = hue(TOPIC_DETAIL_LEVEL_COLORS.advanced.hero);
  assert.ok(green.g > green.r && green.g > green.b);
  assert.ok(blue.b > blue.r && blue.b > blue.g);
  assert.ok(lavender.b > lavender.g && lavender.r > lavender.g);
});

test("headings and accents clear the AA text contrast (4.5) on every tinted surface of their level", () => {
  for (const level of TOPIC_LEVELS) {
    const c = TOPIC_DETAIL_LEVEL_COLORS[level];
    for (const surface of [c.hero, c.badge, c.soft, "#fbfbf6"]) {
      assert.ok(contrast(c.strong, surface) >= 4.5, `${level}: ${c.strong} on ${surface} = ${contrast(c.strong, surface).toFixed(2)}`);
    }
  }
});

test("steps 1-3 are basics / why / market in reading order; example and takeaway are not numbered", () => {
  assert.deepEqual(TOPIC_DETAIL_ROLES.map((role) => topicDetailStepNumber(role)), [1, 2, null, 3, null]);
});

test("splitTrailingCaution: a trailing 「ただし…」 sentence becomes the caution; the text is never changed", () => {
  const body = "PERが高い会社は、成長を期待されています。ただし、高い＝悪い、とは判断できません。";
  const result = splitTrailingCaution(body);
  assert.equal(result.caution, "ただし、高い＝悪い、とは判断できません。");
  assert.equal(result.lead + result.caution, body, "lossless: lead + caution is exactly the original");
});

test("splitTrailingCaution: no caution lead-in, a single sentence, or a middle 「ただし」 leaves the body untouched", () => {
  for (const body of [
    "一つ目です。二つ目です。",
    "ただし、これは一文だけです。",
    "最初の文です。ただし、途中です。最後の文です。",
    "",
  ]) {
    assert.deepEqual(splitTrailingCaution(body), { lead: body, caution: null }, body);
  }
});

test("across the whole catalog the split is lossless and only ever touches market/steps that really end with a caution", () => {
  let cautions = 0;
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    for (const section of entry.sections) {
      const { lead, caution } = splitTrailingCaution(section.body);
      assert.equal(lead + (caution ?? ""), section.body, `${title}/${section.role}: not lossless`);
      if (caution) {
        cautions += 1;
        assert.ok(/^(ただし|ただ、|もっとも)/.test(caution), `${title}: unexpected caution "${caution}"`);
        assert.ok(lead.trim().length > 0, `${title}: nothing left before the caution`);
      }
    }
  }
  assert.ok(cautions >= 1, "at least one real caution sentence exists in the curated text");
});

test("the Hero art keeps the approved 1942x809 aspect ratio", () => {
  assert.equal(TOPIC_DETAIL_ART_ASPECT, 1942 / 809);
});

test("title sizing: 7 characters or fewer keep the large title; longer titles are smaller and start below the art", () => {
  assert.deepEqual(topicDetailTitleStyle("PERって何？"), { fontSize: 34, lineHeight: 42, belowArt: false });
  assert.deepEqual(topicDetailTitleStyle("ROEって何を見る指標？"), { fontSize: 28, lineHeight: 36, belowArt: true });
  assert.deepEqual(topicDetailTitleStyle("信用買い残が多いと上値が重くなることがあるのはなぜ？"), { fontSize: 26, lineHeight: 34, belowArt: true });
  assert.equal(TOPIC_DETAIL_ART_CLEAR_RATIO, 0.78);
});

test("every seeded title gets a size whose line height is at least 1.2x the font", () => {
  for (const title of Object.keys(TOPIC_DETAIL_CATALOG)) {
    const style = topicDetailTitleStyle(title);
    assert.ok(style.lineHeight >= style.fontSize * 1.2, title);
    assert.ok(style.fontSize >= 26 && style.fontSize <= 34, title);
  }
});
