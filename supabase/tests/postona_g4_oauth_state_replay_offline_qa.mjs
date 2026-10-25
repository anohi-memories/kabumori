// G4-37 (Issue #319): OFFLINE negative QA -- OAuth state one-time consumption, late / duplicate / concurrent callbacks,
// mid-failure and retry, re-attachment to another person or workspace, disconnect / reconnect with an old state, token
// or lease, owner ABA, "result unknown" retries and duplicate claims. No database, no network, fake data only.
// A tiny deterministic model of the row locks the source relies on (UPDATE ... WHERE consumed_at IS NULL waits for the
// holder, then re-checks the committed row -- READ COMMITTED), written from pinned source lines; part 2 checks those
// lines with `git show`. Results are MOCK_PASS (what the source rules decide), never a product PASS.
// The person / workspace decision is EXTERNAL (G5's); this file never decides the canonical personal workspace.
// G4_37_MUTANT=<name> breaks one rule; the run must then FAIL.
// Usage: node supabase/tests/postona_g4_oauth_state_replay_offline_qa.mjs [clone-with-the-pinned-commits]
import { execFileSync } from "node:child_process";

const repo = process.argv[2] ?? process.cwd();
const MUT = process.env.G4_37_MUTANT ?? "";
const PIN = { G4: "b963683b3173bed274843eedd9543889dc8534c5", G5S: "21a5cad4b71de63265db8517da93c6efc60cdde8" };
const F = {
  ws: "supabase/candidates/postona_threads_oauth_workspace_candidate.sql",
  b001: "supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql",
  disc: "supabase/candidates/postona_threads_disconnect/threads_disconnect_candidate.sql",
  rot: "supabase/candidates/postona_threads_publish/threads_credential_rotation_candidate.sql",
  a001: "supabase/candidates/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation.sql",
  oe: "supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql",
};
const A = {
  consumeOnce: ["G4", "ws", 295, "set consumed_at = now()"],
  consumeRefused: ["G4", "ws", 302, "THREADS_OAUTH_STATE_NOT_CONSUMABLE"],
  completeOwner: ["G4", "ws", 292, "THREADS_ACCOUNT_NOT_OWNED"],
  entryInitiator: ["G4", "b001", 251, "THREADS_BINDING_NOT_INITIATOR"],
  entryAttested: ["G4", "b001", 256, "THREADS_BINDING_ALREADY_ATTESTED"],
  entryEpoch: ["G4", "b001", 280, "THREADS_BINDING_OWNER_EPOCH_CHANGED"],
  lastCompletionWins: ["G4", "b001", 291, "on conflict (social_account_id) do update"],
  discStates: ["G4", "disc", 187, "delete from public.social_account_oauth_states s where s.social_account_id = v_account.id"],
  leaseHeld: ["G4", "rot", 234, "LEASE_HELD"],
  leaseSingleUse: ["G4", "rot", 338, "Single use: the same lease can never rotate again"],
  leaseNotHeld: ["G4", "rot", 311, "LEASE_NOT_HELD"],
  aTrigger: ["G4", "a001", 86, "after insert or update or delete on public.threads_account_credential_custody"],
  epochMonotonic: ["G5S", "oe", 264, "set epoch = v_epoch + 1"],
};

