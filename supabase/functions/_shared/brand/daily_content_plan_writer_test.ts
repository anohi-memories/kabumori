import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_DAILY_CONTENT_PLAN_ITEMS,
  validateDailyContentPlanWriterInput,
} from "./daily_content_plan_writer.ts";

const plan = {
  day_theme: "小さく作って記録する",
  narrative_arc: "試す→詰まる→次の一手を残す",
  items: [{
    id: "slot-1",
    slot_no: null,
    priority: 10,
    topic: "個人開発の詰まり",
    context: "会社員の平日夜",
    key_points: ["詰まりを一つ記録"],
    must_include: ["次の一手"],
    must_avoid: ["万能論"],
  }],
};

function input(
  overrides: Partial<
    Parameters<typeof validateDailyContentPlanWriterInput>[0]
  > = {},
) {
  return {
    brandId: "ai_salaryman_lab",
    targetDate: "2026-09-19",
    source: "chatgpt" as const,
    plan,
    activate: true,
    requestKey: "chatgpt-2026-09-19-v1",
    ...overrides,
  };
}

test("writer validation accepts null slot and rejects duplicate ids/invalid arrays", () => {
  assert.equal(validateDailyContentPlanWriterInput(input()).items.length, 1);
  assert.throws(
    () =>
      validateDailyContentPlanWriterInput(input({
        plan: { ...plan, items: [plan.items[0], { ...plan.items[0] }] },
      })),
    { message: "DAILY_CONTENT_PLAN_DUPLICATE_ITEM_ID" },
  );
  assert.throws(
    () =>
      validateDailyContentPlanWriterInput(input({
        plan: { ...plan, items: [{ ...plan.items[0], key_points: ["ok", 1] }] },
      })),
    { message: "DAILY_CONTENT_PLAN_STRING_ARRAY_INVALID" },
  );
});

test("writer validation bounds payload size and item count", () => {
  assert.throws(
    () =>
      validateDailyContentPlanWriterInput(input({
        plan: {
          ...plan,
          items: Array.from(
            { length: MAX_DAILY_CONTENT_PLAN_ITEMS + 1 },
            (_, i) => ({
              ...plan.items[0],
              id: `item-${i}`,
            }),
          ),
        },
      })),
    { message: "DAILY_CONTENT_PLAN_ITEM_COUNT_INVALID" },
  );
  assert.throws(
    () =>
      validateDailyContentPlanWriterInput(input({
        plan: {
          ...plan,
          items: [{ ...plan.items[0], topic: "x".repeat(70_000) }],
        },
      })),
    { message: "DAILY_CONTENT_PLAN_PAYLOAD_TOO_LARGE" },
  );
});

test("disposable SQLite proof models version, activation, draft, and request-key idempotency", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table daily_content_plans (
      id integer primary key autoincrement,
      brand_id text not null,
      target_date text not null,
      version integer not null,
      source text not null,
      status text not null,
      plan text not null,
      request_key text not null unique,
      activation_requested integer not null
    );
    create unique index one_active on daily_content_plans(brand_id, target_date) where status='active';
  `);
  const write = (requestKey: string, activate: boolean, body: unknown) => {
    validateDailyContentPlanWriterInput(
      input({ requestKey, activate, plan: body }),
    );
    db.exec("begin immediate");
    try {
      const existing = db.prepare(
        "select * from daily_content_plans where request_key = ?",
      ).get(requestKey) as Record<string, unknown> | undefined;
      if (existing) {
        db.exec("commit");
        return existing;
      }
      const version = (db.prepare(
        "select coalesce(max(version),0)+1 as version from daily_content_plans where brand_id=? and target_date=?",
      ).get("ai_salaryman_lab", "2026-09-19") as { version: number }).version;
      if (activate) {
        db.prepare(
          "update daily_content_plans set status='archived' where brand_id=? and target_date=? and status='active'",
        ).run("ai_salaryman_lab", "2026-09-19");
      }
      const status = activate ? "active" : "draft";
      db.prepare(
        "insert into daily_content_plans (brand_id,target_date,version,source,status,plan,request_key,activation_requested) values (?,?,?,?,?,?,?,?)",
      ).run(
        "ai_salaryman_lab",
        "2026-09-19",
        version,
        "chatgpt",
        status,
        JSON.stringify(body),
        requestKey,
        activate ? 1 : 0,
      );
      db.exec("commit");
      return db.prepare("select * from daily_content_plans where request_key=?")
        .get(requestKey);
    } catch (error) {
      db.exec("rollback");
      throw error;
    }
  };
  const first = write("req-1", true, plan) as Record<string, unknown>;
  const retry = write("req-1", true, plan) as Record<string, unknown>;
  assert.equal(retry.id, first.id);
  const second = write("req-2", true, {
    ...plan,
    day_theme: "次の日",
  }) as Record<string, unknown>;
  assert.equal(second.version, 2);
  assert.equal(
    (db.prepare(
      "select count(*) as count from daily_content_plans where status='active'",
    ).get() as { count: number }).count,
    1,
  );
  assert.equal(
    (db.prepare(
      "select status from daily_content_plans where request_key='req-1'",
    ).get() as { status: string }).status,
    "archived",
  );
  const draft = write("req-3", false, {
    ...plan,
    day_theme: "下書き",
  }) as Record<string, unknown>;
  assert.equal(draft.status, "draft");
  assert.equal(
    (db.prepare(
      "select count(*) as count from daily_content_plans where status='active'",
    ).get() as { count: number }).count,
    1,
  );
  db.close();
});

test("writer migration is backend-only and serializes activation", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../../migrations/20260917211919_ai_lab_daily_content_plan_writer_phase2.sql",
      import.meta.url,
    ),
  );
  assert.match(sql, /security definer/u);
  assert.match(sql, /set search_path = ''/u);
  assert.match(sql, /pg_advisory_xact_lock/u);
  assert.match(sql, /daily_content_plans_request_key_idx/u);
  assert.match(sql, /current_setting\('request\.jwt\.claim\.role'/u);
  assert.match(sql, /DAILY_CONTENT_PLAN_REQUEST_KEY_CONFLICT/u);
  assert.match(sql, /activation_requested/u);
  assert.match(sql, /revoke execute[\s\S]*from public, anon, authenticated/u);
  assert.match(sql, /grant execute[\s\S]*to service_role/u);
  assert.match(sql, /DAILY_CONTENT_PLAN_DUPLICATE_ITEM_ID/u);
  assert.match(sql, /DAILY_CONTENT_PLAN_PAYLOAD_TOO_LARGE/u);
});
