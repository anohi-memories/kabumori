// TEST SUPPORT ONLY (imported by *_test.ts files, never by runtime code).
//
// An in-memory reference model of the database boundary in
// supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql: the same refusal
// order, the same claim rules, single-use grants and the same transition table. The SQL candidate is
// proven separately against a disposable PostgreSQL (supabase/tests/postona_threads_publish_*.sql).

import {
  THREADS_ATTEMPT_ERROR_CODES,
  THREADS_ATTEMPT_MAX_AGE_SECONDS,
  THREADS_CLAIM_RULES,
  THREADS_GRANT_TTL_SECONDS,
  THREADS_PERMISSION_STEPS,
  THREADS_RECORD_TRANSITIONS,
  THREADS_STALE_IN_FLIGHT_SECONDS,
  THREADS_TERMINAL_STATUSES,
  type ThreadsAccountPublishState,
  type ThreadsAttempt,
  type ThreadsAttemptStatus,
  type ThreadsClaimStep,
  type ThreadsPublishPermissionStore,
  type ThreadsPublishStore,
  type ThreadsRedeemedStep,
  type ThreadsStepResult,
  ThreadsStoreError,
  type VerifiedCaller,
} from "./threads_manual_publish.ts";

export type FakeAccount = {
  brandId: string;
  platform: "x" | "threads" | "instagram";
  connection: "unconnected" | "authorization_pending" | "connected" | "identity_verified" | "failed";
  threadsUserId: string | null;
  token: string | null;
  /** The custody owner's expiry for this account's token (ms); null = unknown = expired. */
  expiresAt?: number | null;
};
export type FakeService = "active" | "not_registered" | "ended" | "deleting" | "locked" | "fence_unavailable";

type Row = {
  attemptId: string;
  socialAccountId: string;
  brandId: string;
  requestedBy: string;
  idempotencyKey: string;
  text: string;
  status: ThreadsAttemptStatus;
  containerId: string | null;
  providerPostId: string | null;
  permalink: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};
type Grant = { value: string; step: ThreadsClaimStep; state: "issued" | "redeemed"; expiresAt: number };

export const ATTEMPT_MAX_AGE_MS = THREADS_ATTEMPT_MAX_AGE_SECONDS * 1000;
export const GRANT_TTL_MS = THREADS_GRANT_TTL_SECONDS * 1000;
export const STALE_IN_FLIGHT_MS = THREADS_STALE_IN_FLIGHT_SECONDS * 1000;

export class FakeThreadsPublishStore implements ThreadsPublishStore, ThreadsPublishPermissionStore {
  accounts = new Map<string, FakeAccount>();
  memberships = new Map<string, "owner" | "admin" | "member" | "viewer">(); // `${brandId}|${userId}`
  services = new Map<string, FakeService>(); // userId -> lifecycle
  permissions = new Set<string>();
  /** Workspaces that are disabled (is_active false or publish_mode 'disabled'). */
  inactiveBrands = new Set<string>();
  attempts = new Map<string, Row>();
  grants = new Map<string, Grant>();
  /** Verified bearer tokens -> user ids; anything else is not authenticated. */
  tokens = new Map<string, string>();
  clock = Date.parse("2026-10-11T03:00:00Z");
  log: string[] = [];
  /** Test hook: runs after each successful record (e.g. to revoke the permission between steps). */
  afterRecord: (attempt: ThreadsAttempt) => void = () => {};
  private sequence = 0;

  // --- caller-side (JWT) ---------------------------------------------------------------------------

  begin(caller: VerifiedCaller, input: Readonly<{ socialAccountId: string; idempotencyKey: string; text: string }>): Promise<ThreadsAttempt> {
    return this.run(`begin:${input.socialAccountId}`, () => {
      const user = this.authenticate(caller);
      if (!/^[0-9a-f-]{36}$/.test(input.idempotencyKey)) throw new ThreadsStoreError("REQUEST_INVALID");
      // The SQL CHECK: 1-500 code points, not blank, no control characters other than line feed and tab.
      // deno-lint-ignore no-control-regex
      if (input.text.trim() === "" || [...input.text].length > 500 || /[\u0000-\u0008\u000B-\u001F\u007F]/u.test(input.text)) {
        throw new ThreadsStoreError("TEXT_INVALID");
      }
      const account = this.authorize(user, input.socialAccountId);
      const existing = [...this.attempts.values()].find((row) => row.socialAccountId === input.socialAccountId && row.idempotencyKey === input.idempotencyKey);
      if (existing) {
        if (existing.text !== input.text || existing.requestedBy !== user) throw new ThreadsStoreError("IDEMPOTENCY_CONFLICT");
        return { ...this.view(existing), replayed: true };
      }
      if ([...this.attempts.values()].some((row) => row.socialAccountId === input.socialAccountId && !THREADS_TERMINAL_STATUSES.has(row.status))) {
        throw new ThreadsStoreError("PUBLISH_IN_PROGRESS");
      }
      const row: Row = {
        attemptId: `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`,
        socialAccountId: input.socialAccountId,
        brandId: account.brandId,
        requestedBy: user,
        idempotencyKey: input.idempotencyKey,
        text: input.text,
        status: "reserved",
        containerId: null,
        providerPostId: null,
        permalink: null,
        errorCode: null,
        createdAt: this.clock,
        updatedAt: this.clock,
      };
      this.attempts.set(row.attemptId, row);
      return this.view(row);
    });
  }

