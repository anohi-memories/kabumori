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
import { bodyRowsOf, syntheticLegacy, writeSyntheticFixturesDir, writeSyntheticLegacyFile } from "./synthetic_fixtures.ts";
import { buildIndex, scanJson } from "./body_leak_scan.ts";
import { bodyMayBeStored } from "./body_policy.ts";

// The 18 third-party bodies are not in this repository. Rights logic is exercised with synthetic bodies that have the real
// lengths and hosts (src/synthetic_fixtures.ts); the committed files are checked against the committed manifest and audit.

const dir = new URL("../fixtures/", import.meta.url);
const safeCases = await loadCases();
const realManifest = JSON.parse(await Deno.readTextFile(new URL("cases_body_manifest.json", dir))) as BodyManifest;
const synth = await syntheticLegacy();
const legacy = synth.cases; // 22 cases, the unconfirmed ones carrying synthetic bodies
const manifest = synth.manifest;

const id8 = (item: CaseFixture) => item.caseId.slice(-8);
const bodyRows = bodyRowsOf;

test("the committed manifest, audit and rights-safe file agree: 22 cases, 18 unconfirmed without a body, open-terms bodies fingerprinted", async () => {
  const audit = JSON.parse(
    await Deno.readTextFile(new URL("../../../docs/model-optimization/fixture_rights_audit_2026-10-10.json", import.meta.url)),
  ) as { cases: Array<{ caseId: string; action: string; sha256: string | null }> };
  assert.equal(realManifest.entries.length, 22);
  assert.equal(safeCases.length, 22);
  const states = Object.fromEntries(
    ["open_terms", "rights_unconfirmed", "no_body"].map((s) => [s, realManifest.entries.filter((e) => e.rightsState === s).length]),
  );
  assert.deepEqual(states, { open_terms: 2, rights_unconfirmed: 18, no_body: 2 });
  for (const row of audit.cases) {
    const entry = realManifest.entries.find((e) => e.caseId === row.caseId)!;
    assert.equal(entry.rightsState === "rights_unconfirmed", row.action === "replace_with_runtime_fetch", row.caseId);
    assert.equal(entry.bodySha256, row.sha256, row.caseId);
  }
  for (const item of safeCases) {
    const entry = realManifest.entries.find((e) => e.caseId === item.caseId)!;
    const body = item.candidate.bodySummary;
    if (entry.rightsState === "open_terms") {
      assert.ok(body !== null && body.length === entry.bodyChars, item.caseId);
      assert.equal(await sha256Hex(body), entry.bodySha256, item.caseId);
    } else {
      assert.equal(body, null, `${item.caseId}: ${entry.rightsState} must carry no body`);
    }
  }
});

test("the audit logic, run on bodies with the real lengths, agrees with the synthetic manifest", async () => {
  const rows = await auditFixtures(legacy);
  assert.equal(rows.length, 22);
  assert.equal(rows.filter((r) => r.action === "replace_with_runtime_fetch").length, 18);
  for (const row of rows) {
    const entry = manifest.entries.find((e) => e.caseId === row.caseId)!;
    assert.equal(entry.rightsState === "rights_unconfirmed", row.action === "replace_with_runtime_fetch", row.caseId);
    assert.equal(entry.bodySha256, row.sha256, row.caseId);
    const real = realManifest.entries.find((e) => e.caseId === row.caseId)!;
    assert.equal(entry.rightsState, real.rightsState, row.caseId);
    assert.equal(entry.bodyChars, real.bodyChars, row.caseId);
  }
});

test("the builder turns a file that holds bodies into exactly the committed rights-safe cases", async () => {
  const built = await buildRightsSafe({ version: 1, exportedAt: "synthetic", cases: legacy }, "synthetic (tests only)");
  assert.equal(JSON.stringify(built.safe.cases), JSON.stringify(safeCases));
  assert.equal(JSON.stringify(built.manifest), JSON.stringify(manifest));
  assert.equal(built.safe.cases.filter((c) => c.candidate.bodySummary).length, 2);
});

