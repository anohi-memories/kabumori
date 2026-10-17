import assert from "node:assert/strict";
import {
  type Attempt,
  type BeginRow,
  type ConsumeRow,
  createOfflineThreadsCandidate,
  MockRpcRefusal,
  type OfflinePorts,
  type Subject,
} from "./offline_candidate.ts";
import {
  hashThreadsState,
  readThreadsConnectConfig,
  THREADS_CONNECT_ENDPOINTS,
  THREADS_CONNECT_PREREQUISITES_MET,
  THREADS_CONNECT_SCOPES,
} from "../../functions/_shared/social/threads_connect_contract.ts";
import {
  completeRpcPayload,
  T13_REFUSAL_CODES,
  THREADS_CONNECT_RPC_REFUSAL_CODES,
} from "../../functions/_shared/social/threads_connect_rpc_contract.ts";

// All fixtures are invented. Tests have NO net/env/write permissions, no JWT or real provider ID.
const USER = "00000000-0000-0000-0000-000000000001";
const SESSION = "00000000-0000-0000-0000-000000000002";
const STATE_ID = "00000000-0000-0000-0000-000000000003";
const SUBJECT: Subject = { userId: USER, sessionId: SESSION };
const CREDENTIAL = "offline_mock_session_a";
const BIG_ID = "900719925474099312345";
const SHORT = "offline_dummy_short_token_123456789";
const LONG = "offline_dummy_long_token_987654321";
const KEY = "offline_dummy_hmac_key_0123456789abcdefghijklmnopqrstuvwxyz";
const CODE = "offline_dummy_code_123456789";
const SETTINGS = {
  appId: "123456789",
  appSecret: "offline_dummy_app_secret_0123456789abcdefghijklmnopqrstuvwxyz",
  redirectUri: "https://postona.example/oauth/threads",
};
const WORKSPACE: BeginRow = {
  brand_id: "sm_" + "1".repeat(24),
  social_account_id: "sa_" + "2".repeat(24),
};
type Stored = { attempt: Attempt; claimed: boolean; completed: boolean };
type MutableOfflinePorts = {
  -readonly [K in keyof OfflinePorts]: OfflinePorts[K];
};
const json = (body: string, status = 200) => new Response(body, { status });
const pending = <T>(): Promise<T> => new Promise(() => {});

