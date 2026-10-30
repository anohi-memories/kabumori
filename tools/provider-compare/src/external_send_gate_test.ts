import assert from "node:assert/strict";
import test from "node:test";
import type { CaseFixture } from "./fixtures.ts";
import { bodyRowsOf, syntheticLegacy, writeSyntheticFixturesDir, writeSyntheticLegacyFile } from "./synthetic_fixtures.ts";
import { loadLicenceRegister, loadRunnableCases } from "./fixture_loader.ts";
import {
  checkRequestSendable,
  EMPTY_LICENCE_REGISTER,
  guardProvider,
  type LicenceRecord,
  type LicenceRegister,
  parseLicenceRegister,
  planExternalSend,
  type SendInput,
} from "./external_send_gate.ts";
import { buildTaskRequest, buildWebSearchRequests, TASK_IDS } from "./tasks.ts";
import type { NeutralRequest, Provider, ProviderResult } from "./types.ts";
import { ZERO_USAGE } from "./types.ts";

// Everything here is pure: mock providers, local files, subprocesses started WITHOUT --allow-net. No key is real and no
// request can leave the machine.

// The 18 third-party bodies are not in the repository, so these tests use synthetic bodies with the real lengths and hosts
// (src/synthetic_fixtures.ts) and a directory whose manifest fingerprints them. The shipped manifest and licence register
// are exercised where they matter (default load: 4 cleared, register empty).
const synth = await syntheticLegacy();
const legacy = synth.cases;
const manifest = synth.manifest;
const TODAY = "2026-10-11";
const fixturesDir = await writeSyntheticFixturesDir();
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(fixturesDir, { recursive: true });
  } catch { /* already gone */ }
});

const unconfirmedIds = manifest.entries.filter((e) => e.rightsState === "rights_unconfirmed").map((e) => e.caseId);
const bodyRows = bodyRowsOf(legacy);

async function withRuntimeBodies<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const tmp = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    await Deno.writeTextFile(tmp, bodyRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return await fn(tmp);
  } finally {
    await Deno.remove(tmp);
  }
}

function inputFor(loaded: Awaited<ReturnType<typeof loadRunnableCases>>, overrides: Partial<SendInput> = {}): SendInput {
  return {
    fixtureMode: loaded.mode,
    cases: loaded.cases,
    provenance: loaded.provenance,
    manifest: loaded.manifest,
    licences: loaded.licences,
    providers: ["anthropic"],
    today: TODAY,
    ...overrides,
  };
}

function licenceFor(caseId: string, overrides: Partial<LicenceRecord> = {}): LicenceRecord {
  const entry = manifest.entries.find((e) => e.caseId === caseId)!;
  return {
    caseId,
    state: "licence_confirmed",
    scope: "external_provider_send",
    bodySha256: entry.bodySha256 as string,
    providers: ["anthropic"],
    covers: ["title", "body", "recorded_text"],
    evidenceRef: "contract TEST-0001 (fixture only)",
    confirmedBy: "test",
    confirmedOn: "2026-10-01",
    ...overrides,
  };
}

const register = (...entries: LicenceRecord[]): LicenceRegister => ({ version: 1, note: "test", entries });

/** A provider that only counts how often it was reached. */
function countingProvider(): { provider: Provider; calls: NeutralRequest[] } {
  const calls: NeutralRequest[] = [];
  const provider: Provider = {
    name: "anthropic",
    model: "claude-test",
    label: "claude-test",
    run(request) {
      calls.push(request);
      const ok: ProviderResult = {
        provider: "anthropic", model: "claude-test", label: "claude-test", ok: true, text: "{}", parsed: {}, parseError: null,
        usage: { ...ZERO_USAGE }, costUsd: 0, latencyMs: 0, stopReason: "end_turn", attempts: 1, sourceUrls: [], error: null,
      };
      return Promise.resolve(ok);
    },
  };
  return { provider, calls };
}

test("rights_safe + runtime bodies for all 18: every one is attached and hash-verified, and none is cleared to send", async () => {
  await withRuntimeBodies(async (path) => {
    const loaded = await loadRunnableCases({ fixtures: "rights_safe", runtimeBodiesPath: path, fixturesDir });
    assert.equal(loaded.cases.length, 22, "locally every case is usable");
    for (const id of unconfirmedIds) assert.equal(loaded.provenance[id], "attached_verified", id);
    const plan = planExternalSend(inputFor(loaded));
    assert.equal(plan.allowedCases.length, 4);
    assert.equal(plan.blocked.length, 18);
    assert.deepEqual(plan.blocked.map((d) => d.caseId).sort(), [...unconfirmedIds].sort());
    assert.ok(plan.blocked.every((d) => d.code === "blocked_rights_unconfirmed_no_licence"));
    assert.ok(plan.blocked.every((d) => /not a licence/.test(d.reason)), "the reason says why a matching hash is not enough");
    assert.deepEqual(plan.counts, { allowed_open_terms: 2, allowed_no_body: 2, blocked_rights_unconfirmed_no_licence: 18 });
  });
});

