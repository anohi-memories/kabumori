// 会社員AIラボ: 同じ開発イベントを切り口だけ変えて連投しないための「X送信前の確保（claim）」のテスト。
// 実X投稿・DB・OpenAI呼び出しは一切なし（generate / publish / fetch は全てスタブ）。
//
// DB の確保規則（migration 20261004090000_ai_lab_topic_claims.sql）は、下の ClaimDb がそのまま写した
// インメモリ実装で再現する（RPC へ実際に送られる JSON をそのまま検証する）。実 SQL そのもの（ロック・部分UNIQUE・
// 正規ペイロード・隔離・publish 時刻起点のクールダウン・ACL/owner/継承・ドリフト拒否・2セッション同時実行）は
// supabase/tests/ai_lab_topic_claims_run.sh が使い捨ての PostgreSQL で検証する。
//
// H1 の RED evidence の各ケースは「H1:」で始まるテストに移植している:
//   codex/h1-pr82-event-review-20261003 @ 100ab65f / codex/h1-pr82-claims-20261004 @ 0801619f
import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_LAB_EVENT_KEY_PATTERN,
  type AiLabTopicCandidate,
  buildAiLabTopicCandidates,
  EVERGREEN_THEME_TAGS,
  EVERGREEN_TOPIC_SEEDS,
  isValidDiaryEventId,
  loadAiLabDevDiaryMarkdown,
  parseDevDiaryMarkdown,
  sanitizeDiaryEntry,
} from "./ai_lab_dev_diary_context.ts";
import { AiLabConfirmedPostCompletionError, dispatchAiLabScheduledBrandPost } from "./ai_lab_scheduled_brand_post.ts";
import {
  type AiLabClaimedTopic,
  type AiLabTopicPort,
  claimAiLabTopic,
  createAiLabTopicPort,
} from "./ai_lab_brand_post_store.ts";
import { AiLabProviderNoPostError, type AiLabXRequestResult, sendAiLabXPost } from "./ai_lab_provider_outcome.ts";
import { fingerprintText } from "./cross_brand_dedupe.ts";
import { type BrandOperationalSettings, resolveBrandContext } from "./brand_context.ts";
import { VaultAccountXAuth } from "../../x-test-post/vault_account_auth.ts";

// ---------------------------------------------------------------------------------------------------
// ClaimDb: claim_ai_lab_topic / start / release / mark_ambiguous / settle の規則を写したインメモリ版。
// 各メソッドは同期的に完結する（＝DB 側のブランド単位ロックの中で1つずつ処理されるのと同じ）。
// ---------------------------------------------------------------------------------------------------
type State = "claimed" | "provider_started" | "ambiguous" | "published" | "released" | "expired";
type Row = {
  claimId: string;
  scheduledPostId: string;
  kind: "diary" | "evergreen";
  eventKey: string;
  unitKey: string;
  themeTags: string[];
  state: State;
  claimedAt: number;
  leaseUntil: number;
  publishedAt: number | null;
  xPostId: string | null;
  reason: string | null;
};
type WireCandidate = { kind: string; event_key: string; unit_key: string; theme_tags: string[] };
const ACTIVE = new Set<State>(["claimed", "provider_started", "ambiguous", "published"]);
const UNRESOLVED = new Set<State>(["claimed", "provider_started", "ambiguous"]);
const HOUR = 3_600_000;
const sorted = (values: readonly string[]) => [...values].sort().join(",");

class ClaimDb {
  rows: Row[] = [];
  now = Date.parse("2026-10-01T03:00:00Z");
  private seq = 0;

  /** DB と同じ正規形の検証（全件を先に。1件でも不正なら何も変えずに INVALID_ARGUMENT）。 */
  private validate(candidates: unknown) {
    const invalid = () => new Error("AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT");
    if (!Array.isArray(candidates) || candidates.length > 64) throw invalid();
    const seen = new Set<string>();
    for (const c of candidates as Record<string, unknown>[]) {
      if (typeof c !== "object" || c === null || sorted(Object.keys(c)) !== "event_key,kind,theme_tags,unit_key") throw invalid();
      const { kind, event_key: key, unit_key: unit, theme_tags: tags } = c;
      if (typeof kind !== "string" || typeof key !== "string" || typeof unit !== "string" || !Array.isArray(tags)) throw invalid();
      if (seen.has(key)) throw invalid();
      seen.add(key);
      if (kind === "evergreen") {
        const index = /^evergreen-(\d{1,2})$/u.exec(key)?.[1];
        const canonical = index === undefined ? undefined : EVERGREEN_THEME_TAGS[Number(index)];
        if (!canonical || unit !== key || sorted(tags as string[]) !== sorted(canonical)) throw invalid();
      } else if (kind === "diary") {
        if (key.length > 70 || !/^diary:\d{8}-[a-z][a-z0-9]*(-[a-z0-9]+)*$/u.test(key)) throw invalid();
        if (!new RegExp(`^${key}#(changed|difficulty|decided|angle[1-9][0-9]?)$`, "u").test(unit) || tags.length !== 0) throw invalid();
      } else {
        throw invalid();
      }
    }
    return candidates as WireCandidate[];
  }

  claim(scheduledPostId: string, payload: unknown, leaseSeconds = 900) {
    const candidates = this.validate(payload);
    for (const row of this.rows) {
      if (row.state === "claimed" && row.leaseUntil <= this.now) Object.assign(row, { state: "expired", reason: "LEASE_EXPIRED" });
    }
    const existing = this.rows.find((row) => row.scheduledPostId === scheduledPostId && ACTIVE.has(row.state));
    if (existing) return { claim: null, rejected: [], conflict: `SCHEDULE_ALREADY_CLAIMED:${existing.state.toUpperCase()}` };
    const rejected: Array<{ eventKey: string; reason: string }> = [];
    const evergreen = this.rows.filter((row) => row.kind === "evergreen");
    const reject = (eventKey: string, reason: string) => rejected.push({ eventKey, reason });
    for (const c of candidates) {
      let tags: string[] = [];
      if (c.kind === "diary") {
        const hit = this.rows.find((row) => row.kind === "diary" && row.eventKey === c.event_key && ACTIVE.has(row.state));
        if (hit) {
          reject(c.event_key, `EVENT_${hit.state.toUpperCase()}`);
          continue;
        }
      } else {
        tags = [...EVERGREEN_THEME_TAGS[Number(c.event_key.split("-")[1])]];
        const overlap = (row: Row) => row.themeTags.some((tag) => tags.includes(tag));
        const unresolvedSeed = evergreen.find((row) => row.eventKey === c.event_key && UNRESOLVED.has(row.state));
        if (unresolvedSeed) {
          reject(c.event_key, `EVERGREEN_SEED_${unresolvedSeed.state.toUpperCase()}`);
          continue;
        }
        const publishedWithin = (row: Row, hours: number) =>
          row.state === "published" && row.publishedAt !== null && row.publishedAt > this.now - hours * HOUR;
        if (evergreen.some((row) => row.eventKey === c.event_key && publishedWithin(row, 72))) {
          reject(c.event_key, "EVERGREEN_SEED_COOLDOWN");
          continue;
        }
        if (tags.length > 0 && evergreen.some((row) => overlap(row) && UNRESOLVED.has(row.state))) {
          reject(c.event_key, "EVERGREEN_THEME_UNRESOLVED");
          continue;
        }
        if (tags.length > 0 && evergreen.some((row) => overlap(row) && publishedWithin(row, 48))) {
          reject(c.event_key, "EVERGREEN_THEME_COOLDOWN");
          continue;
        }
      }
      const row: Row = {
        claimId: `00000000-0000-0000-0000-${String(++this.seq).padStart(12, "0")}`,
        scheduledPostId,
        kind: c.kind as Row["kind"],
        eventKey: c.event_key,
        unitKey: c.unit_key,
        themeTags: tags,
        state: "claimed",
        claimedAt: this.now,
        leaseUntil: this.now + leaseSeconds * 1000,
        publishedAt: null,
        xPostId: null,
        reason: null,
      };
      this.rows.push(row);
      return { claim: { claimId: row.claimId, kind: row.kind, eventKey: row.eventKey, unitKey: row.unitKey }, rejected, conflict: null };
    }
    return { claim: null, rejected, conflict: null };
  }

