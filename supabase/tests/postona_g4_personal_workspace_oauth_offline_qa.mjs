// G4-36 (Issue #319): OFFLINE negative QA of G4's personal-workspace / OAuth callback / epoch / custody contract.
// No database, no network, fake principals / workspaces / tokens only. Two parts:
//   1. a MODEL of the decision points, each written from a pinned source line (part 2 checks those lines exist);
//      results are MOCK_PASS -- they show what the source rules decide for each case, NOT that any product runs so.
//   2. SOURCE anchors: every rule the model encodes is matched against the pinned commit with `git show` (local repo).
// G5's R0 is an EXTERNAL decision passed in as a parameter (r0Current = the pinned G5 candidate, r0Proposed = G5's
// rule proposal of PR #477 section 4.1); G4 does not decide the canonical "one personal workspace".
// Usage: node supabase/tests/postona_g4_personal_workspace_oauth_offline_qa.mjs [path-to-a-clone-with-the-pinned-commits]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const repo = process.argv[2] ?? process.cwd();
// Negative controls: G4_36_MUTANT=<name> breaks one rule; the run must then FAIL.
const MUT = process.env.G4_36_MUTANT ?? "";
const PIN = {
  main: "0c42933ca5030ab31a56267529430d0473d9b155",
  G4: "b963683b3173bed274843eedd9543889dc8534c5", // PR #482 head (PR #124 file, 001/002, rotation, 004/005)
  G4X: "39ab57ab", // X OAuth v2 candidate (G4)
  G5S: "21a5cad4b71de63265db8517da93c6efc60cdde8", // PR #457 head (T13, R0)
  G3X: "6aae11a2b1686b5ec34c9b96f263468e2b28ecb4", // X reservations (G3)
};
const F = {
  xLive: "supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql",
  ws: "supabase/candidates/postona_threads_oauth_workspace_candidate.sql",
  b001: "supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql",
  disc: "supabase/candidates/postona_threads_disconnect/threads_disconnect_candidate.sql",
  rot: "supabase/candidates/postona_threads_publish/threads_credential_rotation_candidate.sql",
  xv2: "supabase/candidates/postona_x_oauth_hardening_candidate.sql",
  t13: "supabase/migrations/20261010051938_common_account_service_write_guard.sql",
  r0: "supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql",
  g3x: "supabase/candidates/postona_x_reservations/001_postona_x_reservations.sql",
  del: "supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql",
};
// [pin, file, line, text that must be on that line] -- the rule the model encodes.
const A = {
  xCount: ["main", "xLive", 27, "select count(*) into v_owner_brand_count"],
  xMulti: ["main", "xLive", 31, "SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED"],
  xReuse: ["main", "xLive", 34, "if v_owner_brand_count = 1 then"],
  xCreate: ["main", "xLive", 39, "v_brand_id := 'u_'"],
  wsId: ["main", "del", 100, "'u_' || substr(md5(p_user_id::text), 1, 24)"],
  provT13: ["G4", "ws", 139, "account_lifecycle_assert_active_service_write(p_user_id, 'x_autopost')"],
  provDel: ["G4", "ws", 145, "SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS"],
  provConflict: ["G4", "ws", 150, "SOCIAL_MOBILE_WORKSPACE_CONFLICT"],
  provKind: ["G4", "ws", 158, "SOCIAL_MOBILE_WORKSPACE_NOT_SELF_SERVICE"],
  provShared: ["G4", "ws", 165, "SOCIAL_MOBILE_WORKSPACE_SHARED"],
  xv2Prov: ["G4X", "xv2", 179, "private.social_mobile_ensure_personal_workspace(v_user)"],
  beginExpiry: ["G4", "ws", 188, "interval '10 minutes'"],
  beginT13: ["G4", "ws", 191, "account_lifecycle_assert_active_service_write(v_user, 'x_autopost')"],
  beginProv: ["G4", "ws", 193, "private.social_mobile_ensure_personal_workspace(v_user)"],
  beginDupState: ["G4", "ws", 214, "exception when unique_violation then"],
  completeT13: ["G4", "ws", 270, "account_lifecycle_assert_active_service_write(v_user, 'x_autopost')"],
  completeHmac: ["G4", "ws", 283, "THREADS_CONNECT_ATTESTATION_INVALID"],
  completeOwner: ["G4", "ws", 292, "THREADS_ACCOUNT_NOT_OWNED"],
  completeConsume: ["G4", "ws", 295, "set consumed_at = now()"],
  completeOnce: ["G4", "ws", 302, "THREADS_OAUTH_STATE_NOT_CONSUMABLE"],
  completeIdentity: ["G4", "ws", 307, "THREADS_IDENTITY_ACCOUNT_MISMATCH"],
  entryInitiator: ["G4", "b001", 251, "THREADS_BINDING_NOT_INITIATOR"],
  entryAttested: ["G4", "b001", 256, "THREADS_BINDING_ALREADY_ATTESTED"],
  entryEpoch: ["G4", "b001", 280, "THREADS_BINDING_OWNER_EPOCH_CHANGED"],
  entryGeneration: ["G4", "b001", 283, "THREADS_BINDING_SERVICE_GENERATION_CHANGED"],
  discStates: ["G4", "disc", 187, "delete from public.social_account_oauth_states s where s.social_account_id = v_account.id"],
  leaseHeld: ["G4", "rot", 234, "LEASE_HELD"],
  leaseNotHeld: ["G4", "rot", 311, "LEASE_NOT_HELD"],
  t13Principal: ["G5S", "t13", 118, "ACCOUNT_LIFECYCLE_AUTH_REQUIRED"],
  t13Locked: ["G5S", "t13", 133, "ACCOUNT_LOCKED"],
  t13Live: ["G5S", "t13", 156, "s.not_after is null or s.not_after > clock_timestamp()"],
  r0Anon: ["G5S", "r0", 144, "v_anonymous = 'false'"],
  r0Ws: ["G5S", "r0", 157, "v_workspace := 'u_'"],
  r0Kind: ["G5S", "r0", 209, "f_ws_kind is distinct from 'social_mobile_user_v1'"],
  g3Brand: ["G3X", "g3x", 188, "select sa.brand_id, sa.platform into v_brand"],
};