test("the shipped licence register is empty and parses; the default load clears exactly the 4 official / body-less cases", async () => {
  const shipped = await loadLicenceRegister();
  assert.equal(shipped.entries.length, 0);
  const loaded = await loadRunnableCases({ fixtures: "rights_safe" });
  assert.equal(loaded.licences.entries.length, 0);
  const plan = planExternalSend(inputFor(loaded));
  assert.equal(loaded.cases.length, 4);
  assert.equal(plan.allowedCases.length, 4);
  assert.equal(plan.blocked.length, 0);
  assert.deepEqual(
    [...new Set(plan.decisions.map((d) => d.code))].sort(),
    ["allowed_no_body", "allowed_open_terms"],
  );
});

test("legacy fixtures are never cleared, whatever else is true", async () => {
  const legacyFile = await writeSyntheticLegacyFile();
  try {
    const loaded = await loadRunnableCases({ fixtures: "legacy", legacyFile });
    assert.equal(loaded.cases.length, 22);
    const plan = planExternalSend(inputFor(loaded, { licences: register(...unconfirmedIds.map((id) => licenceFor(id))) }));
    assert.equal(plan.allowedCases.length, 0);
    assert.ok(plan.decisions.every((d) => d.code === "blocked_legacy_fixtures"));
  } finally {
    await Deno.remove(legacyFile);
  }
});

test("an explicit, matching licence record clears exactly that case", async () => {
  await withRuntimeBodies(async (path) => {
    const loaded = await loadRunnableCases({ fixtures: "rights_safe", runtimeBodiesPath: path, fixturesDir });
    const target = unconfirmedIds[0];
    const plan = planExternalSend(inputFor(loaded, { licences: register(licenceFor(target)) }));
    assert.equal(plan.allowedCases.length, 5);
    const decision = plan.decisions.find((d) => d.caseId === target)!;
    assert.equal(decision.code, "allowed_licence_confirmed");
    assert.match(decision.reason, /contract TEST-0001/, "the audit reference travels with the decision");
    assert.equal(plan.blocked.length, 17);
  });
});

test("a licence is bound to the body, the provider, the payload and the dates; a denial overrides", async () => {
  await withRuntimeBodies(async (path) => {
    const loaded = await loadRunnableCases({ fixtures: "rights_safe", runtimeBodiesPath: path, fixturesDir });
    const target = unconfirmedIds[0];
    const codeFor = (licences: LicenceRegister, providers: SendInput["providers"] = ["anthropic"]) =>
      planExternalSend(inputFor(loaded, { licences, providers })).decisions.find((d) => d.caseId === target)!.code;

    assert.equal(codeFor(register(licenceFor(target, { bodySha256: "0".repeat(64) }))), "blocked_licence_hash_mismatch");
    assert.equal(codeFor(register(licenceFor(target, { providers: ["openai"] }))), "blocked_licence_provider");
    assert.equal(codeFor(register(licenceFor(target)), ["anthropic", "openai"]), "blocked_licence_provider");
    assert.equal(codeFor(register(licenceFor(target)), []), "blocked_licence_provider", "no provider named = not cleared");
    assert.equal(codeFor(register(licenceFor(target, { covers: ["body"] }))), "blocked_licence_scope");
    assert.equal(codeFor(register(licenceFor(target, { covers: ["title", "body"] }))), "blocked_licence_scope");
    assert.equal(codeFor(register(licenceFor(target, { expiresOn: "2026-10-10" }))), "blocked_licence_expired");
    assert.equal(codeFor(register(licenceFor(target, { confirmedOn: "2026-10-12" }))), "blocked_licence_not_yet_valid");
    assert.equal(codeFor(register(licenceFor(target, { expiresOn: "2026-10-11" }))), "allowed_licence_confirmed", "expiry day is inclusive");
    assert.equal(
      codeFor(register(licenceFor(target), licenceFor(target, { state: "denied", evidenceRef: "publisher refusal (test)" }))),
      "blocked_licence_denied",
    );
    // a record for another case does nothing
    assert.equal(codeFor(register(licenceFor(unconfirmedIds[1]))), "blocked_rights_unconfirmed_no_licence");
  });
});

