import {
  type DailyContentPlan,
  parseDailyContentPlan,
} from "./daily_content_plan.ts";

export const MAX_DAILY_CONTENT_PLAN_BYTES = 65_536;
export const MAX_DAILY_CONTENT_PLAN_ITEMS = 32;

export type DailyContentPlanWriterInput = {
  brandId: string;
  targetDate: string;
  source: "chatgpt" | "app_ai" | "manual";
  plan: unknown;
  activate: boolean;
  requestKey: string;
};

export class DailyContentPlanWriterValidationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "DailyContentPlanWriterValidationError";
  }
}

function reject(code: string): never {
  throw new DailyContentPlanWriterValidationError(code);
}

function assertStringArray(item: Record<string, unknown>, key: string): void {
  if (!(key in item)) return;
  const value = item[key];
  if (
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string")
  ) {
    reject("DAILY_CONTENT_PLAN_STRING_ARRAY_INVALID");
  }
}

export function validateDailyContentPlanWriterInput(
  input: DailyContentPlanWriterInput,
): DailyContentPlan {
  if (!input.brandId.trim()) reject("DAILY_CONTENT_PLAN_BRAND_REQUIRED");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.targetDate)) {
    reject("DAILY_CONTENT_PLAN_DATE_INVALID");
  }
  const targetDate = new Date(`${input.targetDate}T00:00:00.000Z`);
  if (
    Number.isNaN(targetDate.getTime()) ||
    targetDate.toISOString().slice(0, 10) !== input.targetDate
  ) {
    reject("DAILY_CONTENT_PLAN_DATE_INVALID");
  }
  if (
    !input.source || !["chatgpt", "app_ai", "manual"].includes(input.source)
  ) {
    reject("DAILY_CONTENT_PLAN_SOURCE_INVALID");
  }
  if (!input.requestKey.trim() || input.requestKey.length > 200) {
    reject("DAILY_CONTENT_PLAN_REQUEST_KEY_REQUIRED");
  }
  if (
    typeof input.plan !== "object" || input.plan === null ||
    Array.isArray(input.plan)
  ) {
    reject("DAILY_CONTENT_PLAN_OBJECT_REQUIRED");
  }
  const serialized = JSON.stringify(input.plan);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength >
      MAX_DAILY_CONTENT_PLAN_BYTES
  ) {
    reject("DAILY_CONTENT_PLAN_PAYLOAD_TOO_LARGE");
  }
  const raw = input.plan as Record<string, unknown>;
  if (
    !Array.isArray(raw.items) || raw.items.length < 1 ||
    raw.items.length > MAX_DAILY_CONTENT_PLAN_ITEMS
  ) {
    reject("DAILY_CONTENT_PLAN_ITEM_COUNT_INVALID");
  }
  const ids = new Set<string>();
  for (const rawItem of raw.items) {
    if (
      typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)
    ) {
      reject("DAILY_CONTENT_PLAN_ITEM_OBJECT_REQUIRED");
    }
    const item = rawItem as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()) {
      reject("DAILY_CONTENT_PLAN_ITEM_ID_REQUIRED");
    }
    if (ids.has(item.id.trim())) reject("DAILY_CONTENT_PLAN_DUPLICATE_ITEM_ID");
    ids.add(item.id.trim());
    if (typeof item.topic !== "string" || !item.topic.trim()) {
      reject("DAILY_CONTENT_PLAN_ITEM_TOPIC_REQUIRED");
    }
    if (
      item.slot_no !== undefined && item.slot_no !== null &&
      (typeof item.slot_no !== "number" || !Number.isInteger(item.slot_no) ||
        item.slot_no < 1)
    ) {
      reject("DAILY_CONTENT_PLAN_SLOT_INVALID");
    }
    if (
      item.priority !== undefined &&
      (typeof item.priority !== "number" || !Number.isFinite(item.priority))
    ) {
      reject("DAILY_CONTENT_PLAN_PRIORITY_INVALID");
    }
    if (item.context !== undefined && typeof item.context !== "string") {
      reject("DAILY_CONTENT_PLAN_ITEM_CONTEXT_INVALID");
    }
    if (
      item.tone_override !== undefined && typeof item.tone_override !== "string"
    ) reject("DAILY_CONTENT_PLAN_ITEM_TONE_INVALID");
    assertStringArray(item, "key_points");
    assertStringArray(item, "must_include");
    assertStringArray(item, "must_avoid");
  }
  try {
    return parseDailyContentPlan(input.plan);
  } catch (error) {
    if (
      error instanceof Error && error.message.startsWith("AI_LAB_CONTENT_PLAN_")
    ) {
      reject(error.message);
    }
    reject("DAILY_CONTENT_PLAN_INVALID");
  }
}