// ---------------- the model (fake data only) ----------------
const wsOf = (user) => "u_" + createHash("md5").update(user).digest("hex").slice(0, 24); // A.wsId
const refuse = (code, anchors) => ({ ok: false, code, anchors });
const okv = (value, anchors) => ({ ok: true, value, anchors });

// T13 (G5): principal + live session + account state. It does NOT look at is_anonymous today (G5's S1-F2).
function t13(w, s) {
  if (!s || s.user == null || s.role !== "authenticated" || s.claims === "mixed") return refuse("ACCOUNT_LIFECYCLE_AUTH_REQUIRED", ["t13Principal"]);
  if (s.session !== "active") return refuse("ACCOUNT_LIFECYCLE_AUTH_REQUIRED", ["t13Live"]);
  if (w.accounts[s.user] !== "active") return refuse("ACCOUNT_LOCKED", ["t13Locked"]);
  return okv(s.user, ["t13Principal", "t13Live"]);
}
const owned = (w, user) => w.memberships.filter((m) => m.user === user && m.role === "owner").map((m) => m.brand);
// X begin as live on main: any single owned brand is re-used; no T13, no R0.
function xBeginLive(w, s) {
  const o = owned(w, s.user);
  if (o.length > 1) return refuse("SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED", ["xCount", "xMulti"]);
  if (o.length === 1) return okv(o[0], ["xReuse"]);
  return okv(wsOf(s.user), ["xCreate"]);
}
// PR #124's provisioner (also G4's X v2): T13, u_<md5>, social_mobile_user_v1, sole owner, no other owned brand.
function provision(w, s) {
  const g = t13(w, s); if (!g.ok) return g;
  const ws = wsOf(s.user);
  if (w.deletions.includes(s.user)) return refuse("SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS", ["provDel"]);
  if (MUT !== "provisioner_ignores_other_brands" && owned(w, s.user).some((b) => b !== ws)) return refuse("SOCIAL_MOBILE_WORKSPACE_CONFLICT", ["provConflict"]);
  if (w.brands[ws] && w.brands[ws] !== "social_mobile_user_v1") return refuse("SOCIAL_MOBILE_WORKSPACE_NOT_SELF_SERVICE", ["provKind"]);
  if (w.memberships.some((m) => m.brand === ws && m.user !== s.user)) return refuse("SOCIAL_MOBILE_WORKSPACE_SHARED", ["provShared"]);
  // As the source: create the workspace (on conflict do nothing) and the caller's owner membership.
  w.brands[ws] ??= "social_mobile_user_v1";
  if (!w.memberships.some((m) => m.brand === ws && m.user === s.user)) w.memberships.push({ brand: ws, user: s.user, role: "owner" });
  return okv(ws, ["provT13", "provConflict", "provKind", "provShared"]);
}
// G5's R0, EXTERNAL: the pinned candidate looks only at u_<md5>; the proposal (PR #477 4.1) adds "owns no other brand".
const r0Current = (w, s) => {
  if (s.anonymous) return { decision: "deny", reason: "AUTH_REQUIRED", anchors: ["r0Anon"] };
  const ws = wsOf(s.user);
  if (!w.brands[ws]) return { decision: "allow", anchors: ["r0Ws"] };
  if (w.brands[ws] !== "social_mobile_user_v1") return { decision: "deny", reason: "OWN_WORKSPACE_CONFLICT", anchors: ["r0Kind"] };
  const owners = w.memberships.filter((m) => m.brand === ws && m.role === "owner").map((m) => m.user);
  if (owners.length !== 1) return { decision: "unknown", reason: "WORKSPACE_OWNER_UNKNOWN", anchors: ["r0Kind"] };
  return { decision: owners[0] === s.user ? "allow" : "deny", anchors: ["r0Ws"] };
};
const r0Proposed = (w, s) => {
  const v = r0Current(w, s);
  if (v.decision === "allow" && owned(w, s.user).some((b) => b !== wsOf(s.user))) return { decision: "deny", reason: "OWN_WORKSPACE_CONFLICT", anchors: ["r0Ws"] };
  return v;
};
// Threads begin: T13 -> provisioner -> state (unique hash, expiry within 10 minutes).
function beginThreads(w, s, hash, minutes = 5) {
  if (minutes > 10 || minutes <= 0) return refuse("THREADS_OAUTH_STATE_INPUT_INVALID", ["beginExpiry"]);
  const g = t13(w, s); if (!g.ok) return g;
  const p = provision(w, s); if (!p.ok) return p;
  if (w.states.some((x) => x.hash === hash)) return refuse("THREADS_OAUTH_STATE_INPUT_INVALID", ["beginDupState"]);
  const st = { id: `st_${w.states.length + 1}`, hash, ws: p.value, by: s.user, consumed: false, expired: false,
               epoch: w.epoch[p.value] ?? 1, generation: w.generation[s.user] ?? 1 };
  w.states.push(st);
  return okv(st, ["beginT13", "beginProv", "beginExpiry"]);
}
// Callback through the 001 entry -> PR #124 complete -> custody.
function callback(w, s, stateId, { attested = true, threadsUser = "17841400000000001", token = "fakeTHREADStoken_0123456789" } = {}) {
  const st = w.states.find((x) => x.id === stateId);
  if (!st || st.by !== s.user) return refuse("THREADS_BINDING_NOT_INITIATOR", ["entryInitiator"]);
  if (MUT !== "state_not_one_time" && st.consumed && w.bindings[st.ws]?.state === st.id) return refuse("THREADS_BINDING_ALREADY_ATTESTED", ["entryAttested"]);
  const g = t13(w, s); if (!g.ok) return g;
  if (!attested) return refuse("THREADS_CONNECT_ATTESTATION_INVALID", ["completeHmac"]);
  if (!w.memberships.some((m) => m.brand === wsOf(s.user) && m.user === s.user && m.role === "owner")) return refuse("THREADS_ACCOUNT_NOT_OWNED", ["completeOwner"]);
  if (MUT !== "state_not_one_time" && (st.consumed || st.expired)) return refuse("THREADS_OAUTH_STATE_NOT_CONSUMABLE", ["completeConsume", "completeOnce"]);
  const acct = w.threads[st.ws];
  if (acct?.threadsUser && acct.threadsUser !== threadsUser) return refuse("THREADS_IDENTITY_ACCOUNT_MISMATCH", ["completeIdentity"]);
  if (MUT !== "epoch_not_checked" && (w.epoch[st.ws] ?? 1) !== st.epoch) return refuse("THREADS_BINDING_OWNER_EPOCH_CHANGED", ["entryEpoch"]);
  if ((w.generation[s.user] ?? 1) !== st.generation) return refuse("THREADS_BINDING_SERVICE_GENERATION_CHANGED", ["entryGeneration"]);
  st.consumed = true;
  w.threads[st.ws] = { threadsUser, token, connected: true };
  w.bindings[st.ws] = { state: st.id };
  if (MUT !== "reconnect_keeps_lease") w.lease[st.ws] = undefined; // A: a custody write ends the lease
  return okv(st.ws, ["entryInitiator", "completeConsume", "entryEpoch"]);
}
function disconnect(w, ws) { w.threads[ws] = undefined; w.states = w.states.filter((x) => x.ws !== ws); w.bindings[ws] = undefined; w.lease[ws] = undefined; }
function claim(w, ws) {
  if (!w.threads[ws]?.connected) return refuse("ACCOUNT_NOT_FOUND", ["discStates"]);
  if (w.lease[ws]) return refuse("LEASE_HELD", ["leaseHeld"]);
  w.lease[ws] = { id: `l_${Math.random()}`, binding: w.bindings[ws]?.state };
  return okv(w.lease[ws], ["leaseHeld"]);
}
function rotate(w, ws, lease) {
  if (!w.lease[ws] || w.lease[ws].id !== lease.id) return refuse("LEASE_NOT_HELD", ["leaseNotHeld"]);
  w.lease[ws] = undefined;
  return okv("rotated", ["leaseNotHeld"]);
}

