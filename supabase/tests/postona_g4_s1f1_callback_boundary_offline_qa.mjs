// G4-38 (Issue #319): OFFLINE cross-boundary negative QA -- G4's X begin / Threads begin and callback against an EXTERNAL
// authorization verdict (G5's personal-workspace eligibility, PR #506 candidate) and session gate (T13 now / T13S of
// S2-1, candidate), plus late callbacks, owner ABA, reconnect, result-unknown and duplicate callbacks.
// No database, no network, fake data only. Results are MOCK_PASS (what the pinned source rules / proposals decide) and
// are labelled CURRENT (G4's source today), PROPOSED (needs a G5 / G3 / G4 change) or GAP; never a product PASS.
// G4 does not decide the canonical personal workspace: the verdict is passed in.
// G4_38_MUTANT=<name> breaks one rule; the run must then FAIL.
// Usage: node supabase/tests/postona_g4_s1f1_callback_boundary_offline_qa.mjs [clone-with-the-pinned-commits]
import { execFileSync } from "node:child_process";

const repo = process.argv[2] ?? process.cwd();
const MUT = process.env.G4_38_MUTANT ?? "";
const PIN = { main: "0c42933ca5030ab31a56267529430d0473d9b155", G4: "b963683b3173bed274843eedd9543889dc8534c5",
              G5E: "bbc52a6b78efd9eb4b174f7fbb6835162a631659" }; // G5E = PR #506 (S2-3 eligibility, candidate)
const F = {
  xLive: "supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql",
  ws: "supabase/candidates/postona_threads_oauth_workspace_candidate.sql",
  b001: "supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql",
  rot: "supabase/candidates/postona_threads_publish/threads_credential_rotation_candidate.sql",
  elig: "supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility.sql",
};
const A = {
  xReuse: ["main", "xLive", 34, "if v_owner_brand_count = 1 then"],
  xJoinBrand: ["main", "xLive", 42, "on conflict (id) do nothing"],
  xJoinMember: ["main", "xLive", 45, "on conflict on constraint brand_memberships_pkey do nothing"],
  xNoT13: ["main", "xLive", 15, "v_user_id uuid := auth.uid()"],
  provConflict: ["G4", "ws", 150, "SOCIAL_MOBILE_WORKSPACE_CONFLICT"],
  provShared: ["G4", "ws", 165, "SOCIAL_MOBILE_WORKSPACE_SHARED"],
  beginT13: ["G4", "ws", 191, "account_lifecycle_assert_active_service_write(v_user, 'x_autopost')"],
  completeOwner: ["G4", "ws", 292, "THREADS_ACCOUNT_NOT_OWNED"],
  consumeOnce: ["G4", "ws", 302, "THREADS_OAUTH_STATE_NOT_CONSUMABLE"],
  entryInitiator: ["G4", "b001", 251, "THREADS_BINDING_NOT_INITIATOR"],
  entryAttested: ["G4", "b001", 256, "THREADS_BINDING_ALREADY_ATTESTED"],
  entryEpoch: ["G4", "b001", 280, "THREADS_BINDING_OWNER_EPOCH_CHANGED"],
  leaseNotHeld: ["G4", "rot", 311, "LEASE_NOT_HELD"],
  eligFn: ["G5E", "elig", 99, "create function private.postona_personal_workspace_eligibility(p_user uuid)"],
  eligUnknown: ["G5E", "elig", 135, "'WORKSPACE_OWNER_UNKNOWN'"],
  eligMembers: ["G5E", "elig", 137, "f_member_count <> 1 then 'OWN_WORKSPACE_CONFLICT'"],
  eligOther: ["G5E", "elig", 138, "f_other_owned then 'OWN_WORKSPACE_CONFLICT'"],
};