test("a licence cannot turn a stored body that is not the verified one into a sendable case", async () => {
  // A body-less case reported as attached_verified, or a stored case with a rights state that does not match, is unknown.
  const loaded = await loadRunnableCases({ fixtures: "rights_safe" });
  const forged = planExternalSend(inputFor(loaded, { provenance: { ...loaded.provenance, [loaded.cases[0].caseId]: "attached_verified" } }));
  assert.equal(forged.decisions.find((d) => d.caseId === loaded.cases[0].caseId)!.allowed, false);
  const missing = planExternalSend(inputFor(loaded, { provenance: {} }));
  assert.equal(missing.allowedCases.length, 0);
  const noManifest = planExternalSend(inputFor(loaded, { manifest: null }));
  assert.equal(noManifest.allowedCases.length, 0);
});

test("a body-less case from a host with unconfirmed terms still sends a headline and a stored post, so it needs a licence too", async () => {
  const loaded = await loadRunnableCases({ fixtures: "rights_safe" });
  const base = loaded.cases.find((c) => manifest.entries.find((e) => e.caseId === c.caseId)!.rightsState === "no_body")!;
  const tdnetLike: CaseFixture = { ...base, caseId: "synthetic-tdnet-no-body", candidate: { ...base.candidate, sourceUrl: "https://www.release.tdnet.info/inbs/x.pdf" } };
  const entry = { ...manifest.entries.find((e) => e.caseId === base.caseId)!, caseId: tdnetLike.caseId, host: "www.release.tdnet.info" };
  const input: SendInput = {
    fixtureMode: "rights_safe",
    cases: [tdnetLike],
    provenance: { [tdnetLike.caseId]: "no_body" },
    manifest: { ...manifest, entries: [entry] },
    licences: EMPTY_LICENCE_REGISTER,
    providers: ["anthropic"],
    today: TODAY,
  };
  assert.equal(planExternalSend(input).decisions[0].code, "blocked_rights_unconfirmed_no_licence");
  const record: LicenceRecord = {
    caseId: tdnetLike.caseId, state: "licence_confirmed", scope: "external_provider_send", bodySha256: null,
    providers: ["anthropic"], covers: ["title", "recorded_text"], evidenceRef: "written reply (test)", confirmedBy: "test", confirmedOn: "2026-10-01",
  };
  assert.equal(planExternalSend({ ...input, licences: register(record) }).decisions[0].code, "allowed_licence_confirmed");
  assert.equal(
    planExternalSend({ ...input, licences: register({ ...record, covers: ["title"] }) }).decisions[0].code,
    "blocked_licence_scope",
  );
  // the same shape from an open-terms host (BOJ) is cleared without a record
  assert.equal(planExternalSend({ ...input, cases: [base], provenance: { [base.caseId]: "no_body" }, manifest }).decisions[0].code, "allowed_no_body");
  assert.equal(parseLicenceRegister(JSON.parse(JSON.stringify(register(record)))).entries[0].bodySha256, null);
});

test("register parsing is strict: a malformed record stops the run instead of being skipped", () => {
  assert.equal(parseLicenceRegister({ version: 1, entries: [] }).entries.length, 0);
  assert.equal(parseLicenceRegister(JSON.parse(JSON.stringify(register(licenceFor(unconfirmedIds[0]))))).entries.length, 1);
  const bad = (patch: Record<string, unknown>) => () =>
    parseLicenceRegister({ version: 1, entries: [{ ...licenceFor(unconfirmedIds[0]), ...patch }] });
  assert.throws(bad({ bodySha256: "abc" }), /LICENCE_REGISTER_INVALID/);
  assert.throws(bad({ evidenceRef: "" }), /LICENCE_REGISTER_INVALID/);
  assert.throws(bad({ confirmedBy: undefined }), /LICENCE_REGISTER_INVALID/);
  assert.throws(bad({ state: "operator_opt_in" }), /LICENCE_REGISTER_INVALID/);
  assert.throws(bad({ scope: "local_use" }), /LICENCE_REGISTER_INVALID/);
  assert.throws(bad({ providers: ["gemini"] }), /LICENCE_REGISTER_INVALID/);
  assert.throws(bad({ confirmedOn: "yesterday" }), /LICENCE_REGISTER_INVALID/);
  assert.throws(() => parseLicenceRegister({ version: 2, entries: [] }), /LICENCE_REGISTER_INVALID/);
  assert.throws(() => parseLicenceRegister(null), /LICENCE_REGISTER_INVALID/);
  assert.equal(EMPTY_LICENCE_REGISTER.entries.length, 0);
});

