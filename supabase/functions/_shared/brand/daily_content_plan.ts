import { BrandContextError } from "./brand_context.ts";

export type DailyContentPlanItem = {
  id: string;
  slotNo: number;
  priority: number;
  dayTheme?: string;
  narrativeArc?: string;
  topic: string;
  context: string;
  toneOverride: string;
  keyPoints: readonly string[];
  mustInclude: readonly string[];
  mustAvoid: readonly string[];
};

export type DailyContentPlan = {
  dayTheme: string;
  narrativeArc: string;
  items: readonly DailyContentPlanItem[];
};

type RawPlan = {
  day_theme?: unknown;
  narrative_arc?: unknown;
  items?: unknown;
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0
    )
      .map((item) => item.trim())
    : [];
}

function parseItem(value: unknown): DailyContentPlanItem {
  if (typeof value !== "object" || value === null) {
    throw new BrandContextError("AI_LAB_CONTENT_PLAN_INVALID");
  }
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const topic = typeof raw.topic === "string" ? raw.topic.trim() : "";
  const slotNo = raw.slot_no;
  const priority = raw.priority;
  if (
    !id || !topic || typeof slotNo !== "number" || !Number.isInteger(slotNo) ||
    slotNo < 1 ||
    (priority !== undefined &&
      (typeof priority !== "number" || !Number.isFinite(priority)))
  ) {
    throw new BrandContextError("AI_LAB_CONTENT_PLAN_INVALID");
  }
  return {
    id,
    slotNo,
    priority: typeof priority === "number" ? priority : 0,
    topic,
    context: typeof raw.context === "string" ? raw.context.trim() : "",
    toneOverride: typeof raw.tone_override === "string"
      ? raw.tone_override.trim()
      : "",
    keyPoints: strings(raw.key_points),
    mustInclude: strings(raw.must_include),
    mustAvoid: strings(raw.must_avoid),
  };
}

export function parseDailyContentPlan(value: unknown): DailyContentPlan {
  if (typeof value !== "object" || value === null) {
    throw new BrandContextError("AI_LAB_CONTENT_PLAN_INVALID");
  }
  const raw = value as RawPlan;
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new BrandContextError("AI_LAB_CONTENT_PLAN_INVALID");
  }
  const dayTheme = typeof raw.day_theme === "string"
    ? raw.day_theme.trim()
    : "";
  const narrativeArc = typeof raw.narrative_arc === "string"
    ? raw.narrative_arc.trim()
    : "";
  return {
    dayTheme,
    narrativeArc,
    items: raw.items.map(parseItem),
  };
}

/** Selects by exact scheduled slot, then stable priority/id ordering. */
export function selectDailyContentPlanItem(
  plan: DailyContentPlan,
  slotNo: number,
): DailyContentPlanItem | null {
  const item = [...plan.items]
    .filter((item) => item.slotNo === slotNo)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0] ??
    null;
  return item
    ? { ...item, dayTheme: plan.dayTheme, narrativeArc: plan.narrativeArc }
    : null;
}

export function jstDateFromIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BrandContextError("AI_LAB_CONTENT_PLAN_DATE_INVALID");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  if (!year || !month || !day) {
    throw new BrandContextError("AI_LAB_CONTENT_PLAN_DATE_INVALID");
  }
  return `${year}-${month}-${day}`;
}