  claim(caller: VerifiedCaller, input: Readonly<{ attemptId: string; step: ThreadsClaimStep }>): Promise<Readonly<{ grant: string; attempt: ThreadsAttempt }>> {
    return this.run(`claim:${input.step}`, () => {
      const user = this.authenticate(caller);
      const row = this.memberAttempt(user, input.attemptId);
      const rule = THREADS_CLAIM_RULES[input.step];
      if (rule === undefined) throw new ThreadsStoreError("REQUEST_INVALID");
      this.authorize(user, row.socialAccountId, THREADS_PERMISSION_STEPS.has(input.step));
      if (input.step === "reconcile" && this.clock - row.updatedAt > STALE_IN_FLIGHT_MS) {
        // An abandoned in-flight write is settled first (see THREADS_STALE_IN_FLIGHT_SECONDS).
        if (row.status === "creating_container") {
          this.settle(row, "failed", "STEP_INTERRUPTED");
          throw new ThreadsStoreError("STALE_STEP");
        }
        if (row.status === "publishing") this.settle(row, "uncertain", "STEP_INTERRUPTED");
      }
      if (row.status !== rule.from) throw new ThreadsStoreError("STALE_STEP");
      if (rule.to !== null && this.clock - row.createdAt > ATTEMPT_MAX_AGE_MS) {
        // Too old to continue to a provider write: closed as failed (nothing was published: a write step
        // starts from reserved or container_created, neither of which can have a post).
        this.settle(row, "failed", "ATTEMPT_EXPIRED");
        throw new ThreadsStoreError("ATTEMPT_EXPIRED");
      }
      if (rule.to !== null) {
        row.status = rule.to;
        row.updatedAt = this.clock;
      }
      const value = `grant-${row.attemptId}-${++this.sequence}-${input.step}`;
      this.grants.set(row.attemptId, { value, step: input.step, state: "issued", expiresAt: this.clock + GRANT_TTL_MS });
      return { grant: value, attempt: this.view(row) };
    });
  }

  read(caller: VerifiedCaller, attemptId: string): Promise<ThreadsAttempt> {
    return this.run("read", () => this.view(this.memberAttempt(this.authenticate(caller), attemptId)));
  }

  setPermission(caller: VerifiedCaller, input: Readonly<{ socialAccountId: string; desired: boolean; expected: boolean }>):
    Promise<Readonly<{ status: "updated" | "unchanged" | "stale"; permitted: boolean }>> {
    return this.run(`permission:${input.desired}`, () => {
      const user = this.authenticate(caller);
      // Granting runs the G5 lifecycle fence first (its locks come first); withdrawing never needs it.
      if (input.desired) {
        const service = this.services.get(user) ?? "not_registered";
        if (service === "not_registered" || service === "ended") throw new ThreadsStoreError("SERVICE_NOT_ACTIVE");
        if (service !== "active") throw new ThreadsStoreError("ACCOUNT_LIFECYCLE_BLOCKED");
      }
      const account = this.accounts.get(input.socialAccountId);
      const role = account ? this.memberships.get(`${account.brandId}|${user}`) : undefined;
      if (!account || !role) throw new ThreadsStoreError("ACCOUNT_NOT_FOUND");
      if (role !== "owner" && role !== "admin") throw new ThreadsStoreError("PUBLISH_FORBIDDEN");
      const current = this.permissions.has(input.socialAccountId);
      if (current !== input.expected) return { status: "stale", permitted: current };
      if (current === input.desired) return { status: "unchanged", permitted: current };
      if (!input.desired) {
        // Withdrawing is always possible: no lifecycle, connection or credential condition.
        this.permissions.delete(input.socialAccountId);
        return { status: "updated", permitted: false };
      }
      // Granting: everything a publish needs except the permission itself.
      if (this.inactiveBrands.has(account.brandId)) throw new ThreadsStoreError("WORKSPACE_INACTIVE");
      if (account.platform !== "threads") throw new ThreadsStoreError("PLATFORM_NOT_SUPPORTED");
      if (account.connection !== "identity_verified" || !account.threadsUserId) throw new ThreadsStoreError("CONNECTION_NOT_VERIFIED");
      if (!account.token) throw new ThreadsStoreError("CREDENTIALS_MISSING");
      if (this.expired(account)) throw new ThreadsStoreError("CREDENTIALS_EXPIRED");
      this.permissions.add(input.socialAccountId);
      return { status: "updated", permitted: true };
    });
  }

