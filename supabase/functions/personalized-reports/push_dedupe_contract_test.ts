import assert from "node:assert/strict";
import test from "node:test";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260911230000_personalized_reports.sql",
    import.meta.url,
  ),
);

test("personalized report notification is idempotent for a NULL tracked_stock_id", () => {
  assert.match(
    migration,
    /create unique index if not exists notifications_personalized_report_once\s+on public\.notifications\s*\(user_id, source_type, source_id\)\s*where source_type = 'personalized_report'/i,
  );
  assert.match(
    migration,
    /on conflict \(user_id, source_type, source_id\) where source_type = 'personalized_report' do nothing/i,
  );
  assert.match(
    migration,
    /inserted as \([\s\S]*?returning target\.id, target\.user_id, target\.source_id/i,
  );
  assert.match(
    migration,
    /update public\.personalized_reports as r[\s\S]*?from inserted/i,
  );
});

test("personalized report enqueue still requires current user opt-in and a Fact-passed completed report", () => {
  const rpcStart = migration.indexOf(
    "create or replace function public.enqueue_personalized_report_notification",
  );
  const rpcEnd = migration.indexOf("$$;", rpcStart);
  assert.ok(rpcStart >= 0 && rpcEnd > rpcStart);
  const rpc = migration.slice(rpcStart, rpcEnd);
  assert.match(rpc, /settings\.push_enabled = true/i);
  assert.match(rpc, /settings\.morning_report = true/i);
  assert.match(rpc, /settings\.close_report = true/i);
  assert.match(rpc, /r\.status = 'completed'/i);
  assert.match(rpc, /r\.fact_status = 'passed'/i);
});