  /** テスト用: 優先順の候補（TS の形）をそのまま RPC の JSON に直して確保する。 */
  claimCandidates(scheduledPostId: string, candidates: readonly AiLabTopicCandidate[]) {
    return this.claim(
      scheduledPostId,
      candidates.map((c) => ({ kind: c.kind, event_key: c.eventKey, unit_key: c.unitKey, theme_tags: [...c.themeTags] })),
    );
  }

  private mine(claimId: string, scheduledPostId: string, eventKey: string) {
    return this.rows.find((row) => row.claimId === claimId && row.scheduledPostId === scheduledPostId && row.eventKey === eventKey);
  }

  start(claimId: string, scheduledPostId: string, eventKey: string) {
    const row = this.mine(claimId, scheduledPostId, eventKey);
    if (!row || row.state !== "claimed" || row.leaseUntil <= this.now) return false;
    row.state = "provider_started";
    return true;
  }

  release(claimId: string, scheduledPostId: string, eventKey: string, reason: string) {
    const row = this.mine(claimId, scheduledPostId, eventKey);
    if (!row) return "NOT_FOUND";
    const provenNoPost = /^PROVIDER_NO_POST:(NOT_SENT|HTTP_400|HTTP_401|HTTP_422|HTTP_429)$/u.test(reason);
    if (row.state === "claimed" || (row.state === "provider_started" && provenNoPost)) {
      Object.assign(row, { state: "released", reason });
      return "RELEASED";
    }
    return row.state.toUpperCase();
  }

  ambiguous(claimId: string, scheduledPostId: string, eventKey: string, reason: string) {
    const row = this.mine(claimId, scheduledPostId, eventKey);
    if (!row) return "NOT_FOUND";
    if (row.state === "provider_started") {
      Object.assign(row, { state: "ambiguous", reason });
      return "AMBIGUOUS";
    }
    return row.state.toUpperCase();
  }

  settle(claimId: string, scheduledPostId: string, eventKey: string, unitKey: string, xPostId: string) {
    const row = this.rows.find((r) => r.claimId === claimId);
    if (!row) throw new Error("AI_LAB_TOPIC_CLAIM_NOT_FOUND");
    if (row.scheduledPostId !== scheduledPostId || row.eventKey !== eventKey || row.unitKey !== unitKey) {
      throw new Error("AI_LAB_TOPIC_CLAIM_IDENTITY_CONFLICT");
    }
    if (row.state === "published") {
      if (row.xPostId === xPostId) return "IDEMPOTENT";
      throw new Error("AI_LAB_TOPIC_CLAIM_X_POST_CONFLICT");
    }
    if (row.state !== "provider_started" && row.state !== "ambiguous") throw new Error("AI_LAB_TOPIC_CLAIM_STATE_CONFLICT");
    Object.assign(row, { state: "published", xPostId, publishedAt: this.now, reason: null });
    return "PUBLISHED";
  }

  stateOf(eventKey: string) {
    return this.rows.filter((row) => row.eventKey === eventKey).map((row) => row.state);
  }

  /** 本番の createAiLabTopicPort に、RPC の代わりにこの ClaimDb を返す fetch を渡したポート。 */
  port(scheduledPostId: string, candidates: readonly AiLabTopicCandidate[], hooks: Partial<AiLabTopicPort> = {}): AiLabTopicPort {
    const fetchImpl = ((url: string, init?: RequestInit) => {
      const name = String(url).split("/rpc/")[1];
      const body = JSON.parse(String(init?.body));
      try {
        let result: unknown;
        if (name === "claim_ai_lab_topic") {
          const r = this.claim(body.p_scheduled_post_id, body.p_candidates, body.p_lease_seconds);
          result = {
            claim: r.claim && { claim_id: r.claim.claimId, kind: r.claim.kind, event_key: r.claim.eventKey, unit_key: r.claim.unitKey },
            rejected: r.rejected.map((x) => ({ event_key: x.eventKey, reason: x.reason })),
            ...(r.conflict ? { conflict: r.conflict } : {}),
          };
        } else if (name === "start_ai_lab_topic_provider") {
          result = this.start(body.p_claim_id, body.p_scheduled_post_id, body.p_event_key);
        } else if (name === "release_ai_lab_topic_claim") {
          result = this.release(body.p_claim_id, body.p_scheduled_post_id, body.p_event_key, body.p_reason);
        } else if (name === "mark_ai_lab_topic_claim_ambiguous") {
          result = this.ambiguous(body.p_claim_id, body.p_scheduled_post_id, body.p_event_key, body.p_reason);
        } else {
          result = this.settle(body.p_claim_id, body.p_scheduled_post_id, body.p_event_key, body.p_unit_key, body.p_x_post_id);
        }
        return Promise.resolve(new Response(JSON.stringify(result), { status: 200 }));
      } catch (error) {
        return Promise.resolve(new Response(JSON.stringify({ message: (error as Error).message, code: "P0001" }), { status: 400 }));
      }
    }) as typeof fetch;
    const real = createAiLabTopicPort({ supabaseUrl: "https://fixture.invalid", serviceRoleKey: "fixture-only", scheduledPostId, candidates, fetchImpl });
    return { ...real, ...hooks };
  }
}

// ---------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------
const INCIDENT_EVENT = `
## 2026-09-30
event_id: 20260930-x-auth-test-account-overlap
changed: X認証まわりの実データ接続を確認した
difficulty: テスト用アカウントの重複に気づいた
decided: 本番影響を避けるため一旦停止した
angle: 実データ接続では重複に気づくことが重要だった
angle: 本番影響を出さないため止める判断をした
`;
const OTHER_EVENT = `
## 2026-10-01
event_id: 20261001-notification-settings
changed: 通知設定の画面で、種類ごとにオンオフできるようにした
difficulty: 古い設定の移行で、既存の設定が消えそうになった
decided: 移行処理を先に作ってから画面を差し替えた
`;
const NOW = new Date("2026-10-01T03:00:00Z");
const INCIDENT_KEY = "diary:20260930-x-auth-test-account-overlap";
const OTHER_KEY = "diary:20261001-notification-settings";

function candidatesFor(markdown: string, rotationIndex = 0, now = NOW) {
  return buildAiLabTopicCandidates({ markdown, now, rotationIndex }).candidates;
}
const diaryOnly = (markdown: string, rotationIndex = 0) => candidatesFor(markdown, rotationIndex).filter((c) => c.kind === "diary");
const evergreenOnly = (...indexes: number[]) => indexes.map((i) => candidatesFor("").find((c) => c.eventKey === `evergreen-${i}`)!);

