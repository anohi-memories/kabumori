import assert from "node:assert/strict";
import test from "node:test";
import { type CaseFixture, loadCases } from "./fixtures.ts";
import {
  type BodyManifest,
  manifestFor,
  resolveRunnableCases,
  rightsStateOf,
  runtimeBodiesFromRows,
  sha256Hex,
  stripUnconfirmedBodies,
  summariseExclusions,
} from "./fixture_access.ts";
import { loadRunnableCases } from "./fixture_loader.ts";
import { buildRightsSafe } from "../scripts/build_rights_safe_fixtures.ts";
import { auditFixtures } from "../scripts/fixture_rights_audit.ts";

const dir = new URL("../fixtures/", import.meta.url);
const legacy = await loadCases();
const safeCases = await loadCases(new URL("cases.rights_safe.json", dir));
const manifest = JSON.parse(await Deno.readTextFile(new URL("cases_body_manifest.json", dir))) as BodyManifest;

const id8 = (item: CaseFixture) => item.caseId.slice(-8);
const bodyRows = (cases: readonly CaseFixture[]) =>
  cases.filter((c) => c.candidate.bodySummary).map((c) => ({ id: `${id8(c)}-0000-4000-8000-000000000000`, body_summary: c.candidate.bodySummary }));

test("the manifest describes every legacy case and agrees with the rights audit", async () => {
  const rows = await auditFixtures(legacy);
  assert.equal(manifest.entries.length, 22);
  const states = Object.fromEntries(
    ["open_terms", "rights_unconfirmed", "no_body"].map((s) => [s, manifest.entries.filter((e) => e.rightsState === s).length]),
  );
  assert.deepEqual(states, { open_terms: 2, rights_unconfirmed: 18, no_body: 2 });
  for (const row of rows) {
    const entry = manifest.entries.find((e) => e.caseId === row.caseId)!;
    assert.equal(entry.rightsState === "rights_unconfirmed", row.action === "replace_with_runtime_fetch", row.caseId);
    assert.equal(entry.bodySha256, row.sha256, row.caseId);
  }
});

test("the committed rights-safe files are exactly what the builder derives from cases.json (no drift)", async () => {
  const source = JSON.parse(await Deno.readTextFile(new URL("cases.json", dir)));
  const built = await buildRightsSafe(source, "fixtures/cases.json");
  assert.equal(JSON.stringify(built.manifest), JSON.stringify(manifest));
  assert.equal(JSON.stringify(built.safe), JSON.stringify(JSON.parse(await Deno.readTextFile(new URL("cases.rights_safe.json", dir)))));
});

test("the rights-safe file holds no third-party body text and keeps the open-terms ones byte for byte", () => {
  for (const item of legacy) {
    const body = item.candidate.bodySummary ?? "";
    const entry = manifest.entries.find((e) => e.caseId === item.caseId)!;
    if (entry.rightsState === "rights_unconfirmed") {
      const safe = safeCases.find((c) => c.caseId === item.caseId)!;
      assert.equal(safe.candidate.bodySummary, null, item.caseId);
      // No 24-character window of the removed body survives in the candidate record. The headline (title) and the
      // production-written post (recorded.*) are the product's own text and may repeat words of the source; they are
      // outside this check, and the rights note says so.
      const candidateText = JSON.stringify({ ...safe.candidate, title: "" });
      for (let at = 0; at + 24 <= body.length; at += 12) {
        assert.ok(!candidateText.includes(JSON.stringify(body.slice(at, at + 24)).slice(1, -1)), `${item.caseId}: body text survives at ${at}`);
      }
    } else {
      assert.equal(safeCases.find((c) => c.caseId === item.caseId)!.candidate.bodySummary, item.candidate.bodySummary, item.caseId);
    }
  }
});

test("everything except those bodies is unchanged", () => {
  assert.equal(safeCases.length, legacy.length);
  for (const item of legacy) {
    const safe = safeCases.find((c) => c.caseId === item.caseId)!;
    const strip = (c: CaseFixture) => JSON.stringify({ ...c, candidate: { ...c.candidate, bodySummary: null } });
    assert.equal(strip(safe), strip(item), item.caseId);
  }
});