// ---------------- model ----------------
const refuse = (code) => ({ ok: false, code });
const ok = (v) => ({ ok: true, v });
function world() {
  return { states: new Map(), epoch: 1, owner: "A", account: { connected: true, token: "fakeTHREADSt0_0123456789", binding: null }, lease: null, nextLease: 1 };
}
// begin (A's personal workspace, decided outside): a state records the initiator and the owner epoch at begin.
function begin(w, user, id, opts = {}) { w.states.set(id, { id, by: user, epoch: w.epoch, expired: !!opts.expired, committed: false, lockedBy: null }); return id; }
// A callback is a transaction: lock+consume the state (waits if another tx holds it), then the rest, then commit or roll back.
function startCallback(w, user, id) {
  const st = w.states.get(id);
  if (!st || st.by !== user) return { done: refuse("THREADS_BINDING_NOT_INITIATOR") };
  if (MUT !== "consume_without_lock" && st.lockedBy) return { waiting: true, user, id }; // row lock held by another tx
  if (MUT !== "consume_without_lock" && (st.committed || st.expired)) return { done: refuse(st.committed ? "THREADS_BINDING_ALREADY_ATTESTED" : "THREADS_OAUTH_STATE_NOT_CONSUMABLE") };
  st.lockedBy = user;
  return { tx: { id, user } };
}
function finishCallback(w, tx, { fail = false, token = "fakeTHREADSnew_0123456789" } = {}) {
  const st = w.states.get(tx.id);
  st.lockedBy = null;
  if (fail) { if (MUT === "rollback_keeps_consumed") st.committed = true; return refuse("ROLLED_BACK"); } // the whole transaction rolls back
  if (w.owner !== tx.user) return refuse("THREADS_ACCOUNT_NOT_OWNED");
  if (MUT !== "epoch_not_compared" && st.epoch !== w.epoch) return refuse("THREADS_BINDING_OWNER_EPOCH_CHANGED");
  st.committed = true;
  w.account = { connected: true, token, binding: st.id };
  if (MUT !== "reconnect_keeps_lease") w.lease = null; // A: a custody write ends the lease
  return ok("connected");
}
// A waiting tx resumes after the holder ended: re-checks the committed row (READ COMMITTED).
function resume(w, waiter) { return startCallback(w, waiter.user, waiter.id); }
const callback = (w, user, id, opts) => { const s = startCallback(w, user, id); return s.done ?? finishCallback(w, s.tx, opts); };
function disconnect(w) {
  w.account = { connected: false, token: null, binding: null };
  if (MUT !== "disconnect_keeps_states") w.states.clear();
  w.lease = null;
}
// The owner epoch only moves forward (G5 OE). The mutant derives it from the owner, so A -> B -> A returns to the old value.
function changeOwner(w, owner) { w.owner = owner; w.epoch = MUT === "epoch_not_monotonic" ? (owner === "A" ? 1 : 2) : w.epoch + 1; }
function claim(w) {
  if (!w.account.connected) return refuse("ACCOUNT_NOT_FOUND");
  if (w.lease) return refuse("LEASE_HELD");
  w.lease = { id: w.nextLease++, binding: w.account.binding, token: w.account.token };
  return ok(w.lease);
}
function rotate(w, lease, { lost = false } = {}) {
  if (!w.lease || w.lease.id !== lease.id) return refuse("LEASE_NOT_HELD");
  if (MUT !== "lease_not_single_use") w.lease = null;
  w.account.token = "fakeTHREADSrefreshed_0123456789";
  return lost ? { ok: true, v: "rotated", lost: true } : ok("rotated");
}

// ---------------- cases ----------------
const results = [];
const check = (name, fn) => { try { results.push({ name, v: "MOCK_PASS", note: fn() }); } catch (e) { results.push({ name, v: "FAIL", note: e.message }); } };
const want = (r, code, label) => { if (r.ok || r.code !== code) throw new Error(`${label}: want ${code}, got ${r.ok ? "ok" : r.code}`); };
const yes = (r, label) => { if (!r.ok) throw new Error(`${label}: ${r.code}`); };

check("R1 two concurrent callbacks, same state: exactly one connects", () => {
  const w = world(); begin(w, "A", "s1");
  const t1 = startCallback(w, "A", "s1"); const t2 = startCallback(w, "A", "s1");
  if (!t1.tx || !t2.waiting) throw new Error("the second must wait on the row lock");
  yes(finishCallback(w, t1.tx), "first"); want(resume(w, t2).done ?? refuse("NOT_REFUSED"), "THREADS_BINDING_ALREADY_ATTESTED", "second after commit");
});
check("R2 the first callback fails mid-way and rolls back: the waiting retry connects", () => {
  const w = world(); begin(w, "A", "s2");
  const t1 = startCallback(w, "A", "s2"); const t2 = startCallback(w, "A", "s2");
  want(finishCallback(w, t1.tx, { fail: true }), "ROLLED_BACK", "first");
  const r = resume(w, t2); if (!r.tx) throw new Error(`retry should acquire the state: ${JSON.stringify(r)}`); yes(finishCallback(w, r.tx), "retry");
});
check("R3 late callback (expired state)", () => { const w = world(); begin(w, "A", "s3", { expired: true }); want(callback(w, "A", "s3"), "THREADS_OAUTH_STATE_NOT_CONSUMABLE", "late"); });
check("R4 duplicate callback after success (result unknown, H5 retries)", () => {
  const w = world(); begin(w, "A", "s4"); yes(callback(w, "A", "s4"), "first");
  want(callback(w, "A", "s4"), "THREADS_BINDING_ALREADY_ATTESTED", "retry");
  if (w.account.binding !== "s4") throw new Error("the binding must say the first one connected (resolve by reading it)");
  return "a retry after an unknown result is refused; H5 resolves by reading the binding / connection state";
});
check("R5 another person uses A's state", () => { const w = world(); begin(w, "A", "s5"); want(callback(w, "B", "s5"), "THREADS_BINDING_NOT_INITIATOR", "B"); });
check("R6 ownership moved between begin and callback (old workspace)", () => { const w = world(); begin(w, "A", "s6"); changeOwner(w, "B"); want(callback(w, "A", "s6"), "THREADS_ACCOUNT_NOT_OWNED", "callback"); });
check("R7 owner ABA (A -> B -> A) with a state from the first epoch", () => {
  const w = world(); begin(w, "A", "s7"); changeOwner(w, "B"); changeOwner(w, "A");
  want(callback(w, "A", "s7"), "THREADS_BINDING_OWNER_EPOCH_CHANGED", "ABA"); });