const settings: BrandOperationalSettings = {
  brand_id: "ai_salaryman_lab",
  fixed_hashtags: [],
  note_url: null,
  image_policy: {},
  enabled_post_types: ["brand_post"],
};
const context = resolveBrandContext(
  { id: "ai_salaryman_lab", display_name: "fixture", is_active: true, publish_mode: "live", code_profile_key: "ai_salaryman_lab_v1" },
  { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", handle: "kaishain_ai_lab", publish_enabled: true, oauth_client_ref: "default" },
  settings,
);
const TEXTS = [
  "Xの接続画面で、前回のアカウントが残る問題を見つけた。 #個人開発",
  "接続先のアカウントが重複していたので、設定画面の確認を止めた。 #個人開発",
];
function draftOf(text: string) {
  return { brandId: "ai_salaryman_lab", postType: "brand_post", text, model: "fixture", inputTokens: 1, outputTokens: 1, apiCostUsd: 0, characterCount: Array.from(text).length };
}
const sid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** 1スケジュール分の dispatch。X 呼び出し回数を数える。 */
function dispatch(
  db: ClaimDb,
  index: number,
  candidates: readonly AiLabTopicCandidate[],
  overrides: Partial<Parameters<typeof dispatchAiLabScheduledBrandPost>[0]> = {},
  counter = { x: 0, completions: 0, topics: [] as string[] },
) {
  const scheduledPostId = sid(1000 + index);
  return {
    counter,
    run: () =>
      dispatchAiLabScheduledBrandPost({
        context,
        postType: "brand_post",
        scheduledPostId,
        openAiApiKey: "fixture-only",
        topic: db.port(scheduledPostId, candidates),
        loadRecentFingerprints: () => Promise.resolve([]),
        generate: ({ topicSeed }) => {
          counter.topics.push(topicSeed);
          return Promise.resolve(draftOf(TEXTS[index % 2]));
        },
        publishText: () => {
          counter.x += 1;
          return Promise.resolve({ data: { id: String(1790000000000000000n + BigInt(index)) } });
        },
        completePublishedPost: () => {
          counter.completions += 1;
          return Promise.resolve({ fingerprintPersisted: true });
        },
        ...overrides,
      }),
  };
}

// ---------------------------------------------------------------------------------------------------
// 同時実行・フェンシング（前回の修正の維持）
// ---------------------------------------------------------------------------------------------------
test("(18) H1: two schedules that interleave (both pass every guard) cannot both publish the same event; X is reached once for it", async () => {
  const db = new ClaimDb();
  let reads = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const shared = { x: 0, completions: 0, topics: [] as string[] };
  const both = [0, 1].map((i) =>
    dispatch(db, i, diaryOnly(INCIDENT_EVENT, i), {
      loadRecentFingerprints: async () => {
        if (++reads === 2) release();
        await barrier;
        return [];
      },
    }, shared)
  );
  // 負けた側は確保の時点で止まり、指紋の読み込みまで来ない。その場合もバリアを開ける。
  const outcomes = await Promise.allSettled(both.map((d) =>
    d.run().catch((error) => {
      release();
      throw error;
    })
  ));
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
  const loser = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
  assert.match(loser.reason.message, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  assert.equal(shared.x, 1, `same event reached X ${shared.x} times`);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["published"]);
});

test("(18) with evergreen available, the second schedule publishes a different topic -- never the same event", async () => {
  const db = new ClaimDb();
  const shared = { x: 0, completions: 0, topics: [] as string[] };
  const results = await Promise.all([0, 1].map((i) => dispatch(db, i, candidatesFor(INCIDENT_EVENT, i), {}, shared).run()));
  assert.equal(shared.x, 2);
  assert.notEqual(results[0].topicEventKey, results[1].topicEventKey);
  assert.equal(results.filter((r) => r.topicEventKey === INCIDENT_KEY).length, 1);
});

test("(19) a process that stops before X frees the event only after its lease, and the stale worker is fenced out", async () => {
  const db = new ClaimDb();
  const port = db.port(sid(2000), diaryOnly(INCIDENT_EVENT));
  const stale = await port.claim(); // then the worker "crashes" during generation
  assert.equal(db.claimCandidates(sid(2001), diaryOnly(INCIDENT_EVENT)).claim, null, "still leased");
  db.now += 16 * 60_000;
  const fresh = db.claimCandidates(sid(2002), diaryOnly(INCIDENT_EVENT));
  assert.equal(fresh.claim?.eventKey, INCIDENT_KEY);
  assert.equal(await port.startProvider(stale), false, "stale worker can never reach X");
  assert.equal(await port.release(stale, "PRE_X_FAILED"), "EXPIRED", "stale worker cannot release the new claim");
  await assert.rejects(() => port.settlePublished(stale, "1"), /AI_LAB_TOPIC_CLAIM_STATE_CONFLICT/u);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["expired", "claimed"]);
});

// ---------------------------------------------------------------------------------------------------
// X 前の失敗は自分の確保だけを解除する
// ---------------------------------------------------------------------------------------------------
test("generation failure releases the pre-X claim (no X) and the event can be used later", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { generate: () => Promise.reject(new Error("BRAND_POST_GENERATION_FAILED:500")) });
  await assert.rejects(d.run, /BRAND_POST_GENERATION_FAILED/u);
  assert.equal(d.counter.x, 0);
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", "PRE_X_GENERATION_FAILED"]]);
  assert.equal((await dispatch(db, 1, diaryOnly(INCIDENT_EVENT)).run()).topicEventKey, INCIDENT_KEY);
});

test("(21) content guard failure releases the pre-X claim (existing guard kept)", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { generate: () => Promise.resolve(draftOf("個人開発は、コードを書かない日もある。")) });
  await assert.rejects(d.run, /AI_LAB_CONTENT_DIVERSITY_REJECTED/u);
  assert.equal(d.counter.x, 0);
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", "PRE_X_CONTENT_REJECTED"]]);
});

test("(22) cross-brand fingerprint block still stops before X and releases the claim", async () => {
  const db = new ClaimDb();
  const hash = await fingerprintText(TEXTS[0]);
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), {
    loadRecentFingerprints: () => Promise.resolve([{ brandId: "kabumori", normalizedTextSha256: hash, publishedAt: NOW.toISOString() }]),
  });
  await assert.rejects(d.run, /AI_LAB_CROSS_BRAND_DUPLICATE/u);
  assert.equal(d.counter.x, 0);
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", "PRE_X_FINGERPRINT_BLOCKED"]]);
});

test("X never started (provider start refused) -> no X call, claim released", async () => {
  const db = new ClaimDb();
  const port = db.port(sid(1000), diaryOnly(INCIDENT_EVENT));
  let x = 0;
  await assert.rejects(
    () =>
      dispatchAiLabScheduledBrandPost({
        context, postType: "brand_post", scheduledPostId: sid(1000), openAiApiKey: "fixture-only",
        topic: { ...port, startProvider: () => Promise.resolve(false) },
        loadRecentFingerprints: () => Promise.resolve([]),
        generate: () => Promise.resolve(draftOf(TEXTS[0])),
        publishText: () => {
          x += 1;
          return Promise.resolve({ data: { id: "1" } });
        },
        completePublishedPost: () => Promise.resolve({ fingerprintPersisted: true }),
      }),
    /AI_LAB_TOPIC_CLAIM_LOST/u,
  );
  assert.equal(x, 0);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["released"]);
});

// ---------------------------------------------------------------------------------------------------
// 実際の X/Vault エラー契約に基づく分類（ai_lab_provider_outcome.ts）
// ---------------------------------------------------------------------------------------------------
/** 実物の VaultAccountXAuth（トークン更新は無効、Vault RPC はスタブ）。X リクエストもスタブで、実通信はしない。 */
async function realVaultAuth() {
  return await VaultAccountXAuth.load(
    { scheduledPostId: sid(1), socialAccountId: "fixture", brandId: "ai_salaryman_lab" },
    {
      read: () => Promise.resolve({ accessToken: "fixture-only", accessExpiresAt: null }),
      begin: () => Promise.reject(new Error("should not refresh")),
      commit: () => Promise.reject(new Error("should not refresh")),
      release: () => Promise.reject(new Error("should not refresh")),
      recordRejectedAfterRefresh: () => Promise.resolve("RECORDED"),
      recordAccessUnauthorized: () => Promise.resolve("RECORDED"),
    },
    { resolveClient: () => Promise.reject(new Error("should not refresh")), refreshEnabled: false },
  );
}