test("without an opt-in every unconfirmed case is excluded as needs_rights_review, and the legacy body is never used", async () => {
  const fromSafe = await resolveRunnableCases(safeCases, manifest, { runtimeBodies: null });
  assert.equal(fromSafe.ready.length, 4);
  assert.equal(fromSafe.excluded.length, 18);
  assert.ok(fromSafe.excluded.every((e) => e.state === "needs_rights_review"));
  // Even when someone hands the legacy file (bodies present) to the resolver, those bodies are not used as input.
  const fromLegacy = await resolveRunnableCases(legacy, manifest, { runtimeBodies: null });
  assert.equal(fromLegacy.excluded.length, 18);
  assert.deepEqual(fromLegacy.ready.map((c) => c.caseId).sort(), fromSafe.ready.map((c) => c.caseId).sort());
  assert.deepEqual(summariseExclusions(fromSafe.excluded), { needs_rights_review: 18, body_source_missing: 0, body_hash_mismatch: 0, manifest_entry_missing: 0 });
});

test("with an opt-in and matching local rows, the bodies are attached and verified", async () => {
  const runtime = runtimeBodiesFromRows(bodyRows(legacy));
  const r = await resolveRunnableCases(safeCases, manifest, { runtimeBodies: runtime });
  assert.equal(r.excluded.length, 0);
  assert.equal(r.ready.length, 22);
  assert.equal(Object.values(r.provenance).filter((p) => p === "attached_verified").length, 18);
  for (const item of r.ready) {
    const original = legacy.find((c) => c.caseId === item.caseId)!;
    assert.equal(item.candidate.bodySummary, original.candidate.bodySummary, item.caseId);
  }
});

test("a changed row, a missing row and an empty export are excluded, never run with a partial input", async () => {
  const rows = bodyRows(legacy);
  const victim = legacy.find((c) => manifest.entries.find((e) => e.caseId === c.caseId)!.rightsState === "rights_unconfirmed")!;
  const changed = rows.map((r) => (r.id.startsWith(id8(victim)) ? { ...r, body_summary: `${r.body_summary}（更新）` } : r));
  const a = await resolveRunnableCases(safeCases, manifest, { runtimeBodies: runtimeBodiesFromRows(changed) });
  assert.deepEqual(a.excluded.map((e) => [e.caseId, e.state]), [[victim.caseId, "body_hash_mismatch"]]);
  const b = await resolveRunnableCases(safeCases, manifest, { runtimeBodies: runtimeBodiesFromRows(rows.filter((r) => !r.id.startsWith(id8(victim)))) });
  assert.deepEqual(b.excluded.map((e) => [e.caseId, e.state]), [[victim.caseId, "body_source_missing"]]);
  // A source that returned nothing (for example because the publisher answered 403) leaves all 18 cases unavailable.
  const c = await resolveRunnableCases(safeCases, manifest, { runtimeBodies: new Map() });
  assert.equal(c.excluded.length, 18);
  assert.ok(c.excluded.every((e) => e.state === "body_source_missing"));
  assert.equal(c.ready.length, 4);
});

test("an open-terms body that no longer matches the manifest is excluded, and a case missing from the manifest is excluded", async () => {
  const open = safeCases.find((c) => manifest.entries.find((e) => e.caseId === c.caseId)!.rightsState === "open_terms")!;
  const tampered = safeCases.map((c) => (c.caseId === open.caseId ? { ...c, candidate: { ...c.candidate, bodySummary: "別の本文" } } : c));
  const r = await resolveRunnableCases(tampered, manifest, { runtimeBodies: null });
  assert.ok(r.excluded.some((e) => e.caseId === open.caseId && e.state === "body_hash_mismatch"));
  const noEntry = await resolveRunnableCases(safeCases, { ...manifest, entries: manifest.entries.filter((e) => e.caseId !== open.caseId) }, { runtimeBodies: null });
  assert.ok(noEntry.excluded.some((e) => e.caseId === open.caseId && e.state === "manifest_entry_missing"));
});

