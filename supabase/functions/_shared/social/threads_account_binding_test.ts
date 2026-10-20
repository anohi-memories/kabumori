// Offline: no --allow-net, no --allow-env (read only, for the isolation scan); both ports are fakes.
//   deno test --no-config --cached-only --allow-read=. supabase/functions/_shared/social/threads_account_binding_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  connectedReceiptAccountId,
  createThreadsAccountBinding,
  decideThreadsAccountBinding,
  THREADS_ACCOUNT_BINDING_ENABLED,
  THREADS_BINDING_REFUSALS,
  type ThreadsBindingPorts,
  type ThreadsConnectFlowContext,
} from "./threads_account_binding.ts";
import { INVALID_SOCIAL_ACCOUNT_IDS, VALID_SOCIAL_ACCOUNT_IDS } from "./social_account_id_cases.ts";

const ALICE = "0b6a8c1e-2d3f-4a5b-8c7d-9e0f1a2b3c4d";
const BOB = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const ACCOUNT = "sa_3f6c1b8e5d2a4c7f9e1b0a2b"; // the real social_accounts id shape (G4-12)
const BRAND = "brand_alice_personal";
const KEY = "x_autopost"; // G5's common POSTONA key (G4-10)
const NOW = 1_760_800_000_000;

const receipt = (over: Record<string, unknown> = {}) => ({
  ok: true,
  status: "connected",
  provider: "threads",
  social_account_id: ACCOUNT,
  publish_enabled: false,
  token_expires_at: "2026-12-18T00:00:00.000Z",
  ...over,
});
const flow = (over: Partial<ThreadsConnectFlowContext> = {}): ThreadsConnectFlowContext => ({
  startedByPrincipalId: ALICE,
  currentPrincipalId: ALICE,
  brandId: BRAND,
  stateExpiresAtMs: NOW + 60_000,
  receivedAtMs: NOW,
  previousThreadsUserId: null,
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  socialAccountId: ACCOUNT,
  brandId: BRAND,
  platform: "threads",
  platformUserId: "17841400000000001",
  connectionStatus: "identity_verified",
  hasAccessCredential: true,
  boundByPrincipalId: ALICE,
  bindOwnerEpoch: "3",
  bindLifecycleVersion: "2",
  ...over,
});
const verdict = (over: Record<string, unknown> = {}) => ({
  principalId: ALICE,
  brandId: BRAND,
  serviceKey: KEY,
  verdict: "allow",
  role: "owner",
  entitlementVersion: "ent:v7",
  ownerEpochToken: "g5oe:3:2",
  ...over,
});

function ports(account: unknown = row(), g5: unknown = verdict()) {
  const calls: string[] = [];
  const p: ThreadsBindingPorts = {
    readThreadsAccount: (id) => {
      calls.push(`account ${id}`);
      return account instanceof Error ? Promise.reject(account) : Promise.resolve(account);
    },
    principalVerdict: (principal, brand, key) => {
      calls.push(`g5 ${principal} ${brand} ${key}`);
      return g5 instanceof Error ? Promise.reject(g5) : Promise.resolve(g5);
    },
  };
  return { p, calls };
}
const decide = (p: ThreadsBindingPorts, r: unknown = receipt(), f: ThreadsConnectFlowContext = flow()) =>
  decideThreadsAccountBinding(true, KEY, p, r, f);

test("the static gate is closed; the deployable form refuses before touching anything", async () => {
  assert.equal(THREADS_ACCOUNT_BINDING_ENABLED, false);
  const { p, calls } = ports();
  assert.deepEqual(await createThreadsAccountBinding(p)(receipt(), flow()), { ok: false, code: "BINDING_DISABLED" });
  assert.deepEqual(await decideThreadsAccountBinding(false, KEY, p, receipt(), flow()), { ok: false, code: "BINDING_DISABLED" });
  assert.deepEqual(calls, []);
});