function publishThroughVault(responder: () => Promise<AiLabXRequestResult>) {
  return async () => {
    const auth = await realVaultAuth();
    return await sendAiLabXPost({ send: (request) => auth.send(request), request: () => responder() });
  };
}

test("(8) H1: the real Vault wrapper turns X's 401 into X_ACCESS_TOKEN_UNAUTHORIZED -- still classified as proven no-post and released", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), {
    publishText: publishThroughVault(() => Promise.resolve({ status: 401, body: {} })),
  });
  await assert.rejects(d.run, /X_ACCESS_TOKEN_UNAUTHORIZED/u); // outer error code unchanged
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", "PROVIDER_NO_POST:HTTP_401"]]);
  assert.equal((await dispatch(db, 1, diaryOnly(INCIDENT_EVENT)).run()).topicEventKey, INCIDENT_KEY);
});

test("(8) X answered 400 / 422 / 429 through the real wrapper -> proven no-post, released (outer message unchanged)", async () => {
  for (const status of [400, 422, 429]) {
    const db = new ClaimDb();
    const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), {
      publishText: publishThroughVault(() => Promise.resolve({ status, body: {} })),
    });
    await assert.rejects(d.run, (error) => (error as Error).message === `X_REQUEST_FAILED:${status}`);
    assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", `PROVIDER_NO_POST:HTTP_${status}`]]);
  }
});

test("(9) 403 / 5xx / 3xx / 408, timeout, network failure and response-read failure -> ambiguous, never released", async () => {
  const responders: Array<[string, () => Promise<AiLabXRequestResult>]> = [
    ["403", () => Promise.resolve({ status: 403, body: {} })],
    ["500", () => Promise.resolve({ status: 500, body: {} })],
    ["503", () => Promise.resolve({ status: 503, body: {} })],
    ["302", () => Promise.resolve({ status: 302, body: {} })],
    ["408", () => Promise.resolve({ status: 408, body: {} })],
    ["timeout", () => Promise.reject(new DOMException("signal timed out", "TimeoutError"))],
    ["network", () => Promise.reject(new TypeError("fetch failed"))],
    ["read failure", () => Promise.reject(new Error("X_REQUEST_FAILED:401"))], // even a 401-looking message from a throw is not proof
  ];
  for (const [label, responder] of responders) {
    const db = new ClaimDb();
    const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { publishText: publishThroughVault(responder) });
    await assert.rejects(d.run);
    assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["ambiguous", "PROVIDER_OUTCOME_UNKNOWN"]], label);
    assert.equal(db.claimCandidates(sid(9999), diaryOnly(INCIDENT_EVENT)).claim, null, label);
  }
});

test("(8) a failure before any X request (send never called the request) is proven no-post: NOT_SENT", async () => {
  await assert.rejects(
    () => sendAiLabXPost({ send: () => Promise.reject(new Error("X_REFRESH_UNAVAILABLE")), request: () => Promise.resolve({ status: 201, body: {} }) }),
    (error) => error instanceof AiLabProviderNoPostError && error.evidence === "NOT_SENT" && error.message === "X_REFRESH_UNAVAILABLE",
  );
  // 401 then a retry that throws: the retry may have reached X -> not proven
  let calls = 0;
  await assert.rejects(
    () =>
      sendAiLabXPost({
        send: async (request) => {
          await request("a");
          return await request("b");
        },
        request: () => (++calls === 1 ? Promise.resolve({ status: 401, body: {} }) : Promise.reject(new TypeError("fetch failed"))),
      }),
    (error) => !(error instanceof AiLabProviderNoPostError),
  );
});

test("every observed X response must be a no-post status: an earlier 5xx is never hidden by a later 401", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      sendAiLabXPost({
        send: async (request) => {
          await request("a");
          return await request("b");
        },
        request: () => Promise.resolve({ status: ++calls === 1 ? 500 : 401, body: {} }),
      }),
    (error) => !(error instanceof AiLabProviderNoPostError) && (error as Error).message === "X_REQUEST_FAILED:401",
  );
  calls = 0;
  await assert.rejects(
    () =>
      sendAiLabXPost({
        send: async (request) => {
          await request("a");
          return await request("b");
        },
        request: () => Promise.resolve({ status: ++calls === 1 ? 401 : 429, body: {} }),
      }),
    (error) => error instanceof AiLabProviderNoPostError && error.evidence === "HTTP_429",
  );
});

test("a successful send returns X's body; the old string-matching classifier is gone", async () => {
  const body = await sendAiLabXPost({ send: (request) => request("t"), request: () => Promise.resolve({ status: 201, body: { data: { id: "9" } } }) });
  assert.deepEqual(body, { data: { id: "9" } });
  const { readFile } = await import("node:fs/promises");
  const dispatcher = await readFile(new URL("./ai_lab_scheduled_brand_post.ts", import.meta.url), "utf8");
  assert.doesNotMatch(dispatcher, /X_REQUEST_FAILED|definitiveProviderRejection|PROVIDER_REJECTED/u);
  assert.match(dispatcher, /error instanceof AiLabProviderNoPostError/u);
});

// ---------------------------------------------------------------------------------------------------
// X 開始後は再開放しない
// ---------------------------------------------------------------------------------------------------
test("H1: provider started then response lost -> ambiguous; the next schedule cannot use the event", async () => {
  const db = new ClaimDb();
  const shared = { x: 0, completions: 0, topics: [] as string[] };
  await assert.rejects(dispatch(db, 0, diaryOnly(INCIDENT_EVENT), {
    publishText: () => {
      shared.x += 1;
      return Promise.reject(new Error("response lost after provider accepted"));
    },
  }, shared).run);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["ambiguous"]);
  await assert.rejects(dispatch(db, 1, diaryOnly(INCIDENT_EVENT, 1), {}, shared).run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  assert.equal(shared.x, 1, "ambiguous X outcome must not let the next slot republish");
});

test("X response without a post id -> ambiguous, not reopened", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { publishText: () => Promise.resolve({ data: {} }) });
  await assert.rejects(d.run, /X_RESPONSE_MISSING_POST_ID/u);
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["ambiguous", "PROVIDER_RESPONSE_WITHOUT_ID"]]);
  assert.equal(db.claimCandidates(sid(9999), diaryOnly(INCIDENT_EVENT)).claim, null);
});

test("H1: process stops inside X -> even a day later the next schedule cannot claim the event", async () => {
  const db = new ClaimDb();
  let entered!: () => void;
  const inX = new Promise<void>((resolve) => (entered = resolve));
  const hung = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), {
    publishText: () => {
      entered();
      return new Promise(() => {}); // never returns: crash/hang inside X
    },
  });
  void hung.run().catch(() => {});
  await inX;
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["provider_started"]);
  db.now += 24 * HOUR;
  await assert.rejects(dispatch(db, 1, diaryOnly(INCIDENT_EVENT, 1)).run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
});

// ---------------------------------------------------------------------------------------------------
// X 成功・確定・冪等性
// ---------------------------------------------------------------------------------------------------
test("X success -> published; every other angle of the event is excluded; the next posts never return to it", async () => {
  const db = new ClaimDb();
  const first = await dispatch(db, 0, candidatesFor(INCIDENT_EVENT, 0)).run();
  assert.equal(first.topicEventKey, INCIDENT_KEY);
  assert.equal(first.topicSettlement, "PUBLISHED");
  for (let i = 1; i <= 5; i += 1) {
    db.now += 3 * HOUR;
    const next = await dispatch(db, i, candidatesFor(INCIDENT_EVENT, i)).run();
    assert.notEqual(next.topicEventKey, INCIDENT_KEY);
    assert.match(next.topicEventKey, /^evergreen-/u);
  }
  const units = new Set(Array.from({ length: 10 }, (_, i) => diaryOnly(INCIDENT_EVENT, i)[0].unitKey));
  assert.equal(units.size, 5);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(db.claimCandidates(sid(3000 + i), diaryOnly(INCIDENT_EVENT, i)).rejected[0].reason, "EVENT_PUBLISHED");
  }
});