function fixture() {
  let now = Date.parse("2026-10-11T00:00:00Z");
  let sequence = 0;
  const states = new Map<string, Stored>();
  const spentCodes = new Set<string>();
  const calls = {
    auth: 0,
    begin: 0,
    consume: 0,
    complete: 0,
    writes: 0,
    provider: 0,
    release: 0,
  };
  let entitlement: "active" | "inactive" | "locked" | "deleting" = "active";
  let authSubject: Subject | null = SUBJECT;
  let fault: "none" | "vault" | "rpc" | "unknown_applied" = "none";
  const fence = () => {
    if (entitlement !== "active") {
      throw new MockRpcRefusal(
        entitlement === "locked"
          ? "ACCOUNT_LOCKED"
          : entitlement === "deleting"
          ? "ACCOUNT_DELETION_IN_PROGRESS"
          : "SERVICE_NOT_ACTIVE",
      );
    }
  };
  const ports: MutableOfflinePorts = {
    mode: "offline-mock",
    deadlineMs: 30,
    now: () => now,
    randomBytes: () => new Uint8Array(32).fill(++sequence),
    auth: {
      verify: (credential) => {
        calls.auth++;
        return Promise.resolve(credential === CREDENTIAL ? authSubject : null);
      },
    },
    attempts: {
      remember: (hash, attempt) => {
        if (states.has(hash)) {
          return Promise.reject(new Error("duplicate dummy state"));
        }
        states.set(hash, { attempt, claimed: false, completed: false });
        return Promise.resolve();
      },
      claim: (hash, codeHash, subject) => {
        const state = states.get(hash);
        const codeKey = codeHash; // One provider app per coordinator, across mock sessions/users.
        // Atomic mock operation with no await between check and claim. No release method exists.
        if (
          !state || state.claimed ||
          state.attempt.subject.userId !== subject.userId ||
          state.attempt.subject.sessionId !== subject.sessionId ||
          spentCodes.has(codeKey)
        ) return Promise.resolve(null);
        state.claimed = true;
        spentCodes.add(codeKey);
        return Promise.resolve(state.attempt);
      },
    },
    rpc: {
      begin: (_subject, payload) => {
        calls.begin++;
        fence();
        assert.match(payload.p_state_hash, /^[0-9a-f]{64}$/);
        assert.equal(payload.p_redirect_uri, SETTINGS.redirectUri);
        return Promise.resolve(WORKSPACE);
      },
      consume: (_subject, payload) => {
        calls.consume++;
        fence();
        const state = states.get(payload.p_state_hash);
        if (!state || state.completed || state.attempt.expiresAtMs <= now) {
          throw new MockRpcRefusal("THREADS_OAUTH_STATE_NOT_CONSUMABLE");
        }
        // Read-only PR124 lookup; attempt claim is NOT a claim about DB consumption.
        return Promise.resolve({
          ...WORKSPACE,
          oauth_state_id: STATE_ID,
          redirect_uri: SETTINGS.redirectUri,
        });
      },
      complete: async (_subject, payload) => {
        calls.complete++;
        fence();
        const expected = await completeRpcPayload(KEY, {
          oauthStateId: STATE_ID,
          providerUserId: BIG_ID,
          handle: "offline_tester",
          accessToken: LONG,
        });
        assert.deepEqual(payload, expected);
        if (fault === "vault" || fault === "rpc") {
          throw new Error(`${SETTINGS.appSecret} ${LONG} fake failure`);
        }
        const state = [...states.values()].find((row) =>
          row.claimed && !row.completed
        );
        if (!state) {
          throw new MockRpcRefusal("THREADS_OAUTH_STATE_NOT_CONSUMABLE");
        }
        state.completed = true;
        calls.writes++;
        if (fault === "unknown_applied") return pending<void>();
      },
    },
    fakeHttp: (url, init) => {
      calls.provider++;
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      const path = new URL(url);
      if (path.href === THREADS_CONNECT_ENDPOINTS.codeExchange) {
        assert.equal(init?.method, "POST");
        const body = new URLSearchParams(init.body as string);
        assert.equal(body.get("code"), CODE);
        assert.equal(body.get("redirect_uri"), SETTINGS.redirectUri);
        return Promise.resolve(
          json(
            `{"access_token":"${SHORT}","token_type":"bearer","user_id":${BIG_ID}}`,
          ),
        );
      }
      if (
        path.origin + path.pathname ===
          THREADS_CONNECT_ENDPOINTS.longLivedExchange
      ) {
        assert.equal(path.searchParams.get("access_token"), SHORT);
        return Promise.resolve(
          json(
            `{"access_token":"${LONG}","token_type":"bearer","expires_in":5184000}`,
          ),
        );
      }
      assert.equal(
        path.origin + path.pathname,
        THREADS_CONNECT_ENDPOINTS.profile,
      );
      assert.equal(path.searchParams.get("access_token"), LONG);
      return Promise.resolve(
        json(`{"id":"${BIG_ID}","username":"offline_tester"}`),
      );
    },
  };
  const candidate = createOfflineThreadsCandidate(SETTINGS, KEY, ports);
  const begin = async () => {
    const started = await candidate.start(CREDENTIAL);
    assert.ok(started.ok);
    const url = new URL(started.authorizationUrl);
    const state = url.searchParams.get("state")!;
    return {
      started,
      state,
      callback: SETTINGS.redirectUri + "?" +
        new URLSearchParams({ code: CODE, state }),
    };
  };
  return {
    candidate,
    ports,
    states,
    calls,
    begin,
    setNow: (value: number) => {
      now = value;
    },
    setEntitlement: (value: typeof entitlement) => {
      entitlement = value;
    },
    setSubject: (value: Subject | null) => {
      authSubject = value;
    },
    setFault: (value: typeof fault) => {
      fault = value;
    },
  };
}
function safeFailure(result: unknown, error: string) {
  assert.deepEqual(result, { ok: false, error, restartRequired: true });
  const serialized = JSON.stringify(result);
  for (
    const sensitive of [
      KEY,
      SHORT,
      LONG,
      CODE,
      SETTINGS.appSecret,
      CREDENTIAL,
      USER,
      SESSION,
    ]
  ) {
    assert.ok(
      !serialized.includes(sensitive),
      "fixed failure cannot disclose fixtures",
    );
  }
}