test("rights state follows the body policy and strip leaves open-terms cases alone", async () => {
  assert.equal(rightsStateOf("https://www.fsa.go.jp/news/x.html", true), "open_terms");
  assert.equal(rightsStateOf("https://www.release.tdnet.info/inbs/x.pdf", true), "rights_unconfirmed");
  assert.equal(rightsStateOf("https://www.release.tdnet.info/inbs/x.pdf", false), "no_body");
  const stripped = stripUnconfirmedBodies(legacy);
  assert.equal(stripped.filter((c) => c.candidate.bodySummary).length, 2);
  assert.equal((await manifestFor(stripped, "stripped")).entries.filter((e) => e.rightsState === "rights_unconfirmed").length, 0);
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("this code cannot reach the network or a subprocess, so a refused source cannot be worked around from it", async () => {
  for (const name of ["fixture_access.ts", "fixture_loader.ts"]) {
    const source = await Deno.readTextFile(new URL(name, import.meta.url));
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|Deno\.connect|WebSocket|Deno\.Command|new URL\([^)]*https?:/.test(source), name);
  }
});

test("the loader: rights-safe without an opt-in runs 4 cases; with a local export it runs all 22", async () => {
  const without = await loadRunnableCases({ fixtures: "rights_safe" });
  assert.equal(without.cases.length, 4);
  assert.equal(without.summary.needs_rights_review, 18);
  assert.equal(without.warning, null);
  const tmp = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await Deno.writeTextFile(tmp, bodyRows(legacy).map((r) => JSON.stringify(r)).join("\n") + "\n");
    const withBodies = await loadRunnableCases({ fixtures: "rights_safe", runtimeBodiesPath: tmp });
    assert.equal(withBodies.cases.length, 22);
    assert.equal(withBodies.excluded.length, 0);
  } finally {
    await Deno.remove(tmp);
  }
  const old = await loadRunnableCases({ fixtures: "legacy" });
  assert.equal(old.cases.length, 22);
  assert.match(old.warning ?? "", /third-party bodies/);
});

// --- the CLI, run as a subprocess ------------------------------------------------------------------------------------
const CLI = new URL("./cli.ts", import.meta.url).pathname;
async function runCli(args: string[], env: Record<string, string> = {}) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-config", "--allow-read", "--allow-env", CLI, ...args],
    env, stdout: "piped", stderr: "piped",
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
}

test("CLI: rights_safe dry-run lists the 18 excluded cases and needs no network", async () => {
  const { code, stdout, stderr } = await runCli(["--mode", "dry-run", "--tasks", "judgement_primary", "--fixtures", "rights_safe", "--providers", "anthropic:claude-haiku-5-5"]);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /fixtures=rights_safe ready=4 excluded=18/);
  assert.equal((stdout.match(/^excluded .*needs_rights_review/gm) ?? []).length, 18);
});

test("CLI: legacy fixtures print a warning and are refused for a live run", async () => {
  const dry = await runCli(["--mode", "dry-run", "--tasks", "judgement_primary", "--providers", "anthropic:claude-haiku-5-5"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /legacy fixtures hold third-party bodies/);
  const live = await runCli(
    ["--mode", "live", "--max-calls", "5", "--max-usd", "0.1", "--providers", "anthropic:claude-haiku-5-5"],
    { PROVIDER_COMPARE_ALLOW_PAID: "1", ANTHROPIC_API_KEY: "sk-ant-FAKEFAKE0123456789" },
  );
  assert.equal(live.code, 1);
  assert.match(live.stderr, /FIXTURES_RIGHTS_SAFE_REQUIRED_FOR_LIVE/);
  assert.ok(!live.stdout.includes("key:"));
});

test("CLI: an unknown --fixtures value fails loudly", async () => {
  assert.equal((await runCli(["--fixtures", "everything"])).code, 1);
});