test("(20) H1: settle write fails after a confirmed X post -> completion still runs once, the event is NOT reopened", async () => {
  const db = new ClaimDb();
  const port = db.port(sid(4000), diaryOnly(INCIDENT_EVENT));
  let x = 0, completions = 0;
  const result = await dispatchAiLabScheduledBrandPost({
    context, postType: "brand_post", scheduledPostId: sid(4000), openAiApiKey: "fixture-only",
    topic: { ...port, settlePublished: () => Promise.reject(new Error("AI_LAB_TOPIC_RPC_FAILED")) },
    loadRecentFingerprints: () => Promise.resolve([]),
    generate: () => Promise.resolve(draftOf(TEXTS[0])),
    publishText: () => {
      x += 1;
      return Promise.resolve({ data: { id: "1790000000000000001" } });
    },
    completePublishedPost: () => {
      completions += 1;
      return Promise.resolve({ fingerprintPersisted: true });
    },
  });
  assert.equal(result.topicSettlement, "SETTLE_FAILED");
  assert.deepEqual([x, completions], [1, 1]);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["provider_started"]);
  await assert.rejects(dispatch(db, 1, diaryOnly(INCIDENT_EVENT, 1)).run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  assert.equal(x, 1);
});

test("(21) completion response uncertain -> X once, event published, confirmed-post error (never a retry)", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { completePublishedPost: () => Promise.reject(new Error("network")) });
  await assert.rejects(d.run, (error) => error instanceof AiLabConfirmedPostCompletionError);
  assert.equal(d.counter.x, 1);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["published"]);
});

test("settle retry with the same claim / event / unit / X id is idempotent; anything else is an explicit conflict", async () => {
  const db = new ClaimDb();
  const port = db.port(sid(5000), diaryOnly(INCIDENT_EVENT + OTHER_EVENT));
  const claim = await port.claim();
  assert.equal(await port.startProvider(claim), true);
  assert.equal(await port.settlePublished(claim, "1790000000000000005"), "PUBLISHED");
  assert.equal(await port.settlePublished(claim, "1790000000000000005"), "IDEMPOTENT");
  await assert.rejects(() => port.settlePublished(claim, "1790000000000000099"), /AI_LAB_TOPIC_CLAIM_X_POST_CONFLICT/u);
  await assert.rejects(() => port.settlePublished({ ...claim, unitKey: `${claim.eventKey}#decided` }, "1790000000000000005"), /AI_LAB_TOPIC_CLAIM_IDENTITY_CONFLICT/u);
  const other: AiLabClaimedTopic = { ...claim, eventKey: INCIDENT_KEY, unitKey: `${INCIDENT_KEY}#changed` };
  await assert.rejects(() => port.settlePublished(other, "1790000000000000005"), /AI_LAB_TOPIC_CLAIM_/u);
  await assert.rejects(() => port.claim(), /AI_LAB_TOPIC_SCHEDULE_CONFLICT/u);
});

// ---------------------------------------------------------------------------------------------------
// 安定した event ID（重複ラベル・欠落・重複 ID）
// ---------------------------------------------------------------------------------------------------
const INSERTED = `
## 2026-09-29
event_id: 20260929-save-button-fix
changed: 通知設定画面の保存ボタンを直した
`;

test("(1) H1: two event_id lines in one entry never resolve as 'last wins' -- the entry yields no candidate", () => {
  const twice = "## 2026-10-01\nevent_id: 20261001-account-selection-check\nevent_id: 20261001-account-selection-recheck\nchanged: 接続先のアカウントが重複していた\n";
  const { candidates, exclusions } = buildAiLabTopicCandidates({ markdown: twice, now: NOW, rotationIndex: 0 });
  assert.equal(candidates.filter((c) => c.kind === "diary").length, 0);
  assert.ok(exclusions.some((e) => e.reason === "DIARY_DUPLICATE_LABEL:event_id"));
  assert.deepEqual(parseDevDiaryMarkdown(twice)[0].duplicateLabels, ["event_id"]);
  // the runtime sanitizer follows the same contract on its own (not only the candidate builder / CI)
  assert.equal(sanitizeDiaryEntry(parseDevDiaryMarkdown(twice)[0]), null);
  // an empty second line still counts, and other one-line labels follow the same contract
  for (const markdown of [
    "## 2026-10-01\nevent_id: 20261001-account-selection-check\nevent_id:\nchanged: 何かを直した\n",
    "## 2026-10-01\nevent_id: 20261001-account-selection-check\nchanged: 一つ目\nchanged: 二つ目\n",
  ]) {
    assert.equal(diaryOnly(markdown).length, 0, markdown);
  }
  // a used event cannot be renamed by adding a second id line
  const used = INCIDENT_EVENT.replace("event_id: 20260930-x-auth-test-account-overlap", "event_id: 20260930-x-auth-test-account-overlap\nevent_id: 20260930-x-auth-recheck");
  assert.equal(diaryOnly(used).length, 0);
});

test("(2)(3) missing, malformed, wrong-date, internal-looking or duplicate event IDs are never candidates", () => {
  const bad = (id: string) => `\n## 2026-10-01\nevent_id: ${id}\nchanged: 何かを直した\n`;
  for (const id of ["20261001", "20260930-wrong-date", "20261001-Upper", "20261001-pr82-fix", "20261001-g3-task", "20261001-fix-08a7346c", "20261001-token-rotation", `20261001-${"a".repeat(60)}`]) {
    const { candidates, exclusions } = buildAiLabTopicCandidates({ markdown: bad(id), now: NOW, rotationIndex: 0 });
    assert.equal(candidates.filter((c) => c.kind === "diary").length, 0, id);
    assert.ok(exclusions.some((e) => e.reason === "DIARY_EVENT_ID_MISSING_OR_INVALID"), id);
  }
  assert.equal(diaryOnly("\n## 2026-10-01\nchanged: 何かを直した\n").length, 0);
  const dup = `${OTHER_EVENT}\n## 2026-09-30\nevent_id: 20261001-notification-settings\nchanged: 別の話\n`;
  const { candidates, exclusions } = buildAiLabTopicCandidates({ markdown: dup, now: NOW, rotationIndex: 0 });
  assert.equal(candidates.filter((c) => c.kind === "diary").length, 0);
  assert.ok(exclusions.some((e) => e.reason === "DIARY_EVENT_ID_DUPLICATE"));
  assert.equal(isValidDiaryEventId("20260930-x-auth-test-account-overlap", "2026-09-30"), true);
});

test("(13) H1: inserting / reordering entries cannot rename or revive a used event", async () => {
  const db = new ClaimDb();
  await dispatch(db, 0, diaryOnly(INCIDENT_EVENT)).run();
  for (const [i, markdown] of [INSERTED + INCIDENT_EVENT, INCIDENT_EVENT + INSERTED, OTHER_EVENT + INCIDENT_EVENT + INSERTED].entries()) {
    const keys = diaryOnly(markdown).map((c) => c.eventKey);
    assert.ok(keys.includes(INCIDENT_KEY));
    const result = db.claimCandidates(sid(7000 + i), diaryOnly(markdown).filter((c) => c.eventKey === INCIDENT_KEY));
    assert.equal(result.claim, null);
    assert.equal(result.rejected[0].reason, "EVENT_PUBLISHED");
  }
  const malformed = INSERTED.replace("changed: 通知設定画面の保存ボタンを直した", "difficulty: 保存ボタンがなかった");
  assert.deepEqual(diaryOnly(malformed + INCIDENT_EVENT).map((c) => c.eventKey), [INCIDENT_KEY]);
});