// ---------------- the cases ----------------
const U = { a: "00000000-0000-4000-8000-0000000000a1", b: "00000000-0000-4000-8000-0000000000b2" };
const sess = (user, extra = {}) => ({ user, role: "authenticated", session: "active", claims: "json", anonymous: false, ...extra });
const world = () => ({ accounts: { [U.a]: "active", [U.b]: "active" }, memberships: [], brands: {}, deletions: [], states: [], threads: {},
                       bindings: {}, lease: {}, epoch: {}, generation: {} });
const results = [];
function check(name, fn) {
  try { const note = fn(); results.push({ name, verdict: "MOCK_PASS", note }); }
  catch (e) { results.push({ name, verdict: "FAIL", note: e.message }); }
}
const expect = (got, code, label) => { if (got.ok || got.code !== code) throw new Error(`${label}: expected ${code}, got ${JSON.stringify(got.ok ? got.value : got.code)}`); };
const connected = (w, user) => { const b = beginThreads(w, sess(user), `h_${user}_${w.states.length}`); if (!b.ok) throw new Error(`setup begin ${b.code}`); const c = callback(w, sess(user), b.value.id); if (!c.ok) throw new Error(`setup callback ${c.code}`); return c.value; };

check("N1 another user's state", () => { const w = world(); const b = beginThreads(w, sess(U.a), "h1"); expect(callback(w, sess(U.b), b.value.id), "THREADS_BINDING_NOT_INITIATOR", "callback"); });
check("N2 legacy single brand: X live vs provisioner vs R0 (S1-F1)", () => {
  const w = world(); w.memberships.push({ brand: "legacy_L", user: U.a, role: "owner" }); w.brands.legacy_L = "legacy";
  const x = xBeginLive(w, sess(U.a)); if (!x.ok || x.value !== "legacy_L") throw new Error("X live should bind legacy_L");
  expect(provision(w, sess(U.a)), "SOCIAL_MOBILE_WORKSPACE_CONFLICT", "provisioner");
  if (r0Current(w, sess(U.a)).decision !== "allow") throw new Error("pinned R0 should allow (it ignores other owned brands)");
  if (r0Proposed(w, sess(U.a)).decision !== "deny") throw new Error("proposed R0 should deny");
  return "DIVERGENCE: X live -> legacy_L, provisioner -> CONFLICT, R0 (pinned) -> allow, R0 (proposed) -> deny";
});
check("N2b multiple owned brands", () => { const w = world(); w.memberships.push({ brand: "b1", user: U.a, role: "owner" }, { brand: "b2", user: U.a, role: "owner" });
  expect(xBeginLive(w, sess(U.a)), "SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED", "X live"); expect(provision(w, sess(U.a)), "SOCIAL_MOBILE_WORKSPACE_CONFLICT", "provisioner"); });