test("any key but the common POSTONA one refuses before touching anything", async () => {
  const { p, calls } = ports();
  for (const key of [null, "kabumori", "", "Bad Key", "postona_threads", "X_AUTOPOST", "x_autopost "]) {
    assert.deepEqual(await decideThreadsAccountBinding(true, key, p, receipt(), flow()), { ok: false, code: "SERVICE_KEY_INVALID" });
  }
  assert.deepEqual(calls, []);
});

test("bound: one account read, then one G5 verdict for that principal, brand and key; frozen; nothing written", async () => {
  const { p, calls } = ports();
  const v = await decide(p);
  assert.deepEqual(v, {
    ok: true,
    binding: {
      socialAccountId: ACCOUNT,
      brandId: BRAND,
      threadsUserId: "17841400000000001",
      principalId: ALICE,
      serviceKey: KEY,
      ownerEpoch: "3",
      lifecycleVersion: "2",
      entitlementVersion: "ent:v7",
    },
  });
  assert.equal(Object.isFrozen(v) && v.ok && Object.isFrozen(v.binding), true);
  assert.deepEqual(calls, [`account ${ACCOUNT}`, `g5 ${ALICE} ${BRAND} ${KEY}`]);
  assert.deepEqual(Object.keys(p).sort(), ["principalVerdict", "readThreadsAccount"]); // no write port exists
});

test("a duplicate or replayed receipt gets the same verdict and writes nothing", async () => {
  const { p, calls } = ports();
  const first = await decide(p);
  const again = await decide(p);
  assert.deepEqual(again, first);
  assert.equal(calls.length, 4);
  const { p: p2 } = ports(row({ connectionStatus: "unconnected", hasAccessCredential: false, platformUserId: null }));
  assert.deepEqual(await decide(p2), { ok: false, code: "ACCOUNT_NOT_VERIFIED" }); // replay after a disconnect
});

test("receipts that are not a connected receipt of the wire contract never reach a port", async () => {
  const bad: unknown[] = [
    null,
    "connected",
    [receipt()],
    receipt({ ok: false }),
    receipt({ status: "pending" }),
    receipt({ provider: "x" }),
    receipt({ publish_enabled: true }),
    receipt({ social_account_id: "not-a-uuid" }),
    receipt({ social_account_id: ACCOUNT.toUpperCase() }),
    receipt({ token_expires_at: "soon" }),
    receipt({ extra: 1 }),
    { ok: false, error: "COMPLETE_OUTCOME_UNKNOWN" },
    { ok: false, error: "CALLBACK_REFUSED" },
  ];
  const { p, calls } = ports();
  for (const r of bad) {
    assert.equal(connectedReceiptAccountId(r), null, JSON.stringify(r));
    assert.deepEqual(await decide(p, r), { ok: false, code: "RECEIPT_INVALID" });
  }
  assert.deepEqual(calls, []);
});

test("the person: signed out, changed while the browser was open, or late against the OAuth state", async () => {
  const { p, calls } = ports();
  assert.deepEqual(await decide(p, receipt(), flow({ currentPrincipalId: null })), { ok: false, code: "AUTH_REQUIRED" });
  assert.deepEqual(await decide(p, receipt(), flow({ currentPrincipalId: BOB })), { ok: false, code: "PRINCIPAL_CHANGED" });
  assert.deepEqual(await decide(p, receipt(), flow({ receivedAtMs: NOW + 60_001 })), { ok: false, code: "STATE_EXPIRED" });
  assert.deepEqual(await decide(p, receipt(), flow({ stateExpiresAtMs: Number.NaN })), { ok: false, code: "STATE_EXPIRED" });
  assert.deepEqual(await decide(p, receipt(), flow({ startedByPrincipalId: "x" })), { ok: false, code: "RECEIPT_INVALID" });
  assert.deepEqual(await decide(p, receipt(), flow({ brandId: "has space" })), { ok: false, code: "RECEIPT_INVALID" });
  assert.deepEqual(await decide(p, receipt(), flow({ previousThreadsUserId: "0" })), { ok: false, code: "RECEIPT_INVALID" });
  assert.deepEqual(calls, []);
  assert.deepEqual(await decide(p, receipt(), flow({ receivedAtMs: NOW + 60_000 })), (await decide(p)));
});