test("(14)(15) editing text, adding angles, or adding other events never changes an existing event ID", () => {
  const edited = INCIDENT_EVENT
    .replace("X認証まわりの実データ接続を確認した", "X認証まわりの実データ接続を、iPhoneの実機で確認した")
    .concat("angle: 新しく足した切り口の話\n");
  for (const markdown of [edited, OTHER_EVENT + edited, edited + INSERTED]) {
    assert.ok(diaryOnly(markdown).some((c) => c.eventKey === INCIDENT_KEY), markdown);
  }
});

test("(4) the real canonical diary (fresh main merged): every entry keeps a valid, unique event ID and no duplicate labels", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  const entries = parseDevDiaryMarkdown(markdown);
  assert.ok(entries.length >= 8);
  const ids = entries.map((e) => e.eventId);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of entries) {
    assert.deepEqual(entry.duplicateLabels, [], entry.date);
    assert.ok(entry.eventId && isValidDiaryEventId(entry.eventId, entry.date), `${entry.date}: ${entry.eventId}`);
  }
  // IDs assigned before the main merge are unchanged (the 10-03 entry was extended on main, its id kept).
  assert.deepEqual(ids.slice(0, 8), [
    "20260926-password-reset-expired-link",
    "20260927-home-hidden-connection-failure",
    "20260928-honest-unavailable-buttons",
    "20260929-research-before-content-access",
    "20260930-x-auth-test-account-overlap",
    "20261001-shared-login-service-registration",
    "20261002-iphone-unresponsive-navigation",
    "20261003-topic-level-background-art",
  ]);
});

