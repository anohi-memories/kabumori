import assert from "node:assert/strict";
import test from "node:test";
import {
  type AccountRow,
  type BrandRow,
  type CompareAndSetResult,
  enablePrerequisiteFailure,
  handlePublishSetting,
  parsePublishSettingBody,
  type PublishSettingDeps,
} from "./logic.ts";

const USER = "user-1";
const TOKEN = "caller-jwt-secret-value";

function account(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acct-1",
    brand_id: "brand-a",
    platform: "x",
    connection_status: "identity_verified",
    platform_user_id: "x-user-1",
    verified_at: "2026-10-01T00:00:00Z",
    last_connection_error_code: null,
    publish_enabled: false,
    has_access_secret_ref: true,
    has_refresh_secret_ref: true,
    ...overrides,
  };
}

type World = {
  accounts: Record<string, AccountRow>;
  brands: Record<string, BrandRow>;
  /** `${userId}:${brandId}` -> role */
  roles: Record<string, string>;
  tokens: Record<string, string>;
  calls: string[];
  writes: Array<{ accountId: string; brandId: string; expected: boolean; desired: boolean; requireReadiness: boolean }>;
  /** Run once, just before the compare-and-set, to simulate a concurrent change. */
  beforeWrite?: (world: World) => void;
  casResult?: CompareAndSetResult;
};

function world(overrides: Partial<World> = {}): World {
  return {
    accounts: { "acct-1": account() },
    brands: { "brand-a": { id: "brand-a", is_active: true, publish_mode: "live" } },
    roles: { [`${USER}:brand-a`]: "owner" },
    tokens: { [TOKEN]: USER },
    calls: [],
    writes: [],
    ...overrides,
  };
}

function depsFor(w: World): PublishSettingDeps {
  return {
    async getUser(token) {
      w.calls.push("getUser");
      const id = w.tokens[token];
      return id ? { id } : null;
    },
    async readAccount(accountId) {
      w.calls.push("readAccount");
      const row = w.accounts[accountId];
      return row ? { ...row } : null;
    },
    async readBrand(brandId) {
      w.calls.push("readBrand");
      const row = w.brands[brandId];
      return row ? { ...row } : null;
    },
    async readMembershipRole(_token, userId, brandId) {
      w.calls.push("readMembershipRole");
      return w.roles[`${userId}:${brandId}`] ?? null;
    },
    async compareAndSetPublishEnabled(input) {
      w.calls.push("compareAndSet");
      w.writes.push(input);
      w.beforeWrite?.(w);
      if (w.casResult) return w.casResult;
      const row = w.accounts[input.accountId];
      if (!row || row.brand_id !== input.brandId || row.publish_enabled !== input.expected) return "no_match";
      if (input.requireReadiness) {
        const ok = row.platform === "x" && row.connection_status === "identity_verified" && row.platform_user_id &&
          row.verified_at && row.has_access_secret_ref && row.has_refresh_secret_ref && !row.last_connection_error_code;
        if (!ok) return "no_match";
      }
      row.publish_enabled = input.desired;
      return "updated";
    },
  };
}