// ---------------- model ----------------
const refuse = (code, label = "CURRENT") => ({ ok: false, code, label });
const ok = (v, label = "CURRENT") => ({ ok: true, v, label });
// EXTERNAL verdict (G5, PR #506 L133-L138 as a candidate): 'absent' | 'own' | 'OWN_WORKSPACE_CONFLICT' | 'WORKSPACE_OWNER_UNKNOWN'.
function eligibility(w, user) {
  const ws = `u_${user}`;
  const other = w.members.some((m) => m.user === user && m.role === "owner" && m.brand !== ws);
  const onWs = w.members.filter((m) => m.brand === ws);
  if (!w.brands[ws] && onWs.length === 0) return other ? "OWN_WORKSPACE_CONFLICT" : "absent";
  if (!w.brands[ws]) return "OWN_WORKSPACE_CONFLICT";
  if (w.brands[ws] !== "social_mobile_user_v1") return "OWN_WORKSPACE_CONFLICT";
  const owners = onWs.filter((m) => m.role === "owner");
  if (owners.length !== 1) return "WORKSPACE_OWNER_UNKNOWN";
  if (owners[0].user !== user) return "OWN_WORKSPACE_CONFLICT";
  if (MUT !== "verdict_ignores_members" && onWs.length !== 1) return "OWN_WORKSPACE_CONFLICT";
  if (other) return "OWN_WORKSPACE_CONFLICT";
  return "own";
}
// Session gate: T13 today lets an anonymous session through (G5 S1-F2); T13S (S2-1, candidate) refuses it.
function gate(s, version) {
  if (s.state !== "active") return refuse("ACCOUNT_LIFECYCLE_AUTH_REQUIRED");
  if (s.anonymous && (version === "T13S" && MUT !== "t13s_lets_anonymous")) return refuse("ACCOUNT_LIFECYCLE_AUTH_REQUIRED", "PROPOSED");
  return ok(s.user);
}
function world() { return { brands: {}, members: [], states: new Map(), epoch: 1, owner: "A", binding: null, lease: null, xBinding: null }; }
// Threads begin with the external verdict wired (PROPOSED): only 'absent' / 'own' proceed; 'absent' creates u_ and a
// concurrent row under the id is a refusal, never a join.
function threadsBegin(w, s, id, { gateVersion = "T13", concurrentRow = false } = {}) {
  const g = gate(s, gateVersion); if (!g.ok) return g;
  const v = eligibility(w, s.user);
  if (v === "WORKSPACE_OWNER_UNKNOWN" && MUT !== "begin_treats_unknown_as_allow") return refuse(v, "PROPOSED");
  if (v === "OWN_WORKSPACE_CONFLICT") return refuse(v, "PROPOSED");
  const ws = `u_${s.user}`;
  if (v === "absent") {
    if (concurrentRow && MUT !== "absent_joins_on_conflict") return refuse("OWN_WORKSPACE_CONFLICT", "PROPOSED");
    w.brands[ws] ??= "social_mobile_user_v1"; w.members.push({ brand: ws, user: s.user, role: "owner" });
  }
  w.states.set(id, { by: s.user, epoch: w.epoch, consumed: false, expired: false });
  return ok(ws, "PROPOSED");
}
// X begin as live on main (G4): no gate, any single owned brand re-used, the derived id joined with "on conflict".
function xBeginLive(w, s) {
  const owned = w.members.filter((m) => m.user === s.user && m.role === "owner").map((m) => m.brand);
  if (owned.length > 1) return refuse("SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED");
  if (owned.length === 1) return ok(owned[0]);
  const ws = `u_${s.user}`; w.brands[ws] ??= "social_mobile_user_v1";
  if (!w.members.some((m) => m.brand === ws && m.user === s.user)) w.members.push({ brand: ws, user: s.user, role: "owner" });
  return ok(ws);
}
function callback(w, s, id, { gateVersion = "T13", recheckVerdict = false } = {}) {
  const st = w.states.get(id);
  if (!st || st.by !== s.user) return refuse("THREADS_BINDING_NOT_INITIATOR");
  if (st.consumed && w.binding === id) return refuse("THREADS_BINDING_ALREADY_ATTESTED");
  const g = gate(s, gateVersion); if (!g.ok) return g;
  if (recheckVerdict) { const v = eligibility(w, s.user); if (v !== "own") return refuse(v, "PROPOSED"); }
  if (w.owner !== s.user) return refuse("THREADS_ACCOUNT_NOT_OWNED");
  if (st.consumed || st.expired) return refuse("THREADS_OAUTH_STATE_NOT_CONSUMABLE");
  if (MUT !== "callback_skips_epoch" && st.epoch !== w.epoch) return refuse("THREADS_BINDING_OWNER_EPOCH_CHANGED");
  st.consumed = true; w.binding = id; w.lease = null;
  return ok("connected");
}
// Reading the outcome after "result unknown" (PROPOSED: under the same session gate as the callback).
function readOutcome(w, s, id, { gateVersion = "T13" } = {}) {
  if (MUT !== "outcome_read_skips_session") { const g = gate(s, gateVersion); if (!g.ok) return { ...g, label: "PROPOSED" }; }
  return ok(w.binding === id ? "connected" : "not_connected", "PROPOSED");
}
const reown = (w, owner) => { w.owner = owner; w.epoch += 1; };
const S = (user, extra = {}) => ({ user, state: "active", anonymous: false, ...extra });

