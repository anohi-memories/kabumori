// G6-18 (2026-10-25): a deterministic OFFLINE race harness for the busy-check ABA (G6-08 R1, G6-17 KNOWN GAP 2). Two or
// three REAL gateways (createAiGateway -> shared execute -> SupabaseLedgerBudgetGuard / SupabaseAiCallsStore) share one
// in-memory model of the call store and the ledger that follows the SQL's documented semantics:
//   ledger   one reservation per (request_id, attempt); reserving an unsent one again REUSES it (same id); mark_sent
//            turns reserved -> sent once; a sent / settled / released one refuses (ATTEMPT_IN_FLIGHT / ATTEMPT_FINALIZED);
//            release turns only reserved -> released (20261010050613).
//   store    ai_calls_claim creates a missing row (acquired, new owner), answers busy for an acquired one; complete needs
//            the claim owner; recovery abandons an acquired row only without an open ledger attempt (READ COMMITTED)
//            and forget deletes only a closed row (20261017120000 / 20261020154536).
// Each process can be paused at an RPC, so every interleaving below is exact. Every scenario runs twice:
//   "current"   the gateway as it is: its held check is the second ai_calls_claim (busy = held).
//   "candidate" a TEST-ONLY emulation of the owner-held contract (ai_calls_claim_held, PR #409..#431): a process's later
//               claims are answered with claim_held's rule (its ORIGINAL token + identity + acquired; a missing row stays
//               missing). The gateway's code is the same; only the model's answer changes. This is NOT the product fix.
// SAFE tests assert guarantees. KNOWN GAP tests assert today's dangerous or blocking outcome so a change is noticed; they
// are not PASSes of a guarantee. No network, no DB, fake keys, no real AI. Write-up: docs/ai-provider/G6_BUSY_ABA_OFFLINE.md.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY supabase/tests/common_ai_gateway_busy_aba_offline_test.ts
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { buildAppPolicySet, type FeatureContent } from "../ai_gateway/app_policies.ts";
import type { AuthorityPort, AuthVerdict } from "../ai_gateway/gateway.ts";
import { AiGatewayConfigError, createAiGateway } from "../ai_gateway/runtime.ts";

const SUPABASE = "http://127.0.0.1:54321";
const SERVICE_KEY = "local-g6-18-service-NOT-A-SECRET";
const USER = "11111111-1111-4111-8111-111111111111";
const BRAND = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const content: FeatureContent = {
  systemInstructions: "Test instructions; answer JSON { reply }.",
  schema: { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } },
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string",
};
const SET = buildAppPolicySet({
  "postona:consult": {
    enabled: true, revision: "test-r1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000,
    maxAttempts: 1, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
  },
}, { "postona:consult": content });
/** The authority is not under test here (G6-17 covers R1 v1): the same person, always allowed, recheck unchanged. */
const ALLOW: AuthorityPort = {
  verdict: () => Promise.resolve({ decision: "allow", subject: { kind: "user", app: "postona", userId: USER, brand: BRAND }, generation: "g", expiresAtMs: Date.now() + 60_000 } as AuthVerdict),
  recheck: (prior) => Promise.resolve(prior),
};

type Proc = "A" | "B" | "C";
type Mode = "current" | "candidate";
type Row = { identity: string; owner: string; state: "acquired" | "complete" | "abandoned"; result: unknown };
type Pause = { arrive: () => void; arrived: Promise<void>; release: () => void; released: Promise<void> };

/** The shared model of public.ai_calls_* and public.ai_ledger_* (see the header), with per-process pauses. */
class Model {
  rows = new Map<string, Row>();
  reservations = new Map<string, { key: string; status: "reserved" | "sent" | "settled" | "unknown" | "released" }>();
  /** The token each process got from ITS first claim of a key (what claim_held needs; candidate mode only). */
  firstToken = new Map<string, string>();
  log: string[] = [];
  private pauses = new Map<string, Pause>();
  private n = 0;
  /** PROPOSAL CHECK only: the reservation key also carries the process's claim token (an owner-bound attempt). */
  constructor(readonly mode: Mode, readonly ownerBound = false) {}