Deno.test("mock start -> callback -> completion; lossless huge id, hash-only state, publishing off", async () => {
  const f = fixture();
  const { started, state, callback } = await f.begin();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(
    authorization.origin + authorization.pathname,
    THREADS_CONNECT_ENDPOINTS.authorize,
  );
  assert.equal(
    authorization.searchParams.get("scope"),
    THREADS_CONNECT_SCOPES.join(","),
  );
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    SETTINGS.redirectUri,
  );
  assert.ok(f.states.has(await hashThreadsState(state)));
  assert.ok(!JSON.stringify([...f.states]).includes(state));
  assert.deepEqual(await f.candidate.callback(CREDENTIAL, callback + "#_"), {
    ok: true,
    status: "connected",
    provider: "threads",
    publishEnabled: false,
  });
  assert.equal(f.calls.provider, 3);
  assert.equal(f.calls.writes, 1);
  safeFailure(
    await f.candidate.callback(CREDENTIAL, callback),
    "STATE_NOT_USABLE",
  );
  assert.equal(f.calls.provider, 3);
});

for (
  const credential of [
    null,
    "Bearer invalid-dummy",
    "",
    "offline_mock_wrong_session",
  ]
) {
  Deno.test(`unverified credentials denied (${credential === null ? "missing" : credential.length})`, async () => {
    const f = fixture();
    safeFailure(await f.candidate.start(credential), "AUTH_REQUIRED");
    safeFailure(
      await f.candidate.callback(credential, SETTINGS.redirectUri),
      "AUTH_REQUIRED",
    );
    assert.equal(
      f.calls.begin + f.calls.consume + f.calls.provider + f.calls.writes,
      0,
    );
  });
}
Deno.test("invalid verifier subject, auth timeout and exception are fixed failures", async () => {
  for (const kind of ["subject", "timeout", "throw"]) {
    const f = fixture();
    if (kind === "subject") {
      f.setSubject({ userId: "not-uuid", sessionId: SESSION });
    }
    if (kind === "timeout") f.ports.auth.verify = () => pending();
    if (kind === "throw") {
      f.ports.auth.verify = () => Promise.reject(new Error(KEY));
    }
    safeFailure(
      await f.candidate.start(CREDENTIAL),
      kind === "subject"
        ? "AUTH_REQUIRED"
        : kind === "timeout"
        ? "AUTH_UNAVAILABLE"
        : "START_FAILED",
    );
    assert.equal(f.calls.begin, 0);
  }
});

for (
  const [suffix, error] of [
    ["?error=access_denied", "AUTHORIZATION_DENIED"],
    ["?code=ok", "CALLBACK_INVALID"],
    ["?state=bad&code=ok", "CALLBACK_INVALID"],
    ["?error=other", "CALLBACK_INVALID"],
    ["?code=one&code=two&state=" + "a".repeat(43), "CALLBACK_INVALID"],
    ["?code=bad%20code&state=" + "a".repeat(43), "CALLBACK_INVALID"],
    [
      "?code=ok&state=" + "a".repeat(43) + "&user_id=ignored",
      "CALLBACK_INVALID",
    ],
  ] as const
) {
  Deno.test(`callback input refusal ${suffix.split("=")[0]}/${error}`, async () => {
    const f = fixture();
    safeFailure(
      await f.candidate.callback(CREDENTIAL, SETTINGS.redirectUri + suffix),
      error,
    );
    assert.equal(f.calls.consume + f.calls.provider + f.calls.writes, 0);
  });
}
Deno.test("exact redirect, missing/foreign state, foreign session and expiry refuse before provider", async () => {
  for (const kind of ["redirect", "foreign", "session", "missing", "expiry"]) {
    const f = fixture();
    const { callback } = await f.begin();
    let input = callback;
    if (kind === "redirect") {
      input = callback.replace("postona.example", "elsewhere.example");
    }
    if (kind === "foreign") {
      f.setSubject({
        userId: "00000000-0000-0000-0000-000000000004",
        sessionId: SESSION,
      });
    }
    if (kind === "session") {
      f.setSubject({
        userId: USER,
        sessionId: "00000000-0000-0000-0000-000000000005",
      });
    }
    if (kind === "missing") f.states.clear();
    if (kind === "expiry") f.setNow(Date.parse("2026-10-11T00:10:00Z"));
    safeFailure(
      await f.candidate.callback(CREDENTIAL, input),
      kind === "redirect" ? "CALLBACK_INVALID" : "STATE_NOT_USABLE",
    );
    assert.equal(f.calls.provider + f.calls.writes, 0);
  }
});