test("with a guarded provider, none of the 18 cases reaches the vendor endpoint for any task (live path, mock vendor)", async () => {
  await withRuntimeBodies(async (path) => {
    const loaded = await loadRunnableCases({ fixtures: "rights_safe", runtimeBodiesPath: path, fixturesDir });
    const plan = planExternalSend(inputFor(loaded));
    const { provider, calls } = countingProvider();
    const guarded = guardProvider(provider, plan);

    let sent = 0;
    let refused = 0;
    for (const item of loaded.cases) {
      for (const task of TASK_IDS) {
        if (task === "web_search") continue;
        const request = await buildTaskRequest(task, item);
        if (!request) continue;
        const result = await guarded.run(request);
        if (result.ok) sent += 1;
        else {
          refused += 1;
          assert.equal(result.error?.code, "EXTERNAL_SEND_BLOCKED");
          assert.equal(result.attempts, 0);
          assert.equal(result.costUsd, 0);
        }
      }
    }
    assert.ok(sent > 0 && refused > 0, `sent=${sent} refused=${refused}`);
    const blocked = new Set(unconfirmedIds);
    assert.ok(calls.every((c) => !blocked.has(c.caseId)), "the inner provider was never given a blocked case");
    // and no payload that reached the inner provider carries any of the 18 bodies
    const bodies = legacy.filter((c) => blocked.has(c.caseId)).map((c) => c.candidate.bodySummary as string);
    for (const call of calls) for (const body of bodies) assert.ok(!(`${call.system}\n${call.user}`).includes(body.slice(0, 50)));
  });
});

test("a payload that carries a blocked body is refused even under a cleared case id; search requests need no clearance", async () => {
  await withRuntimeBodies(async (path) => {
    const loaded = await loadRunnableCases({ fixtures: "rights_safe", runtimeBodiesPath: path, fixturesDir });
    const plan = planExternalSend(inputFor(loaded));
    const cleared = plan.allowedCases[0];
    const blockedBody = legacy.find((c) => c.caseId === unconfirmedIds[0])!.candidate.bodySummary as string;
    const smuggled: NeutralRequest = {
      taskId: "judgement_primary", caseId: cleared.caseId, system: "s", user: `x ${blockedBody} y`, maxOutputTokens: 10,
    };
    assert.match(checkRequestSendable(smuggled, plan) ?? "", /not cleared/);
    const middle = blockedBody.slice(Math.floor(blockedBody.length / 2) - 30, Math.floor(blockedBody.length / 2) + 30);
    assert.ok(checkRequestSendable({ ...smuggled, user: `x ${middle}` }, plan) !== null, "a fragment from the middle is caught too");
    assert.equal(checkRequestSendable({ ...smuggled, user: "plain headline" }, plan), null);
    for (const search of buildWebSearchRequests()) assert.equal(checkRequestSendable(search, plan), null);
  });
});

test("the gate is pure: no network, subprocess, environment or file access in its source", async () => {
  const source = await Deno.readTextFile(new URL("external_send_gate.ts", import.meta.url));
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|Deno\.connect|WebSocket|Deno\.Command|Deno\.env|Deno\.readTextFile|Deno\.writeTextFile/.test(source));
});

// --- CLIs, run as subprocesses WITHOUT --allow-net --------------------------------------------------------------------
async function run(script: string, args: string[], env: Record<string, string> = {}) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-config", "--allow-read", "--allow-env", new URL(script, import.meta.url).pathname, ...args],
    env, stdout: "piped", stderr: "piped",
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
}
const FAKE_KEY = { ANTHROPIC_API_KEY: "sk-ant-FAKEFAKE0123456789" };

test("CLI live: runtime bodies for 18 TDnet/BBC/AJ/AP cases, nothing cleared => stops before any key lookup", async () => {
  await withRuntimeBodies(async (path) => {
    const tdnet = manifest.entries.find((e) => e.rightsState === "rights_unconfirmed")!;
    const { code, stdout, stderr } = await run("./cli.ts", [
      "--mode", "live", "--max-calls", "5", "--max-usd", "0.1", "--runtime-bodies", path, "--fixtures-dir", fixturesDir,
      "--cases", tdnet.caseId, "--providers", "anthropic:claude-haiku-5-5",
    ], { PROVIDER_COMPARE_ALLOW_PAID: "1", ...FAKE_KEY });
    assert.equal(code, 1);
    assert.match(stderr, /EXTERNAL_SEND_NO_ELIGIBLE_CASES/);
    assert.match(stdout, new RegExp(`external_send blocked ${tdnet.caseId}: blocked_rights_unconfirmed_no_licence`));
    assert.ok(!stdout.includes("key:"), "no key lookup happened");
    assert.ok(!stdout.includes("FAKEFAKE") && !stderr.includes("FAKEFAKE"));
  });
});