  accountState(caller: VerifiedCaller, socialAccountId: string): Promise<ThreadsAccountPublishState> {
    return this.run("state", () => {
      const user = this.authenticate(caller);
      const account = this.accounts.get(socialAccountId);
      if (!account || !this.memberships.has(`${account.brandId}|${user}`)) throw new ThreadsStoreError("ACCOUNT_NOT_FOUND");
      const rows = [...this.attempts.values()].filter((row) => row.socialAccountId === socialAccountId).sort((a, b) => b.createdAt - a.createdAt);
      const open = rows.find((row) => !THREADS_TERMINAL_STATUSES.has(row.status)) ?? null;
      const last = rows.find((row) => THREADS_TERMINAL_STATUSES.has(row.status)) ?? null;
      return {
        socialAccountId,
        permitted: this.permissions.has(socialAccountId),
        openAttempt: open ? this.view(open) : null,
        lastAttempt: last ? this.view(last) : null,
      };
    });
  }

  // --- server-side --------------------------------------------------------------------------------

  redeem(input: Readonly<{ attemptId: string; step: ThreadsClaimStep; grant: string }>): Promise<ThreadsRedeemedStep> {
    return this.run(`redeem:${input.step}`, () => {
      const row = this.attempts.get(input.attemptId);
      const grant = this.grants.get(input.attemptId);
      const rule = THREADS_CLAIM_RULES[input.step];
      if (!row || !grant || !rule || grant.value !== input.grant || grant.step !== input.step || grant.state !== "issued"
        || this.clock > grant.expiresAt || row.status !== (rule.to ?? rule.from)) {
        throw new ThreadsStoreError("GRANT_INVALID");
      }
      grant.state = "redeemed";
      // Re-checked here too: the account may have changed since the claim.
      const account = this.accounts.get(row.socialAccountId);
      const refusal = !account || account.platform !== "threads" || account.brandId !== row.brandId ? "ACCOUNT_NOT_FOUND"
        : account.connection !== "identity_verified" || !account.threadsUserId ? "CONNECTION_NOT_VERIFIED"
        : THREADS_PERMISSION_STEPS.has(input.step) && !this.permissions.has(row.socialAccountId) ? "MANUAL_PUBLISH_NOT_PERMITTED"
        : !account.token ? "CREDENTIALS_MISSING"
        : this.expired(account) ? "CREDENTIALS_EXPIRED"
        : null;
      if (refusal !== null || !account?.threadsUserId || !account.token) {
        // No credential left the store, so a claimed write was provably never sent.
        if (input.step === "create_container" || input.step === "publish") this.settle(row, "failed", "AUTHORIZATION_CHANGED");
        throw new ThreadsStoreError(refusal ?? "CREDENTIALS_MISSING");
      }
      return {
        credential: { threadsUserId: account.threadsUserId, accessToken: account.token },
        text: input.step === "create_container" || input.step === "reconcile" ? row.text : null,
        containerId: row.containerId,
        providerPostId: row.providerPostId,
        attemptCreatedAt: new Date(row.createdAt).toISOString(),
      };
    });
  }

