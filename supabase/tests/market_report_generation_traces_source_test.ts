// deno test --no-config --allow-read supabase/tests/market_report_generation_traces_source_test.ts
//
// Source-side invariants of 20261007120000_market_report_generation_traces.sql (no database, no network): the
// table is append-only, service-role only, creates nothing it can break, touches no existing object, and the
// runtime that writes it never reads credentials. Behaviour is proved on a disposable PostgreSQL by
// market_report_generation_traces_run.sh.
import assert from "node:assert/strict";

const SQL = await Deno.readTextFile(new URL("../migrations/20261007120000_market_report_generation_traces.sql", import.meta.url));
const code = SQL.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
const TABLE = "public.market_report_generation_traces";

Deno.test("one new table, in one transaction, and nothing existing is altered or dropped", () => {
  assert.match(code, /^\s*begin;/m);
  assert.match(code, /commit;\s*$/);
  assert.equal((code.match(/create table /g) ?? []).length, 1);
  assert.match(code, new RegExp(`create table ${TABLE.replace(".", "\\.")} \\(`));
  for (const forbidden of [/\bdrop\s+(table|column|function|trigger|policy|index)/i, /\balter\s+table\s+(?!public\.market_report_generation_traces)/i, /\bdelete\s+from\b/i, /\btruncate\s+(?!on)/i, /\bupdate\s+public\./i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
});

Deno.test("append-only: update, delete and truncate are rejected by triggers", () => {
  for (const event of ["update", "delete"]) {
    assert.match(code, new RegExp(`create trigger market_report_generation_traces_no_${event}\\s+before ${event} on ${TABLE.replace(".", "\\.")}\\s+for each row`));
  }
  assert.match(code, /create trigger market_report_generation_traces_no_truncate\s+before truncate on [a-z_.]+\s+for each statement/);
  assert.match(code, /MARKET_REPORT_GENERATION_TRACE_IMMUTABLE/);
  assert.match(code, /set search_path = ''/);
});

Deno.test("access: RLS on, no policy, only service_role holds select + insert", () => {
  assert.match(code, new RegExp(`alter table ${TABLE.replace(".", "\\.")} enable row level security;`));
  assert.doesNotMatch(code, /create policy/i);
  assert.match(code, /revoke all on table [a-z_.]+ from public, anon, authenticated, service_role;/);
  assert.match(code, /grant select, insert on table [a-z_.]+ to service_role;/);
  assert.doesNotMatch(code, /grant [^;]*\b(update|delete|truncate|all)\b[^;]* to /i);
  assert.doesNotMatch(code, /grant [^;]* to [^;]*\b(anon|authenticated|public)\b/i);
  assert.match(code, /revoke all on function public\.market_report_generation_traces_reject_change\(\)/);
});

Deno.test("a trace never blocks maintenance of what it describes: no foreign keys to cycles or packets", () => {
  const tableDefinition = code.slice(code.indexOf("create table"), code.indexOf("do $$"));
  assert.doesNotMatch(tableDefinition, /\breferences\s+(public\.)?[a-z_]+/i);
  assert.doesNotMatch(tableDefinition, /foreign key/i);
});

Deno.test("the shape carries the evidence: per-generation identity, the candidate, both findings, the selection", () => {
  for (const column of ["invocation_id", "attempt", "generation_index", "cycle_id", "data_packet_id", "report_packet_id", "candidate", "local_issues", "local_warnings", "fact_issues", "fact_passed", "selected_for_delivery", "fallback_reason", "stage", "base_prompt_hash", "request_hash", "source", "subject_ref", "candidate_chars", "local_issue_count", "fact_issue_count", "truncated", "truncation"]) {
    assert.match(code, new RegExp(`\\b${column}\\b`), column);
  }
  assert.match(code, /unique \(invocation_id, generation_index\)/);
  assert.match(code, /source in \('shared_market_report', 'personalized_report'\)/);
});

Deno.test("access is verified, not assumed: the migration checks the table, the helper and the effective graph, and only raises", () => {
  const verify = code.slice(code.indexOf("do $$"), code.lastIndexOf("commit;"));
  assert.ok(verify.length > 500, "the verification block exists and runs inside the transaction");
  for (const refusal of ["MARKET_REPORT_TRACE_ACL_UNSAFE_OWNER", "MARKET_REPORT_TRACE_ACL_UNSAFE_MEMBERSHIP", "MARKET_REPORT_TRACE_ACL_UNEXPECTED_TABLE_GRANT", "MARKET_REPORT_TRACE_ACL_UNEXPECTED_HELPER_GRANT", "MARKET_REPORT_TRACE_ACL_EFFECTIVE_PRIVILEGE", "MARKET_REPORT_TRACE_ACL_UNEXPECTED_COLUMN_GRANT"]) {
    assert.ok(verify.includes(refusal), refusal);
  }
  for (const probe of ["has_table_privilege", "has_any_column_privilege", "has_function_privilege", "pg_has_role", "aclexplode", "WITH GRANT OPTION"]) {
    assert.ok(verify.includes(probe), probe);
  }
  // It never repairs: no grant / revoke / alter / create / drop role or default-privilege statement inside the check.
  const withoutStrings = verify.replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(withoutStrings, /\b(grant|revoke)\s+\w|\balter\s+(default|role|table|function)\b|\bcreate\s+role\b|\bdrop\s+(role|table|function)\b/i);
  // The whole migration is one transaction, so a raise rolls everything back.
  assert.ok(code.indexOf("begin;") < code.indexOf("create table") && code.lastIndexOf("commit;") > code.indexOf("do $$"));
});

Deno.test("retention is declared: counts, original size and a consistent truncation flag, no hidden per-field cap", () => {
  assert.match(code, /truncation_consistent check \(truncated = \(truncation is not null\)\)/);
  assert.doesNotMatch(code, /char_length\(candidate|length\(local_issues|length\(fact_issues/i);
});

Deno.test("no column can hold a credential, and the migration names none", () => {
  const columns = code.slice(code.indexOf("create table"), code.indexOf("comment on table"));
  assert.doesNotMatch(columns, /\b(token|password|secret|api_key|authorization|credential|cookie)\b/i);
});

Deno.test("the runtime writer reads no credentials and the handler writes traces only after settling the run", async () => {
  const writer = await Deno.readTextFile(new URL("../functions/market-report-analysis/debug_trace.ts", import.meta.url));
  assert.doesNotMatch(writer, /Deno\.env|\.env\(|new Headers|headers\[/);
  const handler = await Deno.readTextFile(new URL("../functions/market-report-analysis/handler.ts", import.meta.url));
  const complete = handler.indexOf('"complete_market_report_analysis"');
  assert.ok(complete > 0 && handler.indexOf("await writeTraces(packetId)") > complete, "after the packet is stored");
  assert.ok(handler.includes("await fail(outcome.error") && handler.includes("await writeTraces(null)"));
});