test("the account: unreadable, missing, several, another provider, not verified, another brand, another identity, another person", async () => {
  const cases: [unknown, string, Partial<ThreadsConnectFlowContext>?][] = [
    [new Error(`db detail ${ACCOUNT}`), "ACCOUNT_UNAVAILABLE"],
    [{ ...row(), hasAccessCredential: "yes" }, "ACCOUNT_UNAVAILABLE"],
    [row({ bindOwnerEpoch: 3 }), "ACCOUNT_UNAVAILABLE"], // G4-08: a JS number is not a stored G5 number
    [row({ bindLifecycleVersion: 2 }), "ACCOUNT_UNAVAILABLE"],
    [null, "ACCOUNT_NOT_FOUND"],
    [[], "ACCOUNT_NOT_FOUND"],
    [row({ socialAccountId: "sa_111122224333844455550000" }), "ACCOUNT_NOT_FOUND"],
    [[row(), row()], "ACCOUNT_AMBIGUOUS"],
    [row({ platform: "x" }), "ACCOUNT_NOT_THREADS"],
    [row({ connectionStatus: "connected" }), "ACCOUNT_NOT_VERIFIED"],
    [row({ connectionStatus: "failed" }), "ACCOUNT_NOT_VERIFIED"],
    [row({ connectionStatus: "unconnected" }), "ACCOUNT_NOT_VERIFIED"],
    [row({ hasAccessCredential: false }), "ACCOUNT_NOT_VERIFIED"],
    [row({ platformUserId: null }), "ACCOUNT_NOT_VERIFIED"],
    [row({ platformUserId: "01" }), "ACCOUNT_NOT_VERIFIED"],
    [row({ brandId: "brand_bob" }), "BRAND_MISMATCH"],
    [row(), "IDENTITY_CHANGED", { previousThreadsUserId: "17841499999999999" }],
    [row({ boundByPrincipalId: BOB }), "BOUND_BY_OTHER_PRINCIPAL"],
    [row({ boundByPrincipalId: null }), "BOUND_BY_OTHER_PRINCIPAL"],
  ];
  for (const [account, code, over] of cases) {
    const { p, calls } = ports(account);
    assert.deepEqual(await decide(p, receipt(), flow(over)), { ok: false, code }, code);
    assert.deepEqual(calls, [`account ${ACCOUNT}`], `${code}: G5 is not asked`);
  }
  const { p } = ports(row());
  assert.equal((await decide(p, receipt(), flow({ previousThreadsUserId: "17841400000000001" }))).ok, true); // same identity
});

