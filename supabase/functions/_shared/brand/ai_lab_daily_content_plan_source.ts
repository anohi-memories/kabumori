import { BrandContextError } from "./brand_context.ts";
import {
  type DailyContentPlanItem,
  jstDateFromIso,
  parseDailyContentPlan,
  selectDailyContentPlanItem,
} from "./daily_content_plan.ts";

function supabaseHeaders(serviceRoleKey: string): Record<string, string> {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
}

export async function loadAiLabDailyContentPlan({
  supabaseUrl,
  serviceRoleKey,
  scheduledFor,
  scheduleDate,
  slotNo,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledFor: string;
  scheduleDate?: string | null;
  slotNo: number;
  fetchImpl?: typeof fetch;
}): Promise<DailyContentPlanItem | null> {
  const targetDate = scheduleDate?.trim() || jstDateFromIso(scheduledFor);
  const params = new URLSearchParams({
    select: "plan,version,id",
    brand_id: "eq.ai_salaryman_lab",
    target_date: `eq.${targetDate}`,
    status: "eq.active",
    order: "version.desc,id.asc",
    limit: "1",
  });
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/daily_content_plans?${params}`,
    {
      headers: supabaseHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new BrandContextError("AI_LAB_CONTENT_PLAN_READ_FAILED");
  }
  const rows = await response.json() as Array<{ plan?: unknown }>;
  const row = rows[0];
  if (!row) return null;
  const plan = parseDailyContentPlan(row.plan);
  // An active plan without a concrete item for this slot is a normal,
  // deterministic signal to use the hardened persona fallback. Never invent a
  // new topic from a daily theme alone.
  return selectDailyContentPlanItem(plan, slotNo);
}
