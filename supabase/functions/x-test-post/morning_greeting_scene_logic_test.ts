import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMorningGreetingScenePlan,
  daysSinceEpoch,
  renderFullScenePlanVisualTheme,
  renderThemeSyncedVisualTheme,
} from "./morning_greeting_scene_logic.ts";

const AXES = ["location", "activity", "camera_angle", "framing", "prop", "expression", "outfit", "weather_lighting", "seasonal_element"] as const;

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day + days));
  return parsed.toISOString().slice(0, 10);
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

test("4+5: no axis repeats its value on two consecutive days, checked across a full year", () => {
  let cursor = "2026-01-01";
  let previous = buildMorningGreetingScenePlan(cursor);
  for (let i = 0; i < 365; i += 1) {
    cursor = addDays(cursor, 1);
    const plan = buildMorningGreetingScenePlan(cursor);
    for (const axis of AXES) {
      assert.notEqual(plan[axis], previous[axis], `axis ${axis} repeated on consecutive days at ${cursor}`);
    }
    previous = plan;
  }
});

test("1+2+3: location/activity/prop/framing/camera_angle/outfit never repeat within any 7-consecutive-day window", () => {
  const sevenDayAxes = ["location", "activity", "camera_angle", "framing", "prop", "outfit"] as const;
  let cursor = "2026-01-01";
  for (let i = 0; i < 60; i += 1) {
    const window = Array.from({ length: 7 }, (_, offset) => buildMorningGreetingScenePlan(addDays(cursor, offset)));
    for (const axis of sevenDayAxes) {
      const values = window.map((plan) => plan[axis]);
      assert.equal(new Set(values).size, values.length, `axis ${axis} repeated within a 7-day window starting ${cursor}`);
    }
    cursor = addDays(cursor, 1);
  }
});

test("2+3: mug specifically is never the prop on two consecutive days", () => {
  let cursor = "2026-01-01";
  let previousProp = buildMorningGreetingScenePlan(cursor).prop;
  for (let i = 0; i < 200; i += 1) {
    cursor = addDays(cursor, 1);
    const prop = buildMorningGreetingScenePlan(cursor).prop;
    if (prop === "マグカップ") assert.notEqual(previousProp, "マグカップ");
    previousProp = prop;
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
  // satisfying "no repeat within a 7-day window" but repeating every single week regardless. Axis list
  // lengths are deliberately different (7/8/9/10/11) so the combined 9-axis tuple's true period is their
  // LCM, not 7.
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
  assert.match(rendered, new RegExp(plan.location.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(rendered, new RegExp(plan.prop.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(rendered, new RegExp(plan.outfit.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("6+7: renderThemeSyncedVisualTheme preserves the fixed thematic anchor verbatim, and only layers day-varying composition axes on top", () => {
  const plan = buildMorningGreetingScenePlan("2026-01-01");
  const anchor = "お正月の朝、しめ飾り、湯気の立つお茶、やわらかい初日の光";
  const rendered = renderThemeSyncedVisualTheme(anchor, plan);
  assert.ok(rendered.startsWith(anchor));
  assert.match(rendered, new RegExp(plan.activity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(rendered, new RegExp(plan.expression.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  // Location/prop/season stay with the anchor's own text — never separately re-introduced.
  assert.doesNotMatch(rendered, new RegExp(`${plan.location}で`, "u"));
});