test("G5: unreadable, about someone else, denied, wrong role, unknown or moved owner epoch", async () => {
  const cases: [unknown, unknown, string][] = [
    [row(), new Error("g5 down"), "ENTITLEMENT_UNAVAILABLE"],
    [row(), null, "ENTITLEMENT_UNAVAILABLE"],
    [row(), verdict({ verdict: "maybe" }), "ENTITLEMENT_UNAVAILABLE"],
    [row(), verdict({ entitlementVersion: "" }), "ENTITLEMENT_UNAVAILABLE"],
    [row(), verdict({ ownerEpochToken: 3 }), "ENTITLEMENT_UNAVAILABLE"],
    [row(), verdict({ principalId: BOB }), "VERDICT_MISMATCH"],
    [row(), verdict({ brandId: "brand_bob" }), "VERDICT_MISMATCH"],
    [row(), verdict({ serviceKey: "kabumori" }), "VERDICT_MISMATCH"],
    [row(), verdict({ verdict: "deny" }), "SERVICE_NOT_ACTIVE"],
    [row(), verdict({ role: "member" }), "ROLE_INSUFFICIENT"],
    [row(), verdict({ role: null }), "ROLE_INSUFFICIENT"],
    [row(), verdict({ ownerEpochToken: null }), "OWNER_EPOCH_UNKNOWN"],
    [row(), verdict({ ownerEpochToken: "g5oe:0:2" }), "OWNER_EPOCH_UNKNOWN"],
    [row(), verdict({ ownerEpochToken: "g5oe:3:0" }), "OWNER_EPOCH_UNKNOWN"],
    [row(), verdict({ ownerEpochToken: "g5oe:3" }), "OWNER_EPOCH_UNKNOWN"],
    [row(), verdict({ ownerEpochToken: "g5oe:03:2" }), "OWNER_EPOCH_UNKNOWN"],
    [row(), verdict({ ownerEpochToken: "g5oe:9223372036854775808:2" }), "OWNER_EPOCH_UNKNOWN"], // bigint overflow
    [row(), verdict({ ownerEpochToken: "3" }), "OWNER_EPOCH_UNKNOWN"],
    [row({ bindOwnerEpoch: null }), verdict(), "BIND_EPOCH_UNRECORDED"],
    [row({ bindLifecycleVersion: null }), verdict(), "BIND_EPOCH_UNRECORDED"],
    [row({ bindOwnerEpoch: "0" }), verdict(), "BIND_EPOCH_UNRECORDED"],
    [row({ bindLifecycleVersion: "02" }), verdict(), "BIND_EPOCH_UNRECORDED"],
    [row({ bindOwnerEpoch: "99999999999999999999" }), verdict(), "BIND_EPOCH_UNRECORDED"],
    [row({ bindOwnerEpoch: "3" }), verdict({ ownerEpochToken: "g5oe:5:2" }), "OWNER_EPOCH_CHANGED"], // owner A -> B -> A
    [row({ bindOwnerEpoch: "5" }), verdict({ ownerEpochToken: "g5oe:3:2" }), "OWNER_EPOCH_CHANGED"],
    [row({ bindLifecycleVersion: "2" }), verdict({ ownerEpochToken: "g5oe:3:4" }), "SERVICE_GENERATION_CHANGED"], // ended + restarted
    [row({ bindLifecycleVersion: "4" }), verdict({ ownerEpochToken: "g5oe:3:2" }), "SERVICE_GENERATION_CHANGED"],
  ];
  for (const [account, g5, code] of cases) {
    const { p } = ports(account, g5);
    assert.deepEqual(await decide(p), { ok: false, code }, code);
  }
  const { p } = ports(row(), verdict({ role: "admin" }));
  assert.equal((await decide(p)).ok, true);
});

test("refusals carry only a fixed code", async () => {
  const seen = new Set<string>();
  const { p } = ports(new Error(`secret ${ACCOUNT}`));
  for (const r of [await decide(p), await decide(ports(row(), new Error("x")).p)]) {
    assert.equal(r.ok, false);
    if (!r.ok) seen.add(r.code);
    assert.deepEqual(Object.keys(r).sort(), ["code", "ok"]);
  }
  for (const code of seen) assert.equal((THREADS_BINDING_REFUSALS as readonly string[]).includes(code), true);
});

test("isolation: imports only G4's service-key rule; only its test and the G4-04 vertical path import it", async () => {
  const source = await Deno.readTextFile(new URL("./threads_account_binding.ts", import.meta.url));
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/gu)].map((m) => m[1]), ["./g5_owner_epoch_token.ts", "./social_account_id.ts", "./threads_send_port.ts"]);
  assert.equal(/\b(fetch|Deno\.|console\.)/u.test(source.replace(/^\s*\/\/.*$/gmu, "")), false);
  const importers: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory) await walk(new URL(`${entry.name}/`, dir), `${rel}${entry.name}/`);
      else if (/\.(ts|tsx|mjs|js)$/u.test(entry.name) && /(?:from|import\()\s*["'][^"']*\/threads_account_binding\.ts["']/u.test(await Deno.readTextFile(new URL(entry.name, dir)))) {
        importers.push(`${rel}${entry.name}`);
      }
    }
  }
  const root = new URL("../../../../", import.meta.url);
  await walk(new URL("supabase/", root), "supabase/");
  await walk(new URL("apps/", root), "apps/");
  // G4-04 composes the verdict into the vertical path (bind only; it adds no write).
  assert.deepEqual(importers.sort(), [
    "supabase/functions/_shared/social/threads_account_binding_test.ts",
    "supabase/functions/_shared/social/threads_connect_to_send.ts",
    "supabase/functions/_shared/social/threads_connect_to_send_test.ts", // types only
  ]);
});

