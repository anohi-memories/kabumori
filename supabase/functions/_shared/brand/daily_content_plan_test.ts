import assert from "node:assert/strict";
import test from "node:test";
import {
  jstDateFromIso,
  parseDailyContentPlan,
  selectDailyContentPlanItem,
} from "./daily_content_plan.ts";
import { loadAiLabDailyContentPlan } from "./ai_lab_daily_content_plan_source.ts";

const rawPlan = {
  day_theme: "小さく試して詰まりを残す",
  narrative_arc: "試行錯誤を一つの短文にする",
  items: [
    {
      id: "slot-2-late",
      slot_no: 2,
      priority: 20,
      topic: "遅い候補",
    },
    {
      id: "slot-2-first",
      slot_no: 2,
      priority: 10,
      topic: "優先候補",
      context: "会社員の帰宅後",
      tone_override: "淡々とした実験メモ",
      key_points: ["詰まり"],
      must_include: ["小さく試す"],
      must_avoid: ["万能論"],
    },
    { id: "slot-1", slot_no: 1, topic: "朝の候補" },
  ],
};

test("selects the same exact-slot item deterministically by priority then id", () => {
  const plan = parseDailyContentPlan(rawPlan);
  const first = selectDailyContentPlanItem(plan, 2);
  const second = selectDailyContentPlanItem(plan, 2);
  assert.equal(first?.id, "slot-2-first");
  assert.equal(first?.toneOverride, "淡々とした実験メモ");
  assert.equal(first?.dayTheme, "小さく試して詰まりを残す");
  assert.deepEqual(first, second);
  assert.equal(selectDailyContentPlanItem(plan, 3), null);
});

test("JST date conversion uses the scheduled row's calendar day at the UTC boundary", () => {
  assert.equal(jstDateFromIso("2026-09-17T14:59:59.000Z"), "2026-09-17");
  assert.equal(jstDateFromIso("2026-09-17T15:00:00.000Z"), "2026-09-18");
});

test("source loader requests only the active AI Lab plan for the exact date and slot", async () => {
  let requestedUrl = "";
  const result = await loadAiLabDailyContentPlan({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-fixture",
    scheduledFor: "2026-09-17T15:00:00.000Z",
    slotNo: 2,
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      return Response.json([{ plan: rawPlan, version: 1, id: "plan-1" }]);
    },
  });
  assert.equal(result?.id, "slot-2-first");
  assert.match(requestedUrl, /brand_id=eq\.ai_salaryman_lab/u);
  assert.match(requestedUrl, /target_date=eq\.2026-09-18/u);
  assert.match(requestedUrl, /status=eq\.active/u);
  assert.match(requestedUrl, /order=version\.desc%2Cid\.asc/u);
});

test("an absent active plan is a normal fallback signal", async () => {
  const result = await loadAiLabDailyContentPlan({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-fixture",
    scheduledFor: "2026-09-17T00:00:00.000Z",
    scheduleDate: "2026-09-17",
    slotNo: 1,
    fetchImpl: async () => Response.json([]),
  });
  assert.equal(result, null);
});

test("an active plan without the claimed slot fails closed instead of inventing a theme", async () => {
  await assert.rejects(
    () =>
      loadAiLabDailyContentPlan({
        supabaseUrl: "https://example.supabase.co",
        serviceRoleKey: "service-role-fixture",
        scheduledFor: "2026-09-17T00:00:00.000Z",
        scheduleDate: "2026-09-17",
        slotNo: 9,
        fetchImpl: async () => Response.json([{ plan: rawPlan }]),
      }),
    { message: "AI_LAB_CONTENT_PLAN_SLOT_MISSING" },
  );
});