// ---------------- cases ----------------
const results = [];
const check = (name, fn) => { try { results.push({ name, v: "MOCK_PASS", note: fn() }); } catch (e) { results.push({ name, v: "FAIL", note: e.message }); } };
const want = (r, code, label) => { if (r.ok || r.code !== code) throw new Error(`${label}: want ${code}, got ${r.ok ? "ok:" + r.v : r.code}`); };
const yes = (r, label) => { if (!r.ok) throw new Error(`${label}: ${r.code}`); return r; };

check("B1 verdict ALLOW (absent -> creates u_, then own)", () => { const w = world(); yes(threadsBegin(w, S("A"), "s1"), "absent"); yes(threadsBegin(w, S("A"), "s1b"), "own"); });
check("B2 verdict DENY (legacy brand) -> no workspace, no state", () => {
  const w = world(); w.members.push({ brand: "L", user: "A", role: "owner" });
  want(threadsBegin(w, S("A"), "s2"), "OWN_WORKSPACE_CONFLICT", "begin"); if (w.states.size || w.brands.u_A) throw new Error("wrote something");
  const x = xBeginLive(w, S("A")); if (!x.ok || x.v !== "L") throw new Error("X live should still bind L");
  return "PROPOSED refusal; CURRENT X live binds the legacy brand (S1-F1, unchanged)"; });
check("B3 verdict UNKNOWN (two owners on u_) -> fail closed", () => {
  const w = world(); w.brands.u_A = "social_mobile_user_v1"; w.members.push({ brand: "u_A", user: "A", role: "owner" }, { brand: "u_A", user: "B", role: "owner" });
  want(threadsBegin(w, S("A"), "s3"), "WORKSPACE_OWNER_UNKNOWN", "begin"); });
check("B4 another member on u_ -> DENY (G5 S2-3 L137; G4-36's r0Proposed missed this)", () => {
  const w = world(); w.brands.u_A = "social_mobile_user_v1"; w.members.push({ brand: "u_A", user: "A", role: "owner" }, { brand: "u_A", user: "B", role: "admin" });
  want(threadsBegin(w, S("A"), "s4"), "OWN_WORKSPACE_CONFLICT", "begin"); });
check("B5 'absent' but a row appears concurrently -> refuse, never join", () => { const w = world(); want(threadsBegin(w, S("A"), "s5", { concurrentRow: true }), "OWN_WORKSPACE_CONFLICT", "begin"); });
check("B6 X live joins a derived row it did not create (G5 C2/C3)", () => {
  const w = world(); w.brands.u_A = "legacy_kind"; w.members.push({ brand: "u_A", user: "Z", role: "owner" });
  const x = xBeginLive(w, S("A")); if (!x.ok || !w.members.some((m) => m.brand === "u_A" && m.user === "A" && m.role === "owner")) throw new Error("expected the live join");
  want(threadsBegin(w, S("A"), "s6"), "OWN_WORKSPACE_CONFLICT", "Threads with the verdict");
  return "GAP (CURRENT X live): joins u_A as a second owner; PROPOSED verdict refuses"; });