check("R8 disconnect, then the pre-disconnect state's callback", () => { const w = world(); begin(w, "A", "s8"); disconnect(w); want(callback(w, "A", "s8"), "THREADS_BINDING_NOT_INITIATOR", "old state"); });
check("R9 disconnect / reconnect: the old lease and the old token", () => {
  const w = world(); const l = claim(w).v; const old = w.account.token; disconnect(w); begin(w, "A", "s9"); yes(callback(w, "A", "s9"), "reconnect");
  want(rotate(w, l), "LEASE_NOT_HELD", "old lease"); if (w.account.token === old) throw new Error("old token still current"); });
check("R10 reconnect while a refresh lease is held", () => { const w = world(); const l = claim(w).v; begin(w, "A", "s10"); yes(callback(w, "A", "s10"), "reconnect"); want(rotate(w, l), "LEASE_NOT_HELD", "old lease"); });
check("R11 older pending state completes after a newer one (last completion wins)", () => {
  const w = world(); begin(w, "A", "old"); begin(w, "A", "new"); yes(callback(w, "A", "new"), "new"); const l = claim(w).v; yes(callback(w, "A", "old"), "old later");
  if (w.account.binding !== "old") throw new Error("binding should move to the later completion"); want(rotate(w, l), "LEASE_NOT_HELD", "lease of the newer connect");
  return "documented behavior (G4-14): the later completion wins; any lease taken before it ends"; });
check("R12 duplicate claims (two workers)", () => { const w = world(); yes(claim(w), "first"); want(claim(w), "LEASE_HELD", "second"); });
check("R13 rotate result lost, worker retries with the same lease", () => {
  const w = world(); const l = claim(w).v; const r = rotate(w, l, { lost: true }); yes(r, "first");
  want(rotate(w, l), "LEASE_NOT_HELD", "retry"); return "a retry after an unknown result is refused; the worker re-reads custody to learn the outcome"; });
check("R14 normal path", () => { const w = world(); begin(w, "A", "s14"); yes(callback(w, "A", "s14"), "connect"); const l = claim(w).v; yes(rotate(w, l), "rotate"); });

// ---------------- source anchors ----------------
let found = 0; const missing = []; const cache = {};
for (const [name, [pin, file, line, text]] of Object.entries(A)) {
  const key = `${pin}:${file}`;
  if (!(key in cache)) { try { cache[key] = execFileSync("git", ["-C", repo, "show", `${PIN[pin]}:${F[file]}`], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n"); } catch { cache[key] = null; } }
  if (cache[key]?.[line - 1]?.includes(text)) found++; else missing.push(`${name} ${pin}:${F[file]}:L${line}`);
}
for (const r of results) console.log(`${r.v.padEnd(9)} ${r.name}${r.note ? ` -- ${r.note}` : ""}`);
console.log(`SOURCE anchors ${found}/${Object.keys(A).length}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
if (results.some((r) => r.v !== "MOCK_PASS") || missing.length) { console.log("POSTONA_G4_OAUTH_STATE_REPLAY_OFFLINE_QA_FAIL"); process.exit(1); }
console.log(`POSTONA_G4_OAUTH_STATE_REPLAY_OFFLINE_QA_MOCK_PASS (${results.length} cases; MOCK only -- runtime SOURCE_NOT_VERIFIED, no DB / network / OAuth)`);