  pause(proc: Proc, rpc: string): Pause {
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>((r) => arrive = r);
    const released = new Promise<void>((r) => release = r);
    const p = { arrive, arrived, release, released };
    this.pauses.set(`${proc}:${rpc}`, p);
    return p;
  }
  fetchFor(proc: Proc): FetchLike {
    return async (input, init) => {
      const name = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "");
      const p = (JSON.parse(String(init?.body)) as { p: Record<string, unknown> }).p;
      const gate = this.pauses.get(`${proc}:${name}`);
      if (gate) {
        this.pauses.delete(`${proc}:${name}`);
        gate.arrive();
        await gate.released;
      }
      const [status, body] = this.answer(proc, name, p);
      this.log.push(`${proc} ${name.replace(/^ai_(ledger|calls)_/u, "")} -> ${JSON.stringify(body)}`);
      return jsonResponse(status, body);
    };
  }
  private answer(proc: Proc, name: string, p: Record<string, unknown>): [number, unknown] {
    switch (name) {
      case "ai_calls_claim": {
        const key = String(p.call_key);
        const identity = JSON.stringify([p.tenant_tag, p.fingerprint, p.application, p.feature, p.subject_kind, p.user_id ?? null]);
        const mine = this.firstToken.get(`${proc}#${key}`);
        const row = this.rows.get(key);
        if (this.mode === "candidate" && mine) {
          // ai_calls_claim_held: held only for the ORIGINAL token + identity + acquired; never inserts. "Not held" is
          // given to the gateway as conflict (anything but busy fences it).
          const held = !!row && row.owner === mine && row.identity === identity && row.state === "acquired";
          return [200, { kind: held ? "busy" : "conflict" }];
        }
        if (!row) {
          const owner = crypto.randomUUID();
          this.rows.set(key, { identity, owner, state: "acquired", result: null });
          if (!mine) this.firstToken.set(`${proc}#${key}`, owner);
          return [200, { kind: "acquired", owner }];
        }
        if (row.identity !== identity) return [200, { kind: "conflict" }];
        if (row.state === "acquired") return [200, { kind: "busy" }];
        if (row.state === "complete") return [200, { kind: "complete", fingerprint: p.fingerprint, result: row.result }];
        throw new Error("model: a claim of an abandoned row is not part of these scenarios");
      }
      case "ai_calls_complete": {
        const row = this.rows.get(String(p.call_key));
        if (!row || row.owner !== p.owner || row.state !== "acquired") return [400, { code: "P0001", message: "AI_CALLS_NOT_OWNER" }];
        row.state = "complete";
        row.result = structuredClone(p.result);
        return [200, { state: "complete", duplicate: false }];
      }
      case "ai_ledger_reserve": {
        const key = `${p.request_id}#${p.attempt}` + (this.ownerBound ? `#${this.firstToken.get(`${proc}#${p.request_id}`)}` : "");
        const found = [...this.reservations.entries()].find(([, r]) => r.key === key);
        if (found) {
          const [id, r] = found;
          if (r.status === "reserved") return [200, { allowed: true, reservation_id: id, status: "reserved", reused: true, level: "ok" }];
          return [200, { allowed: false, reservation_id: id, status: r.status, reused: true, reason: r.status === "sent" ? "ATTEMPT_IN_FLIGHT" : "ATTEMPT_FINALIZED", level: "ok" }];
        }
        const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
        this.reservations.set(id, { key, status: "reserved" });
        return [200, { allowed: true, reservation_id: id, status: "reserved", reused: false, level: "ok" }];
      }
      case "ai_ledger_mark_sent": {
        const r = this.reservations.get(String(p.reservation_id))!;
        if (r.status !== "reserved") return [200, { status: r.status, may_send: false }];
        r.status = "sent";
        return [200, { status: "sent", may_send: true }];
      }
      case "ai_ledger_settle": {
        const r = this.reservations.get(String(p.reservation_id))!;
        r.status = p.outcome === "unknown" ? "unknown" : "settled";
        return [200, { settled: true }];
      }
      case "ai_ledger_release": {
        const r = this.reservations.get(String(p.reservation_id))!;
        const was = r.status;
        if (was === "reserved") r.status = "released";
        return [200, { released: was === "reserved", status: r.status }];
      }
    }
    throw new Error(`model: unexpected ${name}`);
  }
  /** Recovery's ai_calls_abandon. READ COMMITTED: an open ledger attempt for the call keeps the row. `staleSnapshot`
   *  models what a REPEATABLE READ / SERIALIZABLE snapshot taken before the reservation would do (G6-12). */
  abandon(key: string, staleSnapshot = false): "ABANDONED" | "REFUSED_OPEN_ATTEMPT" {
    const row = this.rows.get(key)!;
    assert.equal(row.state, "acquired");
    const open = [...this.reservations.values()].some((r) => r.key.startsWith(`${key}#`) && (r.status === "reserved" || r.status === "sent"));
    if (open && !staleSnapshot) return "REFUSED_OPEN_ATTEMPT";
    row.state = "abandoned";
    return "ABANDONED";
  }
  /** ai_calls_forget_user for this row: deletes a closed row, never an acquired one. */
  forget(key: string): "DELETED" | "REFUSED_ACQUIRED" {
    if (this.rows.get(key)?.state === "acquired") return "REFUSED_ACQUIRED";
    this.rows.delete(key);
    return "DELETED";
  }
  onlyKey(): string {
    const keys = new Set([...this.reservations.values()].map((r) => r.key.split("#")[0]).concat([...this.rows.keys()]));
    assert.equal(keys.size, 1, "one operation, one call key");
    return [...keys][0];
  }
}

