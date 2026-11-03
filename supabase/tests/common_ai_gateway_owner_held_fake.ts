// G6-20 (2026-10-28) OFFLINE test support: an in-memory model of the call store, the ledger and the owner-held ledger
// RPCs that follows the SQL's documented semantics (no DB, no network), with per-process pauses and faults.
//   ledger            one reservation per (request_id, attempt); an unsent one is REUSED; mark_sent turns reserved ->
//                     sent once; release turns only reserved -> released (20261010050613).
//   call store        ai_calls_claim creates a missing row or answers busy / conflict / complete; complete needs the
//                     claim owner; recovery abandons an acquired row only without an open attempt (READ COMMITTED);
//                     forget deletes a closed row (20261017120000 / 20261020154536).
//   owner-held ledger ai_calls_{reserve,mark_sent,release}_held: the owner-held check (original token + identity +
//                     acquired) in the same step as the ledger step; attempts recorded per claim token; a stranger
//                     never reaches the ledger and never releases another claim's attempt
//                     (supabase/candidates/common_ai_g6/001_ai_calls_owner_held_ledger.sql).
// The real-SQL counterpart is common_ai_gateway_owner_held_ledger_pg_test.ts.
import assert from "node:assert/strict";
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { jsonResponse } from "../functions/_shared/ai_provider/test_support.ts";

export type Row = { identity: string; owner: string; state: "acquired" | "complete" | "abandoned"; result: unknown };
export type Fault = "network" | "lost" | number;
type Pause = { arrive: () => void; arrived: Promise<void>; release: () => void; released: Promise<void> };

const identityOf = (p: Record<string, unknown>) =>
  JSON.stringify([p.tenant_tag, p.fingerprint, p.application, p.feature, p.subject_kind, p.user_id ?? null, p.brand_ref ?? null]);

export class OwnerHeldModel {
  rows = new Map<string, Row>();
  reservations = new Map<string, { key: string; status: "reserved" | "sent" | "settled" | "failed" | "unknown" | "released" }>();
  attemptOwners = new Map<string, string>();
  /** Every RPC answered, in order: "<proc> <rpc> -> <body>". */
  log: string[] = [];
  /** One-shot faults by "<rpc>#<n>" (n counted per process) or "<rpc>" (every call). */
  faults = new Map<string, Fault>();
  /** RPCs that do not exist (a candidate not applied): answer 404 PGRST202. */
  missing = new Set<string>();
  private pauses = new Map<string, Pause>();
  private counts = new Map<string, number>();
  private n = 0;