check("N2c shared personal workspace", () => { const w = world(); const ws = wsOf(U.a); w.brands[ws] = "social_mobile_user_v1";
  w.memberships.push({ brand: ws, user: U.a, role: "owner" }, { brand: ws, user: U.b, role: "admin" });
  if (xBeginLive(w, sess(U.a)).value !== ws) throw new Error("X live re-uses the shared workspace"); expect(provision(w, sess(U.a)), "SOCIAL_MOBILE_WORKSPACE_SHARED", "provisioner");
  return "DIVERGENCE: X live re-uses a shared u_ workspace; the provisioner refuses"; });
check("N3 locked account", () => { const w = world(); w.accounts[U.a] = "locked"; expect(beginThreads(w, sess(U.a), "h3"), "ACCOUNT_LOCKED", "begin"); });
check("N4 deleting account", () => { const w = world(); w.deletions.push(U.a); expect(beginThreads(w, sess(U.a), "h4"), "SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS", "begin"); });
check("N5 anonymous session (GAP: T13 passes it today)", () => { const w = world(); const b = beginThreads(w, sess(U.a, { anonymous: true }), "h5");
  if (!b.ok) throw new Error("model drift: T13 is pinned as not checking is_anonymous");
  if (r0Current(w, sess(U.a, { anonymous: true })).decision !== "deny") throw new Error("R0 should deny anonymous");
  return "GAP (G5 S1-F2): Threads begin passes T13 for an anonymous session; R0 denies it"; });