test("G4-08: both G5 numbers stay exact decimal text beyond 2^53", async () => {
  const big = "9007199254740993"; // 2^53 + 1: a JS number would become ...992
  const { p } = ports(row({ bindOwnerEpoch: big, bindLifecycleVersion: "9223372036854775807" }), verdict({ ownerEpochToken: `g5oe:${big}:9223372036854775807` }));
  const v = await decide(p);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.binding.ownerEpoch, big);
    assert.equal(v.binding.lifecycleVersion, "9223372036854775807");
  }
  const { p: off } = ports(row({ bindOwnerEpoch: "9007199254740992" }), verdict({ ownerEpochToken: `g5oe:${big}:2` }));
  assert.deepEqual(await decide(off), { ok: false, code: "OWNER_EPOCH_CHANGED" });
});

// ---- G4-12: the real social_accounts id shape (G3 U2) -----------------------------------------------------------------

test("G4-12: a connected receipt of a real account id (sa_...) binds that account; the row must still be that id", async () => {
  for (const id of VALID_SOCIAL_ACCOUNT_IDS) {
    assert.equal(connectedReceiptAccountId(receipt({ social_account_id: id })), id);
    const { p, calls } = ports(row({ socialAccountId: id }));
    const v = await decide(p, receipt({ social_account_id: id }));
    assert.equal(v.ok && v.binding.socialAccountId, id, id);
    assert.deepEqual(calls, [`account ${id}`, `g5 ${ALICE} ${BRAND} ${KEY}`]);
  }
  const { p } = ports(row({ socialAccountId: "sa_x" }));
  assert.deepEqual(await decide(p, receipt()), { ok: false, code: "ACCOUNT_NOT_FOUND" }); // another account's row
});

test("G4-12: a receipt id the table refuses is not a receipt: no account read, no G5", async () => {
  const { p, calls } = ports();
  for (const id of INVALID_SOCIAL_ACCOUNT_IDS) {
    assert.equal(connectedReceiptAccountId(receipt({ social_account_id: id })), null, JSON.stringify(String(id)));
    assert.deepEqual(await decide(p, receipt({ social_account_id: id })), { ok: false, code: "RECEIPT_INVALID" });
  }
  assert.deepEqual(calls, []);
});

test("G4-12: the person, brand, epoch and generation checks are unchanged for a real id", async () => {
  const cases: [ReturnType<typeof ports>, ThreadsConnectFlowContext, string][] = [
    [ports(), flow({ currentPrincipalId: BOB }), "PRINCIPAL_CHANGED"],
    [ports(row({ brandId: "brand_bob" })), flow(), "BRAND_MISMATCH"],
    [ports(row({ boundByPrincipalId: BOB })), flow(), "BOUND_BY_OTHER_PRINCIPAL"],
    [ports(row(), verdict({ ownerEpochToken: "g5oe:4:2" })), flow(), "OWNER_EPOCH_CHANGED"],
    [ports(row(), verdict({ ownerEpochToken: "g5oe:3:3" })), flow(), "SERVICE_GENERATION_CHANGED"],
  ];
  for (const [{ p }, f, code] of cases) assert.deepEqual(await decide(p, receipt(), f), { ok: false, code }, code);
});
