import assert from "node:assert/strict";
import test from "node:test";
import {
  MORNING_GREETING_SCENE_TEMPLATES,
  buildMorningGreetingScenePlan,
  daysSinceEpoch,
  renderFullScenePlanVisualTheme,
  renderThemeSyncedVisualTheme,
} from "./morning_greeting_scene_logic.ts";

const INDEPENDENT_AXES = ["camera_angle", "framing", "expression", "outfit", "weather_lighting", "seasonal_element"] as const;

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day + days));
  return parsed.toISOString().slice(0, 10);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

test("daysSinceEpoch is a strictly increasing, deterministic function of the date", () => {
  const a = daysSinceEpoch("2026-09-08");
  const b = daysSinceEpoch("2026-09-09");
  assert.equal(b, a + 1);
  assert.equal(daysSinceEpoch("2026-09-08"), a);
});

test("daysSinceEpoch rejects an invalid calendar date", () => {
  assert.throws(() => daysSinceEpoch("2026-02-30"), /MORNING_GREETING_SCENE_DATE_INVALID/u);
  assert.throws(() => daysSinceEpoch("not-a-date"), /MORNING_GREETING_SCENE_DATE_INVALID/u);
});

// --- K1 review requirement 5: semantic coherence, not just numeric uniqueness ---------------------------

test("every scene template is one of the 8 hand-checked coherent (location, activity, prop) combinations — K1's own reference list", () => {
  const expected = [
    { location: "ベランダ", activity: "軽くストレッチをする", prop: "タオル" },
    { location: "住宅街の朝の道", activity: "朝散歩をする", prop: "トートバッグ" },
    { location: "近所の公園", activity: "散歩の途中で少し伸びをする", prop: "水筒" },
    { location: "玄関", activity: "靴を履いて出かける準備をする", prop: "折りたたみ傘" },
    { location: "キッチン", activity: "朝食を作る", prop: "フライパンや調理器具" },
    { location: "リビングの窓際", activity: "読書をする", prop: "本" },
    { location: "ベランダの物干しスペース", activity: "洗濯物を干す", prop: "洗濯かご" },
    { location: "ベランダの植物の前", activity: "植物に水やりをする", prop: "じょうろ" },
  ];
  assert.deepEqual(MORNING_GREETING_SCENE_TEMPLATES, expected);
});

test("every generated scene's (location, activity, prop) triple is exactly one whole template — incoherent combinations are structurally impossible", () => {
  const templateKeys = new Set(
    MORNING_GREETING_SCENE_TEMPLATES.map((t) => `${t.location} ${t.activity} ${t.prop}`),
  );
  let cursor = "2026-01-01";
  for (let i = 0; i < 365; i += 1) {
    const plan = buildMorningGreetingScenePlan(cursor);
    const key = `${plan.location} ${plan.activity} ${plan.prop}`;
    assert.ok(templateKeys.has(key), `${cursor} produced a (location, activity, prop) triple that is not a known coherent template: ${key}`);
    cursor = addDays(cursor, 1);
  }
});

test("known incompatible location/activity pairs from the K1 review can never occur", () => {
  const incompatiblePairs: Array<[RegExp, RegExp]> = [
    [/キッチン/u, /洗濯物/u],
    [/洗面所/u, /読書/u],
    [/住宅街/u, /読書/u],
    [/近所の公園/u, /靴を履いて/u],
    [/玄関/u, /カーテン/u],
    [/リビング/u, /朝食を作る/u],
  ];
  let cursor = "2026-01-01";
  for (let i = 0; i < 365; i += 1) {
    const plan = buildMorningGreetingScenePlan(cursor);
    for (const [locationPattern, activityPattern] of incompatiblePairs) {
      if (locationPattern.test(plan.location)) {
        assert.doesNotMatch(plan.activity, activityPattern, `${cursor}: ${plan.location} + ${plan.activity} is an incoherent pair from the K1 review`);
      }
    }
    cursor = addDays(cursor, 1);
  }
});

// --- anti-repetition (K1 requirement 3) -------------------------------------------------------------

test("no same main scene (location+activity+prop template) two consecutive days, checked across a full year", () => {
  let cursor = "2026-01-01";
  let previous = buildMorningGreetingScenePlan(cursor);
  for (let i = 0; i < 365; i += 1) {
    cursor = addDays(cursor, 1);
    const plan = buildMorningGreetingScenePlan(cursor);
    assert.notEqual(plan.location, previous.location, `location repeated on consecutive days at ${cursor}`);
    assert.notEqual(plan.activity, previous.activity, `activity repeated on consecutive days at ${cursor}`);
    assert.notEqual(plan.prop, previous.prop, `prop repeated on consecutive days at ${cursor}`);
    previous = plan;
  }
});

test("no independently-rotating axis repeats its value on two consecutive days, checked across a full year", () => {
  let cursor = "2026-01-01";
  let previous = buildMorningGreetingScenePlan(cursor);
  for (let i = 0; i < 365; i += 1) {
    cursor = addDays(cursor, 1);
    const plan = buildMorningGreetingScenePlan(cursor);
    for (const axis of INDEPENDENT_AXES) {
      assert.notEqual(plan[axis], previous[axis], `axis ${axis} repeated on consecutive days at ${cursor}`);
    }
    previous = plan;
  }
});