test("CLI dry-run reports the gate for the 18 attached cases and marks them blocked; nothing is estimated for sending them", async () => {
  await withRuntimeBodies(async (path) => {
    const { code, stdout, stderr } = await run("./cli.ts", [
      "--mode", "dry-run", "--tasks", "judgement_primary", "--runtime-bodies", path, "--fixtures-dir", fixturesDir,
      "--providers", "anthropic:claude-haiku-5-5",
    ]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /fixtures=rights_safe ready=22 excluded=0/);
    assert.match(stdout, /external_send cleared=4 blocked=18/);
    assert.equal((stdout.match(/^external_send blocked .*blocked_rights_unconfirmed_no_licence/gm) ?? []).length, 18);
  });
});

test("probe_cli: --fixtures legacy is refused before the key is looked up or any case is loaded", async () => {
  const { code, stdout, stderr } = await run("./probe_cli.ts", ["--fixtures", "legacy"], FAKE_KEY);
  assert.equal(code, 1);
  assert.match(stderr, /LEGACY_FIXTURES_REFUSED_FOR_EXTERNAL_CALLS/);
  assert.ok(!stdout.includes("key:") && !stdout.includes("fixtures="), stdout);
  assert.ok(!stderr.includes("FAKEFAKE"));
  const unknown = await run("./probe_cli.ts", ["--fixtures", "everything"], FAKE_KEY);
  assert.equal(unknown.code, 1);
  assert.ok(!unknown.stdout.includes("key:"));
});

test("probe_cli --plan-only: the default clears the 4 official cases; runtime bodies add nothing; no key, no network", async () => {
  const base = await run("./probe_cli.ts", ["--plan-only"], FAKE_KEY);
  assert.equal(base.code, 0, base.stderr);
  assert.match(base.stdout, /fixtures=rights_safe ready=4 excluded=18/);
  assert.match(base.stdout, /external_send cleared=4 blocked=0/);
  assert.match(base.stdout, /plan-only:.*no key was read and no request was made/);
  assert.ok(!base.stdout.includes("key:"));

  await withRuntimeBodies(async (path) => {
    const withBodies = await run("./probe_cli.ts", ["--plan-only", "--runtime-bodies", path, "--fixtures-dir", fixturesDir], FAKE_KEY);
    assert.equal(withBodies.code, 0, withBodies.stderr);
    assert.match(withBodies.stdout, /fixtures=rights_safe ready=22 excluded=0/);
    assert.match(withBodies.stdout, /external_send cleared=4 blocked=18/);
    const planned = (s: string) => Number(/plan-only: (\d+) requests/.exec(s)?.[1]);
    assert.equal(planned(withBodies.stdout), planned(base.stdout), "the 18 attached cases add no request to the plan");
  });
});

test("probe_cli --plan-only: a licence record in the fixtures directory clears exactly that case; nothing else changes", async () => {
  const target = unconfirmedIds[0];
  const dir = await writeSyntheticFixturesDir({ licences: register(licenceFor(target)) });
  try {
    await withRuntimeBodies(async (path) => {
      const { code, stdout, stderr } = await run("./probe_cli.ts", ["--plan-only", "--runtime-bodies", path, "--fixtures-dir", dir], FAKE_KEY);
      assert.equal(code, 0, stderr);
      assert.match(stdout, /external_send cleared=5 blocked=17/);
      assert.ok(!stdout.includes(`external_send blocked ${target}`));
      assert.match(stdout, /allowed_licence_confirmed/);
      assert.ok(!stdout.includes("key:"));
    });
    // a record whose body hash is not the attached body clears nothing
    const wrong = await writeSyntheticFixturesDir({ licences: register(licenceFor(target, { bodySha256: "1".repeat(64) })) });
    try {
      await withRuntimeBodies(async (path) => {
        const { stdout } = await run("./probe_cli.ts", ["--plan-only", "--runtime-bodies", path, "--fixtures-dir", wrong], FAKE_KEY);
        assert.match(stdout, /external_send cleared=4 blocked=18/);
        assert.match(stdout, /blocked_licence_hash_mismatch/);
      });
    } finally {
      await Deno.remove(wrong, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