for (const lifecycle of ["inactive", "locked", "deleting"] as const) {
  Deno.test(`mock lifecycle ${lifecycle} denies begin and late complete without credential writes`, async () => {
    const error = lifecycle === "inactive"
      ? "SERVICE_NOT_ACTIVE"
      : lifecycle === "locked"
      ? "ACCOUNT_LOCKED"
      : "ACCOUNT_DELETION_IN_PROGRESS";
    const before = fixture();
    before.setEntitlement(lifecycle);
    safeFailure(await before.candidate.start(CREDENTIAL), error);
    assert.equal(before.states.size + before.calls.writes, 0);
    const f = fixture();
    const { callback } = await f.begin();
    const original = f.ports.fakeHttp;
    f.ports.fakeHttp = (url, init) => {
      f.setEntitlement(lifecycle);
      return original(url, init);
    };
    safeFailure(await f.candidate.callback(CREDENTIAL, callback), error);
    assert.equal(f.calls.complete, 1);
    assert.equal(f.calls.writes, 0);
    assert.equal(f.calls.release, 0);
  });
}
Deno.test("all PR124/G5 fixed refusal codes are sanitized and never retried", async () => {
  for (
    const code of [...T13_REFUSAL_CODES, ...THREADS_CONNECT_RPC_REFUSAL_CODES]
  ) {
    const f = fixture();
    f.ports.rpc.begin = () => Promise.reject(new MockRpcRefusal(code));
    safeFailure(await f.candidate.start(CREDENTIAL), code);
    assert.equal(f.states.size + f.calls.provider, 0);
  }
});
Deno.test("consume response mismatches and unavailable/expired state refuse before exchange", async () => {
  for (
    const kind of [
      "workspace",
      "account",
      "redirect",
      "state-id",
      "expired",
      "unavailable",
    ]
  ) {
    const f = fixture();
    const { callback } = await f.begin();
    f.ports.rpc.consume = () => {
      if (kind === "expired") {
        throw new MockRpcRefusal("THREADS_OAUTH_STATE_NOT_CONSUMABLE");
      }
      if (kind === "unavailable") return pending();
      const row: ConsumeRow = {
        ...WORKSPACE,
        oauth_state_id: STATE_ID,
        redirect_uri: SETTINGS.redirectUri,
      };
      return Promise.resolve({
        ...row,
        ...(kind === "workspace" ? { brand_id: "foreign" } : {}),
        ...(kind === "account" ? { social_account_id: "foreign" } : {}),
        ...(kind === "redirect"
          ? { redirect_uri: "https://different.example/" }
          : {}),
        ...(kind === "state-id" ? { oauth_state_id: "bad" } : {}),
      });
    };
    safeFailure(
      await f.candidate.callback(CREDENTIAL, callback),
      kind === "expired"
        ? "THREADS_OAUTH_STATE_NOT_CONSUMABLE"
        : kind === "unavailable"
        ? "CONSUME_FAILED"
        : "RPC_RESPONSE_INVALID",
    );
    assert.equal(f.calls.provider + f.calls.writes, 0);
  }
});