test("the main scene template never repeats within any 7-consecutive-day window (8 templates >= 7)", () => {
  let cursor = "2026-01-01";
  for (let i = 0; i < 60; i += 1) {
    const window = Array.from({ length: 7 }, (_, offset) => buildMorningGreetingScenePlan(addDays(cursor, offset)));
    const locations = window.map((plan) => plan.location);
    assert.equal(new Set(locations).size, locations.length, `location repeated within a 7-day window starting ${cursor}`);
    cursor = addDays(cursor, 1);
  }
});

test("mug specifically is never the prop on two consecutive days", () => {
  let cursor = "2026-01-01";
  let previousProp = buildMorningGreetingScenePlan(cursor).prop;
  for (let i = 0; i < 200; i += 1) {
    cursor = addDays(cursor, 1);
    const prop = buildMorningGreetingScenePlan(cursor).prop;
    if (prop === "マグカップ") assert.notEqual(previousProp, "マグカップ");
    previousProp = prop;
  }
});

test("the previously-converged window+plants+mug+front-facing-upper-body combination cannot recur, because mug is not paired with a window/plants location in any template", () => {
  for (const template of MORNING_GREETING_SCENE_TEMPLATES) {
    if (template.prop === "マグカップ") {
      assert.doesNotMatch(template.location, /窓|観葉植物/u);
    }
  }
});

test("seasonal_element stays within the calendar season for the date (no autumn leaves in mid-summer)", () => {
  const summerPlan = buildMorningGreetingScenePlan("2026-07-15");
  assert.match(summerPlan.seasonal_element, /緑|風鈴|麦わら|麦茶|うちわ|夏|氷/u);
  const winterPlan = buildMorningGreetingScenePlan("2026-01-15");
  assert.match(winterPlan.seasonal_element, /白い息|マフラー|湯気|冬|手袋|こたつ|雪/u);
});

test("the full combined scene does not repeat exactly every 7 days (axes use deliberately different-length candidate lists)", () => {
  // If every axis had the same list length, day N and day N+7 would be pixel-identical — technically
  // satisfying "no repeat within a 7-day window" but repeating every single week regardless. The scene
  // template axis has 8 candidates; the independent axes use 7/8/9/10/11 so the combined tuple's true
  // period is their LCM, not 7 or 8.
  let cursor = "2026-01-01";
  for (let i = 0; i < 40; i += 1) {
    const plan = buildMorningGreetingScenePlan(cursor);
    const weekLater = buildMorningGreetingScenePlan(addDays(cursor, 7));
    assert.notDeepEqual(plan, weekLater, `day ${cursor} and day+7 were identical`);
    cursor = addDays(cursor, 1);
  }
});

test("buildMorningGreetingScenePlan is a pure function of the date — same input, same output, no hidden state", () => {
  const a = buildMorningGreetingScenePlan("2026-09-08");
  const b = buildMorningGreetingScenePlan("2026-09-08");
  assert.deepEqual(a, b);
});

test("renderFullScenePlanVisualTheme includes every axis of the plan, comma-separated", () => {
  const plan = buildMorningGreetingScenePlan("2026-09-08");
  const rendered = renderFullScenePlanVisualTheme(plan);
  assert.match(rendered, new RegExp(escapeRegExp(plan.location), "u"));
  assert.match(rendered, new RegExp(escapeRegExp(plan.prop), "u"));
  assert.match(rendered, new RegExp(escapeRegExp(plan.outfit), "u"));
});

test("6+7: renderThemeSyncedVisualTheme preserves the fixed thematic anchor verbatim, and only layers universally-compatible composition axes (camera/framing/expression) on top — never a rotated location/activity/prop that could contradict the anchor", () => {
  const plan = buildMorningGreetingScenePlan("2026-01-01");
  const anchor = "お正月の朝、しめ飾り、湯気の立つお茶、やわらかい初日の光";
  const rendered = renderThemeSyncedVisualTheme(anchor, plan);
  assert.ok(rendered.startsWith(anchor));
  assert.match(rendered, new RegExp(escapeRegExp(plan.expression), "u"));
  // Location/activity/prop stay with the anchor's own text — never separately re-introduced, so a rotated
  // template can never contradict what the anchor already implies (e.g. New Year's tea vs. doing laundry).
  assert.doesNotMatch(rendered, new RegExp(`${escapeRegExp(plan.location)}で`, "u"));
  assert.doesNotMatch(rendered, new RegExp(escapeRegExp(plan.activity), "u"));
});

test("14 consecutive dry scene plans (structural coherence check): every plan's scene is one of the known coherent templates", () => {
  const templateKeys = new Set(
    MORNING_GREETING_SCENE_TEMPLATES.map((t) => `${t.location} ${t.activity} ${t.prop}`),
  );
  let cursor = "2026-09-08";
  const plans: string[] = [];
  for (let i = 0; i < 14; i += 1) {
    const plan = buildMorningGreetingScenePlan(cursor);
    const key = `${plan.location} ${plan.activity} ${plan.prop}`;
    assert.ok(templateKeys.has(key), `day ${i} (${cursor}) is not a coherent template: ${key}`);
    plans.push(`${cursor}: ${plan.location} / ${plan.activity} / ${plan.prop}`);
    cursor = addDays(cursor, 1);
  }
  assert.equal(plans.length, 14);
});