test("no window of a removed body survives in the committed candidate records (scanner proven on synthetic bodies)", () => {
  const bodies = new Map<string, string>();
  for (const item of legacy) {
    const entry = manifest.entries.find((e) => e.caseId === item.caseId)!;
    if (entry.rightsState === "rights_unconfirmed") bodies.set(id8(item), item.candidate.bodySummary as string);
  }
  assert.equal(bodies.size, 18);
  const index = buildIndex(bodies, 24);
  // positive control: the scanner does see a body when one is present
  assert.ok(scanJson({ cases: legacy.map((c) => c.candidate) }, index, 24).length >= 18);
  // the committed file carries none of them
  assert.deepEqual(scanJson({ cases: safeCases.map((c) => c.candidate) }, index, 24), []);
});

test("against the real bodies (when the private legacy file is available): no window outside headline fields", {
  skip: Deno.env.get("PROVIDER_COMPARE_LEGACY_FILE") ? false : "no private legacy file (expected in CI; owners run scripts/body_leak_scan.ts)",
}, async () => {
  const file = JSON.parse(await Deno.readTextFile(Deno.env.get("PROVIDER_COMPARE_LEGACY_FILE") as string)) as { cases: CaseFixture[] };
  const bodies = new Map<string, string>();
  for (const item of file.cases) {
    const entry = realManifest.entries.find((e) => e.caseId === item.caseId)!;
    if (entry.rightsState === "rights_unconfirmed" && item.candidate.bodySummary) bodies.set(id8(item), item.candidate.bodySummary);
  }
  assert.equal(bodies.size, 18);
  const index = buildIndex(bodies, 40);
  assert.deepEqual(scanJson({ cases: safeCases }, index, 40, (path) => path.endsWith(".title")), []);
});

test("every committed fixture file stores a body only for a host whose terms allow it", async () => {
  // Covers all JSON under fixtures/, not only the 22 cases: eval_expansion.json and eval_nopost_sample.json carry bodies too.
  const checked: Record<string, number> = {};
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const data = JSON.parse(await Deno.readTextFile(new URL(entry.name, dir)));
    const offenders: string[] = [];
    let stored = 0;
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, `${path}[]`));
      } else if (node !== null && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        const body = obj.bodySummary ?? obj.body_summary;
        if (typeof body === "string" && body.length > 0) {
          stored += 1;
          const url = (obj.sourceUrl ?? obj.source_url) as unknown;
          if (typeof url !== "string" || !bodyMayBeStored(url)) offenders.push(`${path} (${String(url)})`);
        }
        for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
      }
    };
    walk(data, "");
    assert.deepEqual(offenders, [], `${entry.name} stores a body for a host without confirmed terms`);
    checked[entry.name] = stored;
  }
  // The scan reached the files that really carry bodies (guards against a walk that silently checks nothing).
  assert.equal(checked["cases.rights_safe.json"], 2);
  assert.ok(checked["eval_expansion.json"] > 0 && checked["eval_nopost_sample.json"] > 0, JSON.stringify(checked));
});