/** GitHub Actions の日記検証スクリプトそのもの（ワークフロー YAML から抜き出す）を node で実行する。 */
async function runWorkflowValidator(markdown?: string): Promise<{ ok: boolean; output: string }> {
  const { readFile } = await import("node:fs/promises");
  const { execFileSync } = await import("node:child_process");
  const workflow = await readFile(new URL("../../../../.github/workflows/ai-lab-diary-snapshot.yml", import.meta.url), "utf8");
  const block = /<<'NODE'\n([\s\S]*?)\n {10}NODE/u.exec(workflow);
  assert.ok(block, "workflow validator must exist");
  let code = block[1].split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");
  if (markdown !== undefined) code = code.replace('await readFile(path, "utf8")', JSON.stringify(markdown));
  const cwd = new URL("../../../../", import.meta.url).pathname;
  try {
    const output = execFileSync("node", ["--experimental-strip-types", "--input-type=module"], { input: code, cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: String((error as { stderr?: string }).stderr ?? error) };
  }
}

test("(1)(2)(3) H1 CI: the actual workflow validator accepts the canonical diary and stops bad identities before snapshot generation", async () => {
  const canonical = await runWorkflowValidator();
  assert.ok(canonical.ok, canonical.output);
  assert.match(canonical.output, /Validated \d+ public-safe diary entries/u);
  const valid = "## 2026-10-01\nevent_id: 20261001-account-selection-check\nchanged: 接続先のアカウントが重複していた\n";
  const cases: Array<[string, string, RegExp]> = [
    ["duplicate event_id label", valid.replace("changed:", "event_id: 20261001-account-selection-recheck\nchanged:"), /Duplicate label\(s\) event_id/u],
    ["missing event_id", valid.replace(/^event_id:.*\n/mu, ""), /Missing or invalid event_id/u],
    ["wrong-date event_id", valid.replace("20261001-account", "20260930-account"), /Missing or invalid event_id/u],
    ["repeated entry", valid + valid, /Duplicate diary date/u],
    ["duplicate event_id across entries", valid + valid.replace("## 2026-10-01", "## 2026-09-30"), /Missing or invalid event_id|Duplicate event_id/u],
  ];
  for (const [label, markdown, message] of cases) {
    const result = await runWorkflowValidator(markdown);
    assert.equal(result.ok, false, label);
    assert.match(result.output, message, label);
  }
});

// ---------------------------------------------------------------------------------------------------
// evergreen: 未解決は隔離、published は確定時刻から
// ---------------------------------------------------------------------------------------------------
function seedEvergreen(db: ClaimDb, index: number, state: State, hoursAgo: { claimed: number; published?: number }) {
  db.rows.push({
    claimId: sid(90000 + db.rows.length),
    scheduledPostId: sid(91000 + db.rows.length),
    kind: "evergreen",
    eventKey: `evergreen-${index}`,
    unitKey: `evergreen-${index}`,
    themeTags: [...EVERGREEN_THEME_TAGS[index]],
    state,
    claimedAt: db.now - hoursAgo.claimed * HOUR,
    leaseUntil: db.now - hoursAgo.claimed * HOUR + 15 * 60_000,
    publishedAt: hoursAgo.published === undefined ? null : db.now - hoursAgo.published * HOUR,
    xPostId: state === "published" ? "1" : null,
    reason: null,
  });
}

test("(10)(11) H1: provider_started / ambiguous evergreen aged 73h (or 500h) is never reclaimable -- quarantine, not cooldown", () => {
  for (const state of ["provider_started", "ambiguous"] as const) {
    for (const hours of [73, 500]) {
      const db = new ClaimDb();
      seedEvergreen(db, 2, state, { claimed: hours });
      const out = db.claimCandidates(sid(1), evergreenOnly(2));
      assert.equal(out.claim, null, `${state} ${hours}h`);
      assert.deepEqual(out.rejected, [{ eventKey: "evergreen-2", reason: `EVERGREEN_SEED_${state.toUpperCase()}` }]);
      // the unresolved seed's theme is blocked too
      const theme = new ClaimDb();
      seedEvergreen(theme, 0, state, { claimed: hours });
      assert.deepEqual(theme.claimCandidates(sid(2), evergreenOnly(5)).rejected, [{ eventKey: "evergreen-5", reason: "EVERGREEN_THEME_UNRESOLVED" }]);
    }
  }
});

test("H1: an interrupted evergreen sender and a replacement cannot both reach X, however much time passes", async () => {
  const db = new ClaimDb();
  let ready!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  const barrier = new Promise<void>((resolve) => (resume = resolve));
  const shared = { x: 0, completions: 0, topics: [] as string[] };
  const a = dispatch(db, 1, evergreenOnly(2), {
    publishText: async () => {
      ready();
      await barrier;
      shared.x += 1;
      return { data: { id: "1" } };
    },
  }, shared).run();
  await started;
  try {
    db.now += 73 * HOUR;
    await assert.rejects(dispatch(db, 2, evergreenOnly(2), {}, shared).run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  } finally {
    resume();
    await a;
  }
  assert.equal(shared.x, 1);
});

test("(12)(13) published evergreen: seed cooldown 72h and theme cooldown 48h run from the confirmed publish time", () => {
  // claimed 72h1m ago, published 71h59m ago -> still cooling down
  const db = new ClaimDb();
  seedEvergreen(db, 0, "published", { claimed: 72 + 1 / 60, published: 72 - 1 / 60 });
  assert.deepEqual(db.claimCandidates(sid(1), evergreenOnly(0)).rejected, [{ eventKey: "evergreen-0", reason: "EVERGREEN_SEED_COOLDOWN" }]);
  db.now += 2 * 60_000; // published 72h1m ago
  assert.equal(db.claimCandidates(sid(2), evergreenOnly(0)).claim?.eventKey, "evergreen-0");

  const theme = new ClaimDb();
  seedEvergreen(theme, 0, "published", { claimed: 49, published: 48 - 1 / 60 });
  assert.deepEqual(theme.claimCandidates(sid(3), evergreenOnly(5)).rejected, [{ eventKey: "evergreen-5", reason: "EVERGREEN_THEME_COOLDOWN" }]);
  theme.now += 2 * 60_000;
  assert.equal(theme.claimCandidates(sid(4), evergreenOnly(5)).claim?.eventKey, "evergreen-5");
});

test("(16) evergreen end to end: same seed waits 72h after publish, same theme tag 48h after publish", async () => {
  const db = new ClaimDb();
  assert.equal((await dispatch(db, 0, evergreenOnly(0)).run()).topicEventKey, "evergreen-0"); // tags: unglamorous_work
  db.now += 2 * HOUR;
  const out = db.claimCandidates(sid(8001), evergreenOnly(0, 5, 2));
  assert.deepEqual(out.rejected, [
    { eventKey: "evergreen-0", reason: "EVERGREEN_SEED_COOLDOWN" },
    { eventKey: "evergreen-5", reason: "EVERGREEN_THEME_COOLDOWN" },
  ]);
  assert.equal(out.claim?.eventKey, "evergreen-2");
});

test("(17) H1: evergreen pool exhausted -> the slot is skipped (no claim, no generation, no X); cooldown is never broken", async () => {
  const db = new ClaimDb();
  EVERGREEN_TOPIC_SEEDS.forEach((_, i) => seedEvergreen(db, i, "published", { claimed: i + 1, published: i + 1 }));
  const d = dispatch(db, 99, candidatesFor("", 0));
  await assert.rejects(d.run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  assert.equal(d.counter.x, 0);
  assert.equal(d.counter.topics.length, 0);
});

// ---------------------------------------------------------------------------------------------------
// RPC ペイロードの正規形（ClaimDb は実際に送られた JSON を検証する。実 SQL は runner で同じことを確認）
// ---------------------------------------------------------------------------------------------------
test("(14)-(17) canonical candidate payloads: forged tags, extra keys, out-of-pool seeds and wrong event/unit pairs are rejected without side effects", () => {
  const db = new ClaimDb();
  const wire = (c: Record<string, unknown>) => [c];
  const bad: Array<[string, unknown]> = [
    ["evergreen-5 with forged empty tags", wire({ kind: "evergreen", event_key: "evergreen-5", unit_key: "evergreen-5", theme_tags: [] })],
    ["extra JSON key", wire({ kind: "evergreen", event_key: "evergreen-2", unit_key: "evergreen-2", theme_tags: [], body: "x" })],
    ["evergreen outside the pool", wire({ kind: "evergreen", event_key: "evergreen-9", unit_key: "evergreen-9", theme_tags: [] })],
    ["diary unit of another event", wire({ kind: "diary", event_key: OTHER_KEY, unit_key: `${INCIDENT_KEY}#changed`, theme_tags: [] })],
    ["diary with tags", wire({ kind: "diary", event_key: OTHER_KEY, unit_key: `${OTHER_KEY}#changed`, theme_tags: ["ai_trial_error"] })],
    ["valid then invalid", [{ kind: "evergreen", event_key: "evergreen-2", unit_key: "evergreen-2", theme_tags: [] }, { kind: "evergreen", event_key: "evergreen-9", unit_key: "evergreen-9", theme_tags: [] }]],
  ];
  for (const [label, payload] of bad) {
    assert.throws(() => db.claim(sid(1), payload), /AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT/u, label);
  }
  assert.equal(db.rows.length, 0);
});

test("the TS evergreen theme map, the candidate builder and the SQL canonical map are identical", async () => {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../../../migrations/20261004090000_ai_lab_topic_claims.sql", import.meta.url), "utf8");
  const map = JSON.parse(/c_evergreen_tags constant jsonb := '(\{[\s\S]*?\})'::jsonb;/u.exec(sql)![1]) as Record<string, string[]>;
  assert.deepEqual(Object.keys(map).sort(), EVERGREEN_TOPIC_SEEDS.map((_, i) => `evergreen-${i}`).sort());
  EVERGREEN_TOPIC_SEEDS.forEach((_, i) => {
    assert.deepEqual([...map[`evergreen-${i}`]].sort(), [...EVERGREEN_THEME_TAGS[i]].sort(), `evergreen-${i}`);
  });
  for (const candidate of candidatesFor(INCIDENT_EVENT + OTHER_EVENT)) {
    if (candidate.kind === "evergreen") assert.deepEqual([...candidate.themeTags].sort(), [...map[candidate.eventKey]].sort());
  }
});

// ---------------------------------------------------------------------------------------------------
// ログ・RPC の形、未適用時の安全側
// ---------------------------------------------------------------------------------------------------
test("exclusion logs and RPC payloads carry only key-shaped identifiers (no diary text, no secrets)", async () => {
  const markdown = `${INCIDENT_EVENT}
## 2026-09-29
event_id: 20260929-research
changed: 着手前に必要な下調べをした。
angle: 下調べだけで1日が終わることもある、という個人開発のリアル。

## 2026-09-20
event_id: 20260920-old
changed: 古い出来事。

## 2026-10-09
event_id: 20261009-future
changed: 未来の出来事。

## 2026-10-01
event_id: 20261001-unsafe
changed: 危険な変更 https://example.com と sk-abcdefghijklmnop を含む。

## 2026-09-28
event_id: 20260928-twice
event_id: 20260928-twice-again
changed: 二重ラベル
`;
  const { candidates, exclusions } = buildAiLabTopicCandidates({ markdown, now: NOW, rotationIndex: 3 });
  assert.ok(exclusions.length >= 5);
  for (const e of exclusions) {
    assert.match(e.candidate, /^(?:\d{4}-\d{2}-\d{2}|diary:\d{8}-[a-z0-9-]+(?:#[a-z0-9]+)?|evergreen-\d{1,2})$/u);
    assert.match(e.reason, /^[A-Z_]+(?::[a-z_,]+)?$/u);
  }
  assert.doesNotMatch(JSON.stringify(exclusions), /[぀-ヿ一-龯]|https?:|sk-|example/u);
  for (const c of candidates) {
    assert.match(c.eventKey, AI_LAB_EVENT_KEY_PATTERN);
    assert.match(c.unitKey, /^[a-z0-9:#-]+$/u);
  }
  let sent = "";
  await claimAiLabTopic({
    supabaseUrl: "https://fixture.invalid",
    serviceRoleKey: "fixture-only",
    scheduledPostId: sid(0xa000),
    candidates,
    fetchImpl: ((url: string, init?: RequestInit) => {
      sent = String(init?.body);
      assert.match(String(url), /\/rest\/v1\/rpc\/claim_ai_lab_topic$/u);
      return Promise.resolve(new Response(JSON.stringify({ claim: null, rejected: [] }), { status: 200 }));
    }) as typeof fetch,
  });
  assert.doesNotMatch(sent, /[぀-ヿ一-龯]/u, "topic text is never sent to the database");
  assert.deepEqual(Object.keys(JSON.parse(sent).p_candidates[0]).sort(), ["event_key", "kind", "theme_tags", "unit_key"]);
});

test("claim RPC: malformed responses and opaque errors fail closed; only AI_LAB_TOPIC_CLAIM_* codes pass through", async () => {
  const base = { supabaseUrl: "https://fixture.invalid", serviceRoleKey: "k", scheduledPostId: sid(0xb000), candidates: candidatesFor("") };
  const reply = (body: unknown, status = 200) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as typeof fetch;
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: reply({ nope: true }) }), /AI_LAB_TOPIC_CLAIM_INVALID_RESPONSE/u);
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: reply({ claim: { claim_id: "x", kind: "diary", event_key: "X認証", unit_key: "u" }, rejected: [] }) }), /AI_LAB_TOPIC_CLAIM_INVALID_RESPONSE/u);
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: reply({ message: "relation \"ai_lab_topic_claims\" does not exist" }, 404) }), /AI_LAB_TOPIC_RPC_FAILED/u);
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: reply({ message: "AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT" }, 400) }), /AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT/u);
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: (() => Promise.reject(new Error("network"))) as typeof fetch }), /network/u);
});