  pause(proc: string, rpc: string): Pause {
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>((r) => arrive = r);
    const released = new Promise<void>((r) => release = r);
    const p = { arrive, arrived, release, released };
    this.pauses.set(`${proc}:${rpc}`, p);
    return p;
  }
  calls(proc?: string): string[] {
    return this.log.filter((l) => !proc || l.startsWith(`${proc} `)).map((l) => l.split(" ")[1]);
  }
  fetchFor(proc: string): FetchLike {
    return async (input, init) => {
      const name = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "");
      const p = (JSON.parse(String(init?.body)) as { p: Record<string, unknown> }).p;
      const gate = this.pauses.get(`${proc}:${name}`);
      if (gate) {
        this.pauses.delete(`${proc}:${name}`);
        gate.arrive();
        await gate.released;
      }
      const n = (this.counts.get(`${proc}:${name}`) ?? 0) + 1;
      this.counts.set(`${proc}:${name}`, n);
      const fault = this.faults.get(`${name}#${n}`) ?? this.faults.get(name);
      if (this.missing.has(name)) {
        this.log.push(`${proc} ${name} -> 404`);
        return jsonResponse(404, { code: "PGRST202" });
      }
      if (fault === "network") {
        this.log.push(`${proc} ${name} -> network`);
        throw new TypeError("unreachable: the statement never ran");
      }
      if (typeof fault === "number") {
        this.log.push(`${proc} ${name} -> ${fault}`);
        return jsonResponse(fault, { code: "XX000" });
      }
      const [status, body] = this.answer(name, p);
      this.log.push(`${proc} ${name} -> ${JSON.stringify(body)}`);
      return fault === "lost" ? jsonResponse(504, {}) : jsonResponse(status, body); // "lost": committed, answer lost
    };
  }

  /** NULL when held, else the reason (ai_calls.hold_reason). */
  private holdReason(h: Record<string, unknown>): string | null {
    const row = this.rows.get(String(h.call_key));
    if (!row) return "NOT_FOUND";
    if (row.identity !== identityOf(h)) return "IDENTITY_MISMATCH";
    if (row.state !== "acquired") return "NOT_ACQUIRED";
    if (row.owner !== h.owner) return "OWNER_MISMATCH";
    return null;
  }
  private reserve(p: Record<string, unknown>): Record<string, unknown> {
    const key = `${p.request_id}#${p.attempt}`;
    const found = [...this.reservations.entries()].find(([, r]) => r.key === key);
    if (found) {
      const [id, r] = found;
      if (r.status === "reserved") return { allowed: true, reservation_id: id, status: "reserved", reused: true, level: "ok" };
      return { allowed: false, reservation_id: id, status: r.status, reused: true, reason: r.status === "sent" ? "ATTEMPT_IN_FLIGHT" : "ATTEMPT_FINALIZED", level: "ok" };
    }
    const id = `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
    this.reservations.set(id, { key, status: "reserved" });
    return { allowed: true, reservation_id: id, status: "reserved", reused: false, level: "ok" };
  }
  private answer(name: string, p: Record<string, unknown>): [number, unknown] {
    switch (name) {
      case "ai_calls_claim": {
        const key = String(p.call_key);
        const row = this.rows.get(key);
        if (!row) {
          const owner = crypto.randomUUID();
          this.rows.set(key, { identity: identityOf(p), owner, state: "acquired", result: null });
          return [200, { kind: "acquired", owner }];
        }
        if (row.identity !== identityOf(p)) return [200, { kind: "conflict" }];
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
      case "ai_calls_reserve_held": {
        const held = p.held as Record<string, unknown>, ledger = p.ledger as Record<string, unknown>;
        assert.equal(ledger.request_id, held.call_key, "the ledger request_id is the call key");
        const reason = this.holdReason(held);
        if (reason) return [200, { allowed: false, held: false, reason }];
        const r = this.reserve(ledger);
        if (r.allowed !== true) {
          const { reservation_id: _hidden, ...rest } = r;
          return [200, { ...rest, held: true }];
        }
        const id = String(r.reservation_id);
        if (!this.attemptOwners.has(id)) this.attemptOwners.set(id, String(held.owner));
        if (this.attemptOwners.get(id) !== held.owner) return [200, { allowed: false, held: true, reason: "ATTEMPT_OWNER_MISMATCH", reused: true }];
        return [200, { ...r, held: true }];
      }
      case "ai_calls_mark_sent_held": {
        const held = p.held as Record<string, unknown>;
        const reason = this.holdReason(held);
        if (reason) return [200, { may_send: false, held: false, reason }];
        const id = String(p.reservation_id);
        if (this.attemptOwners.get(id) !== held.owner) return [200, { may_send: false, held: true, reason: "ATTEMPT_OWNER_MISMATCH" }];
        const r = this.reservations.get(id)!;
        if (r.status !== "reserved") return [200, { status: r.status, may_send: false, held: true }];
        r.status = "sent";
        return [200, { status: "sent", may_send: true, held: true }];
      }
      case "ai_calls_release_held": {
        const held = p.held as Record<string, unknown>;
        const id = String(p.reservation_id);
        if (this.attemptOwners.get(id) !== held.owner) return [200, { released: false, reason: "ATTEMPT_OWNER_MISMATCH" }];
        const r = this.reservations.get(id)!;
        const was = r.status;
        if (was === "reserved") r.status = "released";
        return [200, { released: was === "reserved", status: r.status }];
      }
      case "ai_ledger_settle": {
        const r = this.reservations.get(String(p.reservation_id))!;
        r.status = p.outcome === "unknown" ? "unknown" : p.outcome === "failed" ? "failed" : "settled";
        return [200, { settled: true }];
      }
    }
    throw new Error(`model: unexpected ${name}`);
  }

  /** Recovery's ai_calls_abandon. READ COMMITTED: an open attempt keeps the row; staleSnapshot models RR / SERIALIZABLE. */
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
  statuses(): string[] {
    return [...this.reservations.values()].map((r) => r.status);
  }
}