for (
  const [step, mode, expected] of [
    [1, "reject", "THREADS_CODE_EXCHANGE_REJECTED"],
    [1, "timeout", "THREADS_CODE_EXCHANGE_UNAVAILABLE"],
    [1, "throw", "THREADS_CODE_EXCHANGE_UNAVAILABLE"],
    [1, "malformed", "THREADS_CODE_EXCHANGE_MALFORMED"],
    [1, "oversized-id", "THREADS_CODE_EXCHANGE_MALFORMED"],
    [2, "reject", "THREADS_LONG_LIVED_EXCHANGE_REJECTED"],
    [2, "timeout", "THREADS_LONG_LIVED_EXCHANGE_UNAVAILABLE"],
    [2, "malformed", "THREADS_LONG_LIVED_EXCHANGE_MALFORMED"],
    [3, "reject", "THREADS_PROFILE_REJECTED"],
    [3, "timeout", "THREADS_PROFILE_UNAVAILABLE"],
    [3, "malformed", "THREADS_PROFILE_MALFORMED"],
    [3, "mismatch", "THREADS_IDENTITY_MISMATCH"],
  ] as const
) {
  Deno.test(`fake exchange step ${step} ${mode}: no completion/no code retry/no leaked response`, async () => {
    const f = fixture();
    const { callback } = await f.begin();
    const original = f.ports.fakeHttp;
    let requestCount = 0;
    f.ports.fakeHttp = (url, init) => {
      if (++requestCount !== step) return original(url, init);
      if (mode === "timeout") return pending();
      if (mode === "throw") return Promise.reject(new Error(`${LONG} ${KEY}`));
      if (mode === "reject") {
        return Promise.resolve(json(`${LONG} ${KEY}`, 403));
      }
      if (mode === "oversized-id") {
        return Promise.resolve(
          json(
            `{"access_token":"${SHORT}","token_type":"bearer","user_id":${
              "9".repeat(33)
            }}`,
          ),
        );
      }
      if (mode === "mismatch") {
        return Promise.resolve(
          json(`{"id":"123456789","username":"offline_tester"}`),
        );
      }
      return Promise.resolve(json(`{"unexpected":"${LONG}"}`));
    };
    safeFailure(await f.candidate.callback(CREDENTIAL, callback), expected);
    assert.equal(f.calls.complete + f.calls.writes + f.calls.release, 0);
    safeFailure(
      await f.candidate.callback(CREDENTIAL, callback),
      "STATE_NOT_USABLE",
    );
    assert.equal(requestCount, step);
  });
}
Deno.test("concurrent callback across candidate instances sharing mock coordinator exchanges only once", async () => {
  const f = fixture();
  const { callback } = await f.begin();
  const other = createOfflineThreadsCandidate(SETTINGS, KEY, f.ports);
  const results = await Promise.all([
    f.candidate.callback(CREDENTIAL, callback),
    other.callback(CREDENTIAL, callback),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(f.calls.provider, 3);
  assert.equal(f.calls.writes, 1);
  assert.equal(f.calls.release, 0);
});
Deno.test("Vault/RPC failure is not success or leaked token; unknown committed outcome never retries", async () => {
  for (const fault of ["vault", "rpc", "unknown_applied"] as const) {
    const f = fixture();
    const { callback } = await f.begin();
    f.setFault(fault);
    safeFailure(
      await f.candidate.callback(CREDENTIAL, callback),
      "COMPLETE_OUTCOME_UNKNOWN",
    );
    assert.equal(f.calls.writes, fault === "unknown_applied" ? 1 : 0);
    safeFailure(
      await f.candidate.callback(CREDENTIAL, callback),
      "STATE_NOT_USABLE",
    );
    assert.equal(f.calls.complete, 1);
    assert.equal(f.calls.provider, 3);
  }
});
Deno.test("auth/session revocation and late expiry during fake exchange deny completion", async () => {
  for (const kind of ["logout", "session", "expiry", "bad-clock"]) {
    const f = fixture();
    const { callback } = await f.begin();
    const original = f.ports.fakeHttp;
    f.ports.fakeHttp = (url, init) => {
      if (kind === "logout") f.setSubject(null);
      if (kind === "session") {
        f.setSubject({
          userId: USER,
          sessionId: "00000000-0000-0000-0000-000000000009",
        });
      }
      if (kind === "expiry") f.setNow(Date.parse("2026-10-11T00:10:00Z"));
      if (kind === "bad-clock") f.setNow(NaN);
      return original(url, init);
    };
    safeFailure(
      await f.candidate.callback(CREDENTIAL, callback),
      kind === "logout" || kind === "session"
        ? "AUTH_REQUIRED"
        : "STATE_NOT_USABLE",
    );
    assert.equal(f.calls.complete + f.calls.writes, 0);
  }
});
Deno.test("fake configuration only; invalid redirect/key/entropy cannot enable the production gate", async () => {
  const f = fixture();
  for (
    const redirectUri of [
      "http://postona.example/oauth/threads",
      "https://postona.example/callback#frag",
      "https://unregistered.invalid/callback",
      "https://postona.example/callback?extra=1",
      "https://user@postona.example/callback",
    ]
  ) {
    assert.throws(
      () =>
        createOfflineThreadsCandidate(
          { ...SETTINGS, redirectUri },
          KEY,
          f.ports,
        ),
      /OFFLINE_CONFIGURATION_INVALID/,
    );
  }
  assert.throws(
    () => createOfflineThreadsCandidate(SETTINGS, "invalid", f.ports),
    /OFFLINE_CONFIGURATION_INVALID/,
  );
  const invalid = createOfflineThreadsCandidate(SETTINGS, KEY, {
    ...f.ports,
    randomBytes: () => new Uint8Array(8),
  });
  safeFailure(await invalid.start(CREDENTIAL), "START_FAILED");
  assert.equal(THREADS_CONNECT_PREREQUISITES_MET, false);
  assert.equal(readThreadsConnectConfig(() => "true").status, "disabled");
});

Deno.test("uncertain code exchange cannot be retried through a newly begun state", async () => {
  const f = fixture();
  const first = await f.begin();
  let attempts = 0;
  f.ports.fakeHttp = () => {
    attempts++;
    return pending();
  };
  safeFailure(
    await f.candidate.callback(CREDENTIAL, first.callback),
    "THREADS_CODE_EXCHANGE_UNAVAILABLE",
  );
  const second = await f.begin();
  assert.notEqual(first.state, second.state);
  safeFailure(
    await f.candidate.callback(CREDENTIAL, second.callback),
    "STATE_NOT_USABLE",
  );
  assert.equal(attempts, 1);
  assert.equal(f.calls.writes + f.calls.release, 0);
});

Deno.test("same uncertain code remains blocked after a mock app-session change", async () => {
  const f = fixture();
  const first = await f.begin();
  let attempts = 0;
  f.ports.fakeHttp = () => {
    attempts++;
    return pending();
  };
  safeFailure(
    await f.candidate.callback(CREDENTIAL, first.callback),
    "THREADS_CODE_EXCHANGE_UNAVAILABLE",
  );
  f.setSubject({
    userId: USER,
    sessionId: "00000000-0000-0000-0000-000000000008",
  });
  const second = await f.begin();
  safeFailure(
    await f.candidate.callback(CREDENTIAL, second.callback),
    "STATE_NOT_USABLE",
  );
  assert.equal(attempts, 1);
});
Deno.test("all fixed completion refusals stay non-sensitive and cannot write/release mock credentials", async () => {
  for (
    const code of [...T13_REFUSAL_CODES, ...THREADS_CONNECT_RPC_REFUSAL_CODES]
  ) {
    const f = fixture();
    const { callback } = await f.begin();
    let completions = 0;
    f.ports.rpc.complete = () => {
      completions++;
      return Promise.reject(new MockRpcRefusal(code));
    };
    safeFailure(await f.candidate.callback(CREDENTIAL, callback), code);
    safeFailure(
      await f.candidate.callback(CREDENTIAL, callback),
      "STATE_NOT_USABLE",
    );
    assert.equal(completions, 1);
    assert.equal(f.calls.provider, 3);
    assert.equal(f.calls.writes + f.calls.release, 0);
  }
});
Deno.test("mock begin/attempt-coordinator failure returns no authorization URL or false success", async () => {
  for (
    const kind of [
      "bad-row",
      "begin-timeout",
      "remember-error",
      "claim-timeout",
    ]
  ) {
    const f = fixture();
    if (kind === "bad-row") {
      f.ports.rpc.begin = () =>
        Promise.resolve({ ...WORKSPACE, brand_id: "wrong" });
    }
    if (kind === "begin-timeout") f.ports.rpc.begin = () => pending();
    if (kind === "remember-error") {
      f.ports.attempts.remember = () => Promise.reject(new Error(KEY));
    }
    if (kind === "claim-timeout") {
      const { callback } = await f.begin();
      f.ports.attempts.claim = () => pending();
      safeFailure(
        await f.candidate.callback(CREDENTIAL, callback),
        "STATE_UNAVAILABLE",
      );
    } else {
      safeFailure(
        await f.candidate.start(CREDENTIAL),
        kind === "bad-row" ? "RPC_RESPONSE_INVALID" : "START_FAILED",
      );
    }
    assert.equal(f.calls.provider + f.calls.writes, 0);
  }
});
Deno.test("response body timeout is bounded; no raw errors/tokens are logged or returned", async () => {
  const f = fixture();
  const { callback } = await f.begin();
  f.ports.fakeHttp = () => {
    const response = json("unused");
    response.text = () => pending();
    return Promise.resolve(response);
  };
  const logs: unknown[][] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  try {
    console.log = (...values) => {
      logs.push(values);
    };
    console.warn = (...values) => {
      logs.push(values);
    };
    console.error = (...values) => {
      logs.push(values);
    };
    safeFailure(
      await f.candidate.callback(CREDENTIAL, callback),
      "THREADS_CODE_EXCHANGE_UNAVAILABLE",
    );
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(logs, []);
  assert.equal(f.calls.complete + f.calls.writes + f.calls.release, 0);
});
