import assert from "node:assert/strict";
import test from "node:test";
import { loadCases } from "./fixtures.ts";
import { auditFixtures, summariseAudit } from "../scripts/fixture_rights_audit.ts";
import { bodyMayBeStored } from "./body_policy.ts";

const cases = await loadCases();

test("the audit reads the original fixtures and changes nothing", async () => {
  const before = JSON.stringify(cases);
  const rows = await auditFixtures(cases);
  assert.equal(rows.length, 22);
  assert.equal(JSON.stringify(await loadCases()), before);
});

test("only bodies from hosts with open reuse terms are kept; TDnet, BBC, Al Jazeera and AP are to be replaced by a runtime fetch", async () => {
  const rows = await auditFixtures(cases);
  for (const row of rows) {
    if (!row.bodyStored) continue;
    assert.equal(row.allowedByPolicy, ["boj.or.jp", "fsa.go.jp", "mof.go.jp"].some((h) => (row.host ?? "").endsWith(h)), row.caseId);
    assert.equal(row.action, row.allowedByPolicy ? "keep" : "replace_with_runtime_fetch", row.caseId);
    assert.match(row.sha256 ?? "", /^[0-9a-f]{64}$/, row.caseId);
  }
  for (const row of rows.filter((r) => ["tdnet", "bbc_world", "al_jazeera"].includes(r.sourceName) && r.bodyStored)) {
    assert.equal(row.action, "replace_with_runtime_fetch", row.caseId);
  }
});

test("the summary adds up", async () => {
  const rows = await auditFixtures(cases);
  const s = summariseAudit(rows);
  assert.equal(s.bodiesStored, s.allowedByPolicy + s.toReplaceWithRuntimeFetch);
  const perSource = Object.values(s.bySource);
  assert.equal(perSource.reduce((a, b) => a + b.stored, 0), s.bodiesStored);
  assert.equal(perSource.reduce((a, b) => a + b.mustReplace, 0), s.toReplaceWithRuntimeFetch);
  assert.ok(bodyMayBeStored("https://www.fsa.go.jp/news/r8/x.html"));
  assert.ok(!bodyMayBeStored("https://www.release.tdnet.info/inbs/x.pdf"));
});