  record(input: Readonly<{ attemptId: string; step: ThreadsClaimStep; grant: string; result: ThreadsStepResult }>): Promise<ThreadsAttempt> {
    return this.run(`record:${input.step}:${input.result.to}`, () => {
      const row = this.attempts.get(input.attemptId);
      const grant = this.grants.get(input.attemptId);
      if (!row || !grant || grant.value !== input.grant || grant.step !== input.step || grant.state !== "redeemed") {
        throw new ThreadsStoreError("GRANT_INVALID");
      }
      const allowed = THREADS_RECORD_TRANSITIONS.some(([step, from, to]) => step === input.step && from === row.status && to === input.result.to);
      if (!allowed) throw new ThreadsStoreError("STALE_STEP");
      const result = input.result;
      if ("errorCode" in result && !(THREADS_ATTEMPT_ERROR_CODES as readonly string[]).includes(result.errorCode)) throw new ThreadsStoreError("REQUEST_INVALID");
      row.status = result.to;
      row.updatedAt = this.clock;
      if (result.to === "container_created") row.containerId = result.containerId;
      if (result.to === "publish_returned") row.providerPostId = result.providerPostId;
      if (result.to === "published") {
        if (row.providerPostId !== null && row.providerPostId !== result.providerPostId) throw new ThreadsStoreError("STALE_STEP");
        row.providerPostId = result.providerPostId;
        row.permalink = result.permalink;
        row.errorCode = null;
      }
      if ("errorCode" in result) row.errorCode = result.errorCode;
      this.grants.delete(row.attemptId);
      const view = this.view(row);
      this.afterRecord(view);
      return view;
    });
  }

  // --- model internals ---------------------------------------------------------------------------------

  private run<T>(label: string, body: () => T): Promise<T> {
    this.log.push(label);
    try {
      return Promise.resolve(body());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private authenticate(caller: VerifiedCaller): string {
    const user = this.tokens.get(caller.bearerToken);
    if (!user || user !== caller.userId) throw new ThreadsStoreError("AUTH_REQUIRED");
    return user;
  }

  /** Unknown, past or within 5 minutes counts as expired (the SQL rule). */
  private expired(account: FakeAccount): boolean {
    const expiresAt = account.expiresAt === undefined ? this.clock + 50 * 24 * 3600 * 1000 : account.expiresAt;
    return expiresAt === null || expiresAt <= this.clock + 5 * 60 * 1000;
  }

  private settle(row: Row, status: ThreadsAttemptStatus, errorCode: string): void {
    row.status = status;
    row.errorCode = errorCode;
    row.updatedAt = this.clock;
    this.grants.delete(row.attemptId);
  }

  /** The SQL order: G5 lifecycle fence, then membership, role, workspace, provider, connection, credential, permission. */
  private authorize(user: string, accountId: string, requirePermission = true): FakeAccount {
    const service = this.services.get(user) ?? "not_registered";
    if (service === "not_registered" || service === "ended") throw new ThreadsStoreError("SERVICE_NOT_ACTIVE");
    if (service !== "active") throw new ThreadsStoreError("ACCOUNT_LIFECYCLE_BLOCKED");
    const account = this.accounts.get(accountId);
    const role = account ? this.memberships.get(`${account.brandId}|${user}`) : undefined;
    if (!account || !role) throw new ThreadsStoreError("ACCOUNT_NOT_FOUND");
    if (role !== "owner" && role !== "admin") throw new ThreadsStoreError("PUBLISH_FORBIDDEN");
    if (this.inactiveBrands.has(account.brandId)) throw new ThreadsStoreError("WORKSPACE_INACTIVE");
    if (account.platform !== "threads") throw new ThreadsStoreError("PLATFORM_NOT_SUPPORTED");
    if (account.connection !== "identity_verified" || !account.threadsUserId) throw new ThreadsStoreError("CONNECTION_NOT_VERIFIED");
    if (!account.token) throw new ThreadsStoreError("CREDENTIALS_MISSING");
    if (this.expired(account)) throw new ThreadsStoreError("CREDENTIALS_EXPIRED");
    if (requirePermission && !this.permissions.has(accountId)) throw new ThreadsStoreError("MANUAL_PUBLISH_NOT_PERMITTED");
    return account;
  }

  private memberAttempt(user: string, attemptId: string): Row {
    const row = this.attempts.get(attemptId);
    if (!row || !this.memberships.has(`${row.brandId}|${user}`)) throw new ThreadsStoreError("ATTEMPT_NOT_FOUND");
    return row;
  }

  private view(row: Row): ThreadsAttempt {
    return {
      attemptId: row.attemptId,
      socialAccountId: row.socialAccountId,
      status: row.status,
      containerId: row.containerId,
      providerPostId: row.providerPostId,
      permalink: row.permalink,
      errorCode: row.errorCode,
      replayed: false,
      createdAt: new Date(row.createdAt).toISOString(),
    };
  }
}