function request(body: unknown, init: { method?: string; token?: string | null; contentType?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": init.contentType ?? "application/json" };
  if (init.token !== null) headers.Authorization = `Bearer ${init.token ?? TOKEN}`;
  return new Request("https://example.test/functions/v1/social-mobile-publish-setting", {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" || init.method === "OPTIONS" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const toggle = (desired: boolean, expected: boolean, id = "acct-1") => ({
  social_account_id: id,
  desired_enabled: desired,
  expected_current_enabled: expected,
});

async function run(w: World, req: Request) {
  const response = await handlePublishSetting(req, depsFor(w));
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
}

// --- authentication / request validation ---------------------------------------------------------

test("unauthenticated requests are rejected before any data is read", async () => {
  for (const token of [null, "", "not-a-known-token"]) {
    const w = world();
    const { status, body } = await run(w, request(toggle(true, false), { token }));
    assert.equal(status, 401, String(token));
    assert.equal(body?.error, "AUTH_REQUIRED");
    assert.ok(!w.calls.includes("readAccount"));
    assert.equal(w.writes.length, 0);
  }
});

test("only POST (and CORS preflight) is accepted", async () => {
  const w = world();
  assert.equal((await run(w, request(null, { method: "GET" }))).status, 405);
  assert.equal((await run(w, request(null, { method: "PUT", token: TOKEN }))).status, 405);
  const preflight = await handlePublishSetting(request(null, { method: "OPTIONS", token: null }), depsFor(w));
  assert.equal(preflight.status, 204);
  assert.equal(w.calls.length, 0);
});

test("body validation: content type, JSON, exact three fields with exact types, no client brand id", async () => {
  const bad: unknown[] = [
    "not json",
    "",
    [],
    null,
    {},
    { social_account_id: "acct-1", desired_enabled: true },
    { ...toggle(true, false), brand_id: "brand-a" },
    { ...toggle(true, false), extra: 1 },
    { ...toggle(true, false), social_account_id: 5 },
    { ...toggle(true, false), social_account_id: "" },
    { ...toggle(true, false), social_account_id: "a/b" },
    { ...toggle(true, false), social_account_id: "x".repeat(101) },
    { ...toggle(true, false), desired_enabled: "true" },
    { ...toggle(true, false), expected_current_enabled: 0 },
  ];
  for (const body of bad) {
    const w = world();
    const { status, body: out } = await run(w, request(body));
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(out?.error, "REQUEST_INVALID");
    assert.equal(w.writes.length, 0);
  }
  const w = world();
  assert.equal((await run(w, request(toggle(true, false), { contentType: "text/plain" }))).status, 400);
  assert.equal((await run(w, request(" ".repeat(2000) + JSON.stringify(toggle(true, false))))).status, 400);
  assert.equal(parsePublishSettingBody(toggle(true, false)).socialAccountId, "acct-1");
});

// --- authorization ------------------------------------------------------------------------------

test("account not found and no membership are indistinguishable (404, no existence leak) and write nothing", async () => {
  const missing = world();
  const a = await run(missing, request(toggle(true, false, "does-not-exist")));
  const noMember = world({ roles: {} });
  const b = await run(noMember, request(toggle(true, false)));
  assert.deepEqual([a.status, a.body], [404, { success: false, error: "ACCOUNT_NOT_FOUND" }]);
  assert.deepEqual([b.status, b.body], [404, { success: false, error: "ACCOUNT_NOT_FOUND" }]);
  assert.equal(missing.writes.length + noMember.writes.length, 0);
});

test("a member of ANOTHER brand cannot toggle this brand's account (cross-brand id guessing)", async () => {
  const w = world({
    accounts: { "acct-1": account(), "acct-b": account({ id: "acct-b", brand_id: "brand-b" }) },
    brands: {
      "brand-a": { id: "brand-a", is_active: true, publish_mode: "live" },
      "brand-b": { id: "brand-b", is_active: true, publish_mode: "live" },
    },
    roles: { [`${USER}:brand-a`]: "owner" }, // owner of A only
  });
  const { status, body } = await run(w, request(toggle(true, false, "acct-b")));
  assert.equal(status, 404);
  assert.equal(body?.error, "ACCOUNT_NOT_FOUND");
  assert.equal(w.accounts["acct-b"].publish_enabled, false);
  assert.equal(w.writes.length, 0);
});

test("the membership consulted is the account's own brand, never a client value", async () => {
  const seen: string[] = [];
  const w = world();
  const deps = depsFor(w);
  const original = deps.readMembershipRole;
  deps.readMembershipRole = (token, userId, brandId) => {
    seen.push(brandId);
    return original(token, userId, brandId);
  };
  const res = await handlePublishSetting(request(toggle(true, false)), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["brand-a"]);
});

test("viewer and member are rejected by the v1 policy; owner and admin are allowed", async () => {
  for (const role of ["viewer", "member", "something_else", ""]) {
    const w = world({ roles: { [`${USER}:brand-a`]: role } });
    const { status, body } = await run(w, request(toggle(true, false)));
    assert.equal(status, 403, role);
    assert.equal(body?.error, "PUBLISH_CONTROL_FORBIDDEN");
    assert.equal(w.writes.length, 0);
    assert.equal(w.accounts["acct-1"].publish_enabled, false);
  }
  for (const role of ["owner", "admin"]) {
    const w = world({ roles: { [`${USER}:brand-a`]: role } });
    const { status, body } = await run(w, request(toggle(true, false)));
    assert.equal(status, 200, role);
    assert.deepEqual(body, { success: true, status: "updated", account: { id: "acct-1", publish_enabled: true } });
  }
});

test("viewer/member cannot even switch OFF", async () => {
  const w = world({ accounts: { "acct-1": account({ publish_enabled: true }) }, roles: { [`${USER}:brand-a`]: "member" } });
  const { status } = await run(w, request(toggle(false, true)));
  assert.equal(status, 403);
  assert.equal(w.accounts["acct-1"].publish_enabled, true);
});

// --- enabling: strict gate ----------------------------------------------------------------------

const BLOCKERS: Array<[string, Partial<AccountRow>, Partial<BrandRow> | null, string, boolean]> = [
  ["authorization pending", { connection_status: "authorization_pending" }, null, "CONNECTION_NOT_VERIFIED", true],
  ["unconnected", { connection_status: "unconnected" }, null, "CONNECTION_NOT_VERIFIED", true],
  ["failed (reconnect required)", { connection_status: "failed" }, null, "CONNECTION_NOT_VERIFIED", true],
  ["connected but identity not verified", { connection_status: "connected" }, null, "CONNECTION_NOT_VERIFIED", true],
  ["no platform user id", { platform_user_id: null }, null, "CONNECTION_NOT_VERIFIED", true],
  ["no verified_at", { verified_at: null }, null, "CONNECTION_NOT_VERIFIED", true],
  ["no access token reference", { has_access_secret_ref: false }, null, "CREDENTIALS_MISSING", true],
  ["no refresh token reference", { has_refresh_secret_ref: false }, null, "CREDENTIALS_MISSING", true],
  ["known connection error code", { last_connection_error_code: "X_REFRESH_UNCERTAIN" }, null, "CONNECTION_DEGRADED", true],
  ["non-X platform", { platform: "instagram" }, null, "PLATFORM_NOT_SUPPORTED", false],
  ["brand inactive", {}, { is_active: false }, "BRAND_INACTIVE", false],
  ["brand publish_mode disabled", {}, { publish_mode: "disabled" }, "BRAND_PUBLISHING_NOT_LIVE", false],
  ["brand publish_mode dry_run", {}, { publish_mode: "dry_run" }, "BRAND_PUBLISHING_NOT_LIVE", false],
];

test("ON is blocked, with a bounded code and no mutation, for every unmet prerequisite", async () => {
  for (const [name, accountPatch, brandPatch, code, reconnect] of BLOCKERS) {
    const w = world({
      accounts: { "acct-1": account(accountPatch) },
      brands: { "brand-a": { id: "brand-a", is_active: true, publish_mode: "live", ...(brandPatch ?? {}) } },
    });
    const { status, body } = await run(w, request(toggle(true, false)));
    assert.equal(status, 409, name);
    assert.equal(body?.error, code, name);
    assert.equal(body?.reconnect_recommended === true, reconnect, name);
    assert.equal(w.writes.length, 0, `${name}: nothing written`);
    assert.equal(w.accounts["acct-1"].publish_enabled, false, name);
  }
});

test("a missing brand row blocks ON", async () => {
  const w = world({ brands: {} });
  const { status, body } = await run(w, request(toggle(true, false)));
  assert.equal(status, 409);
  assert.equal(body?.error, "BRAND_INACTIVE");
});

test("prerequisite messages carry only a code (no credential, token or id material)", async () => {
  const w = world({ accounts: { "acct-1": account({ has_access_secret_ref: false }) } });
  const text = JSON.stringify((await run(w, request(toggle(true, false)))).body);
  assert.doesNotMatch(text, /secret|token|vault|x-user-1|brand-a|jwt/iu);
});

test("enablePrerequisiteFailure is null only for a fully ready X account in a live, active brand", () => {
  const brand: BrandRow = { id: "brand-a", is_active: true, publish_mode: "live" };
  assert.equal(enablePrerequisiteFailure(account(), brand), null);
  assert.equal(enablePrerequisiteFailure(account(), { ...brand, id: "other" })?.code, "BRAND_INACTIVE");
});

test("an eligible OFF -> ON succeeds and writes exactly one conditional change", async () => {
  const w = world();
  const { status, body } = await run(w, request(toggle(true, false)));
  assert.equal(status, 200);
  assert.deepEqual(body, { success: true, status: "updated", account: { id: "acct-1", publish_enabled: true } });
  assert.deepEqual(w.writes, [
    { accountId: "acct-1", brandId: "brand-a", expected: false, desired: true, requireReadiness: true },
  ]);
  assert.equal(w.accounts["acct-1"].publish_enabled, true);
});

// --- disabling: safety first ---------------------------------------------------------------------

test("OFF is allowed for an owner/admin even when the connection is degraded, credentials are gone and the brand is inactive", async () => {
  const w = world({
    accounts: {
      "acct-1": account({
        publish_enabled: true,
        connection_status: "failed",
        platform_user_id: null,
        verified_at: null,
        has_access_secret_ref: false,
        has_refresh_secret_ref: false,
        last_connection_error_code: "X_REAUTH_REQUIRED",
      }),
    },
    brands: { "brand-a": { id: "brand-a", is_active: false, publish_mode: "disabled" } },
  });
  const { status, body } = await run(w, request(toggle(false, true)));
  assert.equal(status, 200);
  assert.deepEqual(body, { success: true, status: "updated", account: { id: "acct-1", publish_enabled: false } });
  assert.equal(w.accounts["acct-1"].publish_enabled, false);
  assert.deepEqual(w.writes, [{ accountId: "acct-1", brandId: "brand-a", expected: true, desired: false, requireReadiness: false }]);
  assert.ok(!w.calls.includes("readBrand"), "disabling does not depend on brand state");
});

test("OFF still requires the exact membership and stale protection", async () => {
  const noMember = world({ accounts: { "acct-1": account({ publish_enabled: true }) }, roles: {} });
  assert.equal((await run(noMember, request(toggle(false, true)))).status, 404);
  const stale = world({ accounts: { "acct-1": account({ publish_enabled: false }) } });
  const { status, body } = await run(stale, request(toggle(false, true)));
  assert.equal(status, 409);
  assert.equal(body?.error, "STALE_STATE");
});

// --- stale / compare-and-set --------------------------------------------------------------------

test("a stale expected state is a conflict that reports the real state and mutates nothing", async () => {
  const w = world({ accounts: { "acct-1": account({ publish_enabled: true }) } });
  const { status, body } = await run(w, request(toggle(true, false)));
  assert.equal(status, 409);
  assert.deepEqual(body, { success: false, error: "STALE_STATE", current_enabled: true });
  assert.equal(w.writes.length, 0);
});

test("a change that lands between the read and the write is caught by the conditional write (zero rows is not success)", async () => {
  const w = world({
    beforeWrite: (state) => {
      state.accounts["acct-1"].publish_enabled = true; // someone else switched it ON first
    },
  });
  const { status, body } = await run(w, request(toggle(true, false)));
  assert.equal(status, 409);
  assert.deepEqual(body, { success: false, error: "STALE_STATE", current_enabled: true });
  assert.equal(w.writes.length, 1);
});

test("a connection that fails between the read and the enabling write cannot be enabled", async () => {
  const w = world({
    beforeWrite: (state) => {
      state.accounts["acct-1"].connection_status = "failed";
    },
  });
  const { status, body } = await run(w, request(toggle(true, false)));
  assert.equal(status, 409);
  assert.equal(body?.error, "CONNECTION_NOT_VERIFIED");
  assert.equal(body?.reconnect_recommended, true);
  assert.equal(w.accounts["acct-1"].publish_enabled, false);
});

test("a zero-row OFF write with an unchanged state is reported as unavailable, never as success", async () => {
  const w = world({ accounts: { "acct-1": account({ publish_enabled: true }) }, casResult: "no_match" });
  const { status, body } = await run(w, request(toggle(false, true)));
  assert.equal(status, 503);
  assert.equal(body?.error, "PUBLISH_SETTING_UNAVAILABLE");
});

test("an account removed between the read and the write is reported as not found", async () => {
  const w = world({
    beforeWrite: (state) => {
      delete state.accounts["acct-1"];
    },
  });
  const { status } = await run(w, request(toggle(true, false)));
  assert.equal(status, 404);
});

test("a workspace deletion in progress blocks the change with a conflict", async () => {
  const w = world({ casResult: "busy" });
  const { status, body } = await run(w, request(toggle(true, false)));
  assert.equal(status, 409);
  assert.equal(body?.error, "ACCOUNT_BUSY");
});

test("same-state requests are deterministic no-ops (no write), and a double submit does not flip the state", async () => {
  const on = world({ accounts: { "acct-1": account({ publish_enabled: true }) } });
  const first = await run(on, request(toggle(true, true)));
  assert.deepEqual(first.body, { success: true, status: "unchanged", account: { id: "acct-1", publish_enabled: true } });
  assert.equal(on.writes.length, 0);

  const w = world();
  const a = await run(w, request(toggle(true, false)));
  const b = await run(w, request(toggle(true, false))); // the same request sent twice
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal(b.body?.error, "STALE_STATE");
  assert.equal(w.accounts["acct-1"].publish_enabled, true);
  assert.equal(w.writes.length, 1);
});

test("unexpected dependency failures become a bounded unavailable error with no internals", async () => {
  const w = world();
  const deps = depsFor(w);
  deps.readAccount = () => Promise.reject(new Error("db host 10.0.0.1 password=hunter2"));
  const res = await handlePublishSetting(request(toggle(true, false)), deps);
  assert.equal(res.status, 503);
  const text = JSON.stringify(await res.json());
  assert.equal(text, JSON.stringify({ success: false, error: "PUBLISH_SETTING_UNAVAILABLE" }));
  assert.doesNotMatch(text, /hunter2|10\.0\.0\.1/u);
});

test("responses never echo the caller's token, and CORS headers allow only the needed methods", async () => {
  const w = world();
  const res = await handlePublishSetting(request(toggle(true, false)), depsFor(w));
  assert.doesNotMatch(JSON.stringify(await res.json()), /caller-jwt-secret-value/u);
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
});