check("N6 expired / revoked session at callback (logout between begin and callback)", () => { const w = world(); const b = beginThreads(w, sess(U.a), "h6");
  expect(callback(w, sess(U.a, { session: "revoked" }), b.value.id), "ACCOUNT_LIFECYCLE_AUTH_REQUIRED", "callback"); });
check("N6b mixed claims (H5 transport today)", () => { const w = world(); expect(beginThreads(w, sess(U.a, { claims: "mixed" }), "h6b"), "ACCOUNT_LIFECYCLE_AUTH_REQUIRED", "begin"); });
check("N7 duplicate callback", () => { const w = world(); const b = beginThreads(w, sess(U.a), "h7"); if (!callback(w, sess(U.a), b.value.id).ok) throw new Error("first");
  expect(callback(w, sess(U.a), b.value.id), "THREADS_BINDING_ALREADY_ATTESTED", "second"); });
check("N7b late callback (expired state)", () => { const w = world(); const b = beginThreads(w, sess(U.a), "h7b"); b.value.expired = true;
  expect(callback(w, sess(U.a), b.value.id), "THREADS_OAUTH_STATE_NOT_CONSUMABLE", "late"); });
check("N7c state expiry beyond 10 minutes / duplicate state hash", () => { const w = world(); expect(beginThreads(w, sess(U.a), "h7c", 11), "THREADS_OAUTH_STATE_INPUT_INVALID", "expiry");
  beginThreads(w, sess(U.a), "dup"); expect(beginThreads(w, sess(U.a), "dup"), "THREADS_OAUTH_STATE_INPUT_INVALID", "dup hash"); });