function world(mode: Mode, respond?: () => Response, ownerBound = false, base = SUPABASE, serviceKey = SERVICE_KEY) {
  const model = new Model(mode, ownerBound);
  const procs = {} as Record<Proc, { run: () => Promise<{ ok: boolean; code?: string }>; sends: () => number }>;
  for (const proc of ["A", "B", "C"] as Proc[]) {
    const provider = recordingFetch(() => respond?.() ?? jsonResponse(200, openAiBody({ reply: `from ${proc}` }, { model: "gpt-6-luna" })));
    const gateway = createAiGateway({
      // G6-20: this suite pins the legacy busy re-claim check; the owner-held default has its own suites.
      ledgerMode: "legacy_busy_check_unsafe",
      supabaseUrl: base,
      serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", serviceKey),
      readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
      authority: ALLOW,
      policies: SET.registry,
      fetch: (input, init) => (String(input).startsWith(base) ? model.fetchFor(proc)(input, init) : provider.fetch(input, init)),
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    procs[proc] = {
      // The SAME operation every time (same person, workspace, operation id and input): the same call key.
      run: async () => {
        try {
          return await gateway.execute("credential", { app: "postona", feature: "consult", operationId: "op-g6-18-0001", input: "相談", brand: BRAND });
        } finally {
          for (const k of [...model.firstToken.keys()]) if (k.startsWith(`${proc}#`)) model.firstToken.delete(k);
        }
      },
      sends: () => provider.calls.length,
    };
  }
  const code = (r: { ok: boolean; code?: string }) => (r.ok ? "OK" : r.code);
  const statuses = () => [...model.reservations.values()].map((r) => r.status);
  const sends = () => ({ A: procs.A.sends(), B: procs.B.sends(), C: procs.C.sends() });
  const total = () => procs.A.sends() + procs.B.sends() + procs.C.sends();
  return { model, ...procs, A: procs.A, B: procs.B, C: procs.C, code, statuses, sends, total };
}

/** A stalls right before its reserve; recovery closes and forgets its row (no attempt was open yet); B claims the key anew. */
async function staleA(w: ReturnType<typeof world>) {
  const gate = w.model.pause("A", "ai_ledger_reserve");
  const a = w.A.run();
  await gate.arrived;
  const key = w.model.onlyKey();
  assert.deepEqual([w.model.abandon(key), w.model.forget(key)], ["ABANDONED", "DELETED"]);
  return { a, gate, key };
}

const MODES: Mode[] = ["current", "candidate"];

Deno.test("SAFE S1 one owner: one send, OK, the attempt settled (both modes)", async () => {
  for (const mode of MODES) {
    const w = world(mode);
    assert.equal(w.code(await w.A.run()), "OK", mode);
    assert.deepEqual([w.total(), w.statuses()], [1, ["settled"]], mode);
  }
});

Deno.test("SAFE S4 the new owner finished before the stale process resumes: the stale reserve meets a finalized attempt -> UNKNOWN, nothing sent (both modes)", async () => {
  for (const mode of MODES) {
    const w = world(mode);
    const { a, gate } = await staleA(w);
    assert.equal(w.code(await w.B.run()), "OK", mode);
    gate.release();
    assert.equal(w.code(await a), "UNKNOWN", mode);
    assert.deepEqual([w.sends(), w.statuses()], [{ A: 0, B: 1, C: 0 }, ["settled"]], mode);
  }
});

Deno.test("SAFE S6 the same operation retried while the first process is stalled: IN_PROGRESS, no second send (both modes)", async () => {
  for (const mode of MODES) {
    const w = world(mode);
    const gate = w.model.pause("A", "ai_ledger_reserve");
    const a = w.A.run();
    await gate.arrived;
    assert.equal(w.code(await w.C.run()), "IN_PROGRESS", mode);
    gate.release();
    assert.equal(w.code(await a), "OK", mode);
    assert.deepEqual([w.sends(), w.statuses()], [{ A: 1, B: 0, C: 0 }, ["settled"]], mode);
  }
});

Deno.test("SAFE S7 a lost provider answer: UNKNOWN at the upper bound, stored; the retry replays UNKNOWN, never resent (both modes)", async () => {
  for (const mode of MODES) {
    const w = world(mode, () => jsonResponse(504, {}));
    assert.equal(w.code(await w.A.run()), "UNKNOWN", mode);
    assert.equal(w.code(await w.A.run()), "UNKNOWN", mode);
    assert.deepEqual([w.total(), w.statuses()], [1, ["unknown"]], mode);
  }
});

Deno.test("SAFE S8a after the held check and the recheck (paused right before mark_sent): READ COMMITTED recovery cannot close the row while the reservation is open, forget cannot delete it; the owner sends once (both modes)", async () => {
  for (const mode of MODES) {
    const w = world(mode);
    const gate = w.model.pause("A", "ai_ledger_mark_sent");
    const a = w.A.run();
    await gate.arrived;
    const key = w.model.onlyKey();
    assert.deepEqual([w.model.abandon(key), w.model.forget(key)], ["REFUSED_OPEN_ATTEMPT", "REFUSED_ACQUIRED"], mode);
    gate.release();
    assert.equal(w.code(await a), "OK", mode);
    assert.equal(w.total(), 1, mode);
  }
});

Deno.test("SAFE in every scenario: the ledger's (request_id, attempt) key never lets one operation be sent twice", async () => {
  // Re-run the dangerous interleavings below and check only the money property.
  for (const mode of MODES) {
    for (const order of ["A-before-B-mark_sent", "A-before-B-reserve"] as const) {
      const w = world(mode);
      const { a, gate } = await staleA(w);
      const gb = w.model.pause("B", order === "A-before-B-reserve" ? "ai_ledger_reserve" : "ai_ledger_mark_sent");
      const b = w.B.run();
      await gb.arrived;
      gate.release();
      await a;
      gb.release();
      await b;
      assert.ok(w.total() <= 1, `${mode} ${order}: at most one send`);
    }
  }
});

Deno.test("KNOWN GAP S2 (current): stale A resumes after B reserved but before B's mark_sent: A reuses B's reservation, passes the busy check and SENDS for a row it no longer owns; B is refused (UNKNOWN); A cannot record (UNKNOWN). The candidate model fences A, but A's release of the SHARED reservation then blocks B too (nobody sends, B UNKNOWN)", async () => {
  const run = async (mode: Mode) => {
    const w = world(mode);
    const { a, gate } = await staleA(w);
    const gb = w.model.pause("B", "ai_ledger_mark_sent");
    const b = w.B.run();
    await gb.arrived;
    gate.release();
    const ra = w.code(await a);
    gb.release();
    const rb = w.code(await b);
    return { ra, rb, sends: w.sends(), statuses: w.statuses(), log: w.model.log };
  };
  const cur = await run("current");
  assert.deepEqual([cur.ra, cur.rb, cur.sends, cur.statuses], ["UNKNOWN", "UNKNOWN", { A: 1, B: 0, C: 0 }, ["settled"]], "KNOWN GAP: the non-owner sends");
  assert.ok(cur.log.some((l) => l.startsWith("A reserve ->") && l.includes('"reused":true')), "A reused B's reservation");
  const cand = await run("candidate");
  assert.deepEqual([cand.ra, cand.rb, cand.sends, cand.statuses], ["UNKNOWN", "UNKNOWN", { A: 0, B: 0, C: 0 }, ["released"]], "KNOWN GAP (candidate): the stale release blocks the owner");
});

Deno.test("FENCED (G6-22, H2 #329 P2 F1 negative 2): the same S2 A -> B -> A with a production-shaped (non-loopback) Supabase URL and secret-shaped key: the legacy mode is refused when the gateways are built, so the stale claimant A sends 0 and B sends 0 (nothing reaches the ledger)", async () => {
  const prodUrl = "https://abcdefghijklmnopqrst.supabase.co";
  const prodKey = "sb_secret_" + "FAKE_0000000000";
  let w: ReturnType<typeof world> | undefined;
  let refused = "";
  try {
    w = world("current", undefined, false, prodUrl, prodKey);
  } catch (e) {
    assert.ok(e instanceof AiGatewayConfigError, String(e));
    refused = e.message;
  }
  if (w) {
    // Before G6-22 the gateways were built: run the exact S2 interleaving and report what the stale claimant did.
    const { a, gate } = await staleA(w);
    const gb = w.model.pause("B", "ai_ledger_mark_sent");
    const b = w.B.run();
    await gb.arrived;
    gate.release();
    await a;
    gb.release();
    await b;
  }
  assert.deepEqual([refused, w?.sends() ?? { A: 0, B: 0, C: 0 }, w?.model.log.length ?? 0], ["AI_GATEWAY_CONFIG_INVALID:ledger_mode_nonloopback", { A: 0, B: 0, C: 0 }, 0], "stale claimant provider 0");
});

Deno.test("KNOWN GAP S3 (current): stale A resumes before B reserves: A's new reservation passes the busy check and A SENDS; B meets an attempt in flight (UNKNOWN). The candidate model fences A, but A's released attempt is FINALIZED for B too (nobody sends, B UNKNOWN)", async () => {
  const run = async (mode: Mode) => {
    const w = world(mode);
    const { a, gate } = await staleA(w);
    const gb = w.model.pause("B", "ai_ledger_reserve");
    const b = w.B.run();
    await gb.arrived;
    gate.release();
    const ra = w.code(await a);
    gb.release();
    const rb = w.code(await b);
    return { ra, rb, sends: w.sends(), statuses: w.statuses() };
  };
  const cur = await run("current");
  assert.deepEqual([cur.ra, cur.rb, cur.sends, cur.statuses], ["UNKNOWN", "UNKNOWN", { A: 1, B: 0, C: 0 }, ["settled"]], "KNOWN GAP: the non-owner sends");
  const cand = await run("candidate");
  assert.deepEqual([cand.ra, cand.rb, cand.sends, cand.statuses], ["UNKNOWN", "UNKNOWN", { A: 0, B: 0, C: 0 }, ["released"]], "KNOWN GAP (candidate): the attempt key is burned for the owner");
});

Deno.test("KNOWN GAP S5 (current): the row was forgotten and nobody re-claimed it: stale A's busy check RE-CREATES the erased row (a fresh acquired row nobody owns), then is fenced (nothing sent). The candidate model (non-creating) leaves it absent", async () => {
  const run = async (mode: Mode) => {
    const w = world(mode);
    const { a, gate, key } = await staleA(w);
    gate.release();
    const ra = w.code(await a);
    return { ra, sends: w.total(), statuses: w.statuses(), row: w.model.rows.get(key)?.state ?? "absent" };
  };
  assert.deepEqual(await run("current"), { ra: "UNKNOWN", sends: 0, statuses: ["released"], row: "acquired" }, "KNOWN GAP: the forgotten row is back");
  assert.deepEqual(await run("candidate"), { ra: "UNKNOWN", sends: 0, statuses: ["released"], row: "absent" }, "candidate: stays forgotten");
});

Deno.test("KNOWN GAP S8b (both modes): if recovery runs on a snapshot older than the reservation (REPEATABLE READ / SERIALIZABLE, G6-12), it closes the row AFTER A's held check; A then sends for a row B owns. No held check can see a change after it: only the READ COMMITTED guard (PR #409, unapplied) closes this", async () => {
  for (const mode of MODES) {
    const w = world(mode);
    const ga = w.model.pause("A", "ai_ledger_mark_sent");
    const a = w.A.run();
    await ga.arrived;
    const key = w.model.onlyKey();
    assert.deepEqual([w.model.abandon(key, true), w.model.forget(key)], ["ABANDONED", "DELETED"], mode);
    const gb = w.model.pause("B", "ai_ledger_mark_sent");
    const b = w.B.run();
    await gb.arrived;
    ga.release();
    const ra = w.code(await a);
    gb.release();
    const rb = w.code(await b);
    assert.deepEqual([ra, rb, w.sends()], ["UNKNOWN", "UNKNOWN", { A: 1, B: 0, C: 0 }], `KNOWN GAP (${mode}): the stale snapshot lets the non-owner send`);
  }
});

Deno.test("PROPOSAL CHECK (test-only model, not a fix): binding the ledger attempt to the claim owner closes the candidate's blocking in S2 / S3 (B sends once, OK; A sends nothing) ONLY together with claim_held; owner-bound attempts with today's busy check send TWICE", async () => {
  const run = async (mode: Mode, order: "A-before-B-mark_sent" | "A-before-B-reserve") => {
    const w = world(mode, undefined, true);
    const { a, gate } = await staleA(w);
    const gb = w.model.pause("B", order === "A-before-B-reserve" ? "ai_ledger_reserve" : "ai_ledger_mark_sent");
    const b = w.B.run();
    await gb.arrived;
    gate.release();
    const ra = w.code(await a);
    gb.release();
    const rb = w.code(await b);
    return { ra, rb, sends: w.sends() };
  };
  for (const order of ["A-before-B-mark_sent", "A-before-B-reserve"] as const) {
    assert.deepEqual(await run("candidate", order), { ra: "UNKNOWN", rb: "OK", sends: { A: 0, B: 1, C: 0 } }, `candidate + owner-bound, ${order}`);
    assert.deepEqual(await run("current", order), { ra: "UNKNOWN", rb: "OK", sends: { A: 1, B: 1, C: 0 } }, `DANGER without claim_held, ${order}: two sends`);
  }
});