test("claim RPC unavailable (e.g. migration not applied) -> the dispatcher never generates or reaches X", async () => {
  const port = createAiLabTopicPort({
    supabaseUrl: "https://fixture.invalid", serviceRoleKey: "k", scheduledPostId: sid(0xc000), candidates: candidatesFor(INCIDENT_EVENT),
    fetchImpl: (() => Promise.resolve(new Response(JSON.stringify({ message: "not found" }), { status: 404 }))) as typeof fetch,
  });
  let x = 0, generated = 0;
  await assert.rejects(() =>
    dispatchAiLabScheduledBrandPost({
      context, postType: "brand_post", scheduledPostId: sid(0xc000), openAiApiKey: "fixture-only", topic: port,
      loadRecentFingerprints: () => Promise.resolve([]),
      generate: () => {
        generated += 1;
        return Promise.resolve(draftOf(TEXTS[0]));
      },
      publishText: () => {
        x += 1;
        return Promise.resolve({ data: { id: "1" } });
      },
      completePublishedPost: () => Promise.resolve({ fingerprintPersisted: true }),
    }), /AI_LAB_TOPIC_RPC_FAILED/u);
  assert.deepEqual([x, generated], [0, 0]);
});

// ---------------------------------------------------------------------------------------------------
// migration・配線・他ブランドの静的確認（実 SQL は supabase/tests/ai_lab_topic_claims_run.sh）
// ---------------------------------------------------------------------------------------------------
test("(5)(6)(7)(18)(19)(20) migration: owner/inheritance/effective-ACL checks, drift fail-closed, canonical payloads; runner covers them", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("../../../migrations/", import.meta.url);
  const files = await readdir(dir);
  assert.ok(!files.some((f) => f.endsWith("_ai_lab_topic_event_usage.sql")), "the superseded PR82 usage migration is gone");
  const sql = (await readFile(new URL("20261004090000_ai_lab_topic_claims.sql", dir), "utf8")).replace(/--.*$/gmu, "");
  for (const marker of [
    "AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT", "AI_LAB_TOPIC_CLAIMS_PREFLIGHT", "AI_LAB_TOPIC_CLAIMS_ACL",
    "pg_has_role(r.role_name, current_user, 'MEMBER')", "pg_has_role(v_role, current_user, 'MEMBER')",
    "has_table_privilege(v_role, v_table, v_privilege)", "array_append(v_privileges, 'MAINTAIN')",
    "is distinct from array['event_key', 'kind', 'theme_tags', 'unit_key']", "published_at > now() - interval '72 hours'",
    "published_at > now() - interval '48 hours'", "EVERGREEN_THEME_UNRESOLVED",
  ]) {
    assert.ok(sql.includes(marker), marker);
  }
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('ai_lab_topic_claims:ai_salaryman_lab', 0\)\)/u);
  assert.match(sql, /revoke all on table public\.ai_lab_topic_claims from public, anon, authenticated, service_role;/u);
  assert.doesNotMatch(sql, /grant [a-z, ]+ on table public\.ai_lab_topic_claims/u);
  assert.doesNotMatch(sql, /claimed_at > now\(\) - interval/u, "cooldowns never run from claim time");
  assert.equal((sql.match(/grant execute on function public\.[a-z_]+\([a-z, ]+\) to service_role;/gu) ?? []).length, 5);
  assert.equal((sql.match(/security definer\s+set search_path = ''/gu) ?? []).length, 5);
  assert.doesNotMatch(sql, /\b(?:grant|revoke)\s+[a-z_]+\s+(?:to|from)\s+(?:anon|authenticated|service_role|postgres)\b/u, "no role-graph changes");
  const touched = new Set([...sql.matchAll(/public\.([a-z_]+)/gu)].map((m) => m[1]));
  assert.deepEqual([...touched].sort(), [
    "ai_lab_topic_claims", "ai_lab_topic_event_usage", "claim_ai_lab_topic", "mark_ai_lab_topic_claim_ambiguous",
    "release_ai_lab_topic_claim", "settle_ai_lab_topic_claim_published", "start_ai_lab_topic_provider",
  ]);
  const diaryRe = new RegExp(/v_key !~ '(\^diary:[^']+)'/u.exec(sql)![1], "u");
  for (const key of [INCIDENT_KEY, OTHER_KEY, "diary-2026-10-01-1", "diary:X認証", "diary:2026-x", `${INCIDENT_KEY}#changed`]) {
    assert.equal(diaryRe.test(key), AI_LAB_EVENT_KEY_PATTERN.test(key) && key.startsWith("diary:"), key);
  }
  const runner = await readFile(new URL("../../../tests/ai_lab_topic_claims_run.sh", import.meta.url), "utf8");
  for (const label of [
    "session B waited for A", "drift_case missing_pk", "drift_case table_owner_api_role", "drift_case function_owner_api_role",
    "inheritance: reapply refused", "MAINTAIN", "evergreen aged 73h is still not claimable", "published 71h59m ago",
    "payload rejected: $1", "evergreen-5 with forged empty theme tags", "rejected payloads had no side effects",
  ]) {
    assert.ok(runner.includes(label), label);
  }
});

test("(23) x-test-post wires the claim port and the observed sender into the AI Lab brand_post branch only", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const source = await readFile(new URL("../../x-test-post/index.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (scheduledPost.post_type === "brand_post")');
  const block = source.slice(start, source.indexOf("AI_LAB_POST_CONFIRMED_BUT_COMPLETION_UNCONFIRMED", start));
  assert.match(block, /buildAiLabTopicCandidates\(/u);
  assert.match(block, /createAiLabTopicPort\(/u);
  assert.match(block, /topic: topicPort,/u);
  assert.match(block, /sendAiLabXPost\(\{/u);
  assert.match(block, /send: \(request\) => vaultAccount\.send\(request\)/u);
  assert.equal((source.match(/sendAiLabXPost\(/gu) ?? []).length, 1);
  assert.equal((source.match(/createAiLabTopicPort\(/gu) ?? []).length, 1);
  const functionsDir = new URL("../../", import.meta.url);
  for (const fn of await readdir(functionsDir)) {
    if (fn === "_shared" || fn === "x-test-post" || fn.includes(".")) continue;
    for (const file of await readdir(new URL(`${fn}/`, functionsDir)).catch(() => [])) {
      if (!file.endsWith(".ts")) continue;
      const body = await readFile(new URL(`${fn}/${file}`, functionsDir), "utf8");
      assert.doesNotMatch(body, /ai_lab_(brand_post_store|scheduled_brand_post|dev_diary_context|theme_guard|provider_outcome)/u, `${fn}/${file}`);
    }
  }
});

test("the real bundled diary: simulated posts over a day use each fresh event at most once, then evergreen, never repeating a seed", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  const freshest = [...markdown.matchAll(/^## (\d{4}-\d{2}-\d{2})/gmu)].map((m) => m[1]).sort().at(-1)!;
  const db = new ClaimDb();
  db.now = Date.parse(`${freshest}T00:30:00Z`);
  const used: string[] = [];
  for (let post = 0; post < 12; post += 1) {
    const candidates = buildAiLabTopicCandidates({ markdown, now: new Date(db.now), rotationIndex: post }).candidates;
    const result = await dispatch(db, post, candidates).run().catch((error) => error as Error);
    if (result instanceof Error) {
      assert.match(result.message, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
    } else {
      used.push(result.topicEventKey);
    }
    db.now += 4 * HOUR;
  }
  assert.equal(new Set(used).size, used.length, used.join(","));
  assert.ok(used.filter((k) => k.startsWith("diary:")).length >= 2);
});