check("N8 callback / token reuse after disconnect", () => { const w = world(); const ws = connected(w, U.a); const b = beginThreads(w, sess(U.a), "h8"); disconnect(w, ws);
  expect(callback(w, sess(U.a), b.value.id), "THREADS_BINDING_NOT_INITIATOR", "callback of a removed state"); expect(claim(w, ws), "ACCOUNT_NOT_FOUND", "claim"); });
check("N9 stale owner epoch / service generation", () => { const w = world(); const b = beginThreads(w, sess(U.a), "h9"); w.epoch[b.value.ws] = 2;
  expect(callback(w, sess(U.a), b.value.id), "THREADS_BINDING_OWNER_EPOCH_CHANGED", "epoch");
  const w2 = world(); const b2 = beginThreads(w2, sess(U.a), "h9b"); w2.generation[U.a] = 2; expect(callback(w2, sess(U.a), b2.value.id), "THREADS_BINDING_SERVICE_GENERATION_CHANGED", "generation"); });
check("N10 reconnect ends the old lease (old token never refreshed)", () => { const w = world(); const ws = connected(w, U.a); const l = claim(w, ws).value;
  const b = beginThreads(w, sess(U.a), "h10"); callback(w, sess(U.a), b.value.id, { token: "fakeTHREADSnew_0123456789" });
  expect(rotate(w, ws, l), "LEASE_NOT_HELD", "old lease"); });
check("N11 two workers claim the same account (double send)", () => { const w = world(); const ws = connected(w, U.a); claim(w, ws); expect(claim(w, ws), "LEASE_HELD", "second claim"); });
check("N12 another Threads user on reconnect", () => { const w = world(); connected(w, U.a); const b = beginThreads(w, sess(U.a), "h12");
  expect(callback(w, sess(U.a), b.value.id, { threadsUser: "17841499999999999" }), "THREADS_IDENTITY_ACCOUNT_MISMATCH", "identity"); });
check("N13 forged code exchange (no attestation)", () => { const w = world(); const b = beginThreads(w, sess(U.a), "h13"); expect(callback(w, sess(U.a), b.value.id, { attested: false }), "THREADS_CONNECT_ATTESTATION_INVALID", "hmac"); });

// ---------------- source anchors ----------------
let anchorsOk = 0; const anchorBad = [];
const cache = {};
for (const [name, [pin, file, line, text]] of Object.entries(A)) {
  const key = `${pin}:${file}`;
  if (!(key in cache)) {
    try { cache[key] = execFileSync("git", ["-C", repo, "show", `${PIN[pin]}:${F[file]}`], { encoding: "utf8", maxBuffer: 64 << 20 }).split("\n"); }
    catch { cache[key] = null; }
  }
  const got = cache[key]?.[line - 1];
  if (got && got.includes(text)) anchorsOk++; else anchorBad.push(`${name} ${pin}:${F[file]}:L${line}`);
}
for (const r of results) console.log(`${r.verdict.padEnd(9)} ${r.name}${r.note ? ` -- ${r.note}` : ""}`);
console.log(`SOURCE anchors ${anchorsOk}/${Object.keys(A).length} found at the pinned lines${anchorBad.length ? `; missing: ${anchorBad.join(", ")}` : ""}`);
const failed = results.filter((r) => r.verdict !== "MOCK_PASS").length;
if (failed || anchorBad.length) { console.log("POSTONA_G4_PERSONAL_WORKSPACE_OAUTH_OFFLINE_QA_FAIL"); process.exit(1); }
console.log(`POSTONA_G4_PERSONAL_WORKSPACE_OAUTH_OFFLINE_QA_MOCK_PASS (${results.length} cases; MOCK only -- SOURCE_NOT_VERIFIED for runtime, no DB / network / OAuth)`);