test("without an opt-in every unconfirmed case is excluded as needs_rights_review, and a body in the input is never used", async () => {
  const fromSafe = await resolveRunnableCases(safeCases, realManifest, { runtimeBodies: null });
  assert.equal(fromSafe.ready.length, 4);
  assert.equal(fromSafe.excluded.length, 18);
  assert.ok(fromSafe.excluded.every((e) => e.state === "needs_rights_review"));
  // Even when someone hands a file that has bodies to the resolver, those bodies are not used as input.
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

test("rows that are not the fingerprinted bodies (the real manifest vs synthetic rows) are excluded, never attached", async () => {
  const r = await resolveRunnableCases(safeCases, realManifest, { runtimeBodies: runtimeBodiesFromRows(bodyRows(legacy)) });
  assert.equal(r.excluded.length, 18);
  assert.ok(r.excluded.every((e) => e.state === "body_hash_mismatch"));
  assert.equal(r.ready.length, 4);
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
  const open = safeCases.find((c) => realManifest.entries.find((e) => e.caseId === c.caseId)!.rightsState === "open_terms")!;
  const tampered = safeCases.map((c) => (c.caseId === open.caseId ? { ...c, candidate: { ...c.candidate, bodySummary: "別の本文" } } : c));
  const r = await resolveRunnableCases(tampered, realManifest, { runtimeBodies: null });
  assert.ok(r.excluded.some((e) => e.caseId === open.caseId && e.state === "body_hash_mismatch"));
  const noEntry = await resolveRunnableCases(safeCases, { ...realManifest, entries: realManifest.entries.filter((e) => e.caseId !== open.caseId) }, { runtimeBodies: null });
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
  for (const name of ["fixture_access.ts", "fixture_loader.ts", "body_leak_scan.ts"]) {
    const source = await Deno.readTextFile(new URL(name, import.meta.url));
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|Deno\.connect|WebSocket|Deno\.Command|new URL\([^)]*https?:/.test(source), name);
  }
});

test("the loader: rights-safe without an opt-in runs 4 cases; with a local export it runs all 22; legacy needs an explicit private file", async () => {
  const without = await loadRunnableCases({ fixtures: "rights_safe" });
  assert.equal(without.cases.length, 4);
  assert.equal(without.summary.needs_rights_review, 18);
  assert.equal(without.warning, null);
  assert.equal(without.licences.entries.length, 0);

  const fixturesDir = await writeSyntheticFixturesDir();
  const tmp = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await Deno.writeTextFile(tmp, bodyRows(legacy).map((r) => JSON.stringify(r)).join("\n") + "\n");
    const withBodies = await loadRunnableCases({ fixtures: "rights_safe", runtimeBodiesPath: tmp, fixturesDir });
    assert.equal(withBodies.cases.length, 22);
    assert.equal(withBodies.excluded.length, 0);
  } finally {
    await Deno.remove(tmp);
    await Deno.remove(fixturesDir, { recursive: true });
  }

  await assert.rejects(() => loadRunnableCases({ fixtures: "legacy" }), /LEGACY_FILE_REQUIRED/);
  const legacyFile = await writeSyntheticLegacyFile();
  try {
    const old = await loadRunnableCases({ fixtures: "legacy", legacyFile });
    assert.equal(old.cases.length, 22);
    assert.match(old.warning ?? "", /third-party bodies/);
  } finally {
    await Deno.remove(legacyFile);
  }
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

test("CLI: the default is rights_safe; legacy needs a private file, prints a warning and is refused for a live run", async () => {
  const byDefault = await runCli(["--mode", "dry-run", "--tasks", "judgement_primary", "--providers", "anthropic:claude-haiku-5-5"]);
  assert.equal(byDefault.code, 0, byDefault.stderr);
  assert.match(byDefault.stdout, /fixtures=rights_safe ready=4 excluded=18/);
  assert.ok(!byDefault.stderr.includes("legacy fixtures hold"), "no legacy warning unless legacy was asked for");

  const noFile = await runCli(["--mode", "dry-run", "--fixtures", "legacy", "--providers", "anthropic:claude-haiku-5-5"]);
  assert.equal(noFile.code, 1);
  assert.match(noFile.stderr, /LEGACY_FILE_REQUIRED/);

  const legacyFile = await writeSyntheticLegacyFile();
  try {
    const dry = await runCli(["--mode", "dry-run", "--tasks", "judgement_primary", "--fixtures", "legacy", "--legacy-file", legacyFile, "--providers", "anthropic:claude-haiku-5-5"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stderr, /legacy fixtures hold third-party bodies/);
    const live = await runCli(
      ["--mode", "live", "--fixtures", "legacy", "--legacy-file", legacyFile, "--max-calls", "5", "--max-usd", "0.1", "--providers", "anthropic:claude-haiku-5-5"],
      { PROVIDER_COMPARE_ALLOW_PAID: "1", ANTHROPIC_API_KEY: "sk-ant-FAKEFAKE0123456789" },
    );
    assert.equal(live.code, 1);
    assert.match(live.stderr, /FIXTURES_RIGHTS_SAFE_REQUIRED_FOR_LIVE/);
    assert.ok(!live.stdout.includes("key:"));
  } finally {
    await Deno.remove(legacyFile);
  }
});

test("CLI: an unknown --fixtures value fails loudly", async () => {
  assert.equal((await runCli(["--fixtures", "everything"])).code, 1);
});