check("B7 anonymous session: T13 now passes, T13S refuses", () => {
  const w = world(); yes(threadsBegin(w, S("A", { anonymous: true }), "s7"), "T13 now");
  want(threadsBegin(world(), S("A", { anonymous: true }), "s7b", { gateVersion: "T13S" }), "ACCOUNT_LIFECYCLE_AUTH_REQUIRED", "T13S");
  return "GAP until S2-1 is applied (candidate, not wired)"; });
check("B8 session revoked between begin and callback", () => { const w = world(); threadsBegin(w, S("A"), "s8"); want(callback(w, S("A", { state: "revoked" }), "s8"), "ACCOUNT_LIFECYCLE_AUTH_REQUIRED", "callback"); });
check("B9 late callback by another user", () => { const w = world(); threadsBegin(w, S("A"), "s9"); want(callback(w, S("B"), "s9"), "THREADS_BINDING_NOT_INITIATOR", "B"); });
check("B10 A gains another brand after begin: callback re-check (PROPOSED) vs current", () => {
  const w = world(); threadsBegin(w, S("A"), "s10"); w.members.push({ brand: "L2", user: "A", role: "owner" });
  const now = callback(structuredClone(w), S("A"), "s10"); if (!now.ok) throw new Error("CURRENT complete only checks the u_ owner");
  want(callback(w, S("A"), "s10", { recheckVerdict: true }), "OWN_WORKSPACE_CONFLICT", "re-check");
  return "CURRENT connects (complete checks only the u_ owner); PROPOSED re-check at callback refuses -- question to G5"; });
check("B11 owner ABA between begin and callback (Threads)", () => { const w = world(); threadsBegin(w, S("A"), "s11"); reown(w, "B"); reown(w, "A"); want(callback(w, S("A"), "s11"), "THREADS_BINDING_OWNER_EPOCH_CHANGED", "ABA"); });
check("B12 duplicate callback after an unknown result; outcome read under the session gate", () => {
  const w = world(); threadsBegin(w, S("A"), "s12"); yes(callback(w, S("A"), "s12"), "first");
  want(callback(w, S("A"), "s12"), "THREADS_BINDING_ALREADY_ATTESTED", "retry");
  if (yes(readOutcome(w, S("A"), "s12"), "outcome").v !== "connected") throw new Error("outcome");
  want(readOutcome(w, S("A", { state: "revoked" }), "s12"), "ACCOUNT_LIFECYCLE_AUTH_REQUIRED", "outcome after logout"); });
check("B13 reconnect ends the old lease", () => { const w = world(); threadsBegin(w, S("A"), "a"); callback(w, S("A"), "a"); w.lease = { id: 1 }; threadsBegin(w, S("A"), "b"); yes(callback(w, S("A"), "b"), "reconnect");
  if (w.lease) throw new Error("old lease survived"); });

// ---------------- source anchors ----------------
let found = 0; const missing = []; const cache = {};
for (const [name, [pin, file, line, text]] of Object.entries(A)) {
  const key = `${pin}:${file}`;
  if (!(key in cache)) { try { cache[key] = execFileSync("git", ["-C", repo, "show", `${PIN[pin]}:${F[file]}`], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n"); } catch { cache[key] = null; } }
  if (cache[key]?.[line - 1]?.includes(text)) found++; else missing.push(`${name} ${pin}:${F[file]}:L${line}`);
}
for (const r of results) console.log(`${r.v.padEnd(9)} ${r.name}${r.note ? ` -- ${r.note}` : ""}`);
console.log(`SOURCE anchors ${found}/${Object.keys(A).length}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
if (results.some((r) => r.v !== "MOCK_PASS") || missing.length) { console.log("POSTONA_G4_S1F1_CALLBACK_BOUNDARY_OFFLINE_QA_FAIL"); process.exit(1); }
console.log(`POSTONA_G4_S1F1_CALLBACK_BOUNDARY_OFFLINE_QA_MOCK_PASS (${results.length} cases; MOCK only -- runtime SOURCE_NOT_VERIFIED, no DB / network / OAuth)`);
