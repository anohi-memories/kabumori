// 会社員AIラボ: 同じ開発イベントを切り口だけ変えて連投しないための「X送信前の確保（claim）」のテスト。
// 実X投稿・DB・OpenAI呼び出しは一切なし（generate / publish / fetch は全てスタブ）。
//
// DB の確保規則（migration 20261004090000_ai_lab_topic_claims.sql）は、下の ClaimDb がそのまま写した
// インメモリ実装で再現する。実 SQL そのもの（ロック・部分UNIQUE・ACL・ドリフト拒否・2セッション同時実行）は
// supabase/tests/ai_lab_topic_claims_run.sh が使い捨ての PostgreSQL で検証する。
//
// H1 の RED evidence（codex/h1-pr82-event-review-20261003 @ 100ab65f）の各ケースは「H1:」で始まるテストに対応する。
import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_LAB_EVENT_KEY_PATTERN,
  type AiLabTopicCandidate,
  buildAiLabTopicCandidates,
  EVERGREEN_TOPIC_SEEDS,
  isValidDiaryEventId,
  loadAiLabDevDiaryMarkdown,
  parseDevDiaryMarkdown,
} from "./ai_lab_dev_diary_context.ts";
import {
  AiLabConfirmedPostCompletionError,
  definitiveProviderRejection,
  dispatchAiLabScheduledBrandPost,
} from "./ai_lab_scheduled_brand_post.ts";
import {
  type AiLabClaimedTopic,
  type AiLabTopicPort,
  claimAiLabTopic,
  createAiLabTopicPort,
} from "./ai_lab_brand_post_store.ts";
import { fingerprintText } from "./cross_brand_dedupe.ts";
import { type BrandOperationalSettings, resolveBrandContext } from "./brand_context.ts";

// ---------------------------------------------------------------------------------------------------
// ClaimDb: claim_ai_lab_topic / start / release / mark_ambiguous / settle の規則を写したインメモリ版。
// 各メソッドは同期的に完結する（＝DB 側のブランド単位ロックの中で1つずつ処理されるのと同じ）。
// ---------------------------------------------------------------------------------------------------
type Row = {
  claimId: string;
  scheduledPostId: string;
  kind: "diary" | "evergreen";
  eventKey: string;
  unitKey: string;
  themeTags: string[];
  state: "claimed" | "provider_started" | "ambiguous" | "published" | "released" | "expired";
  claimedAt: number;
  leaseUntil: number;
  xPostId: string | null;
  reason: string | null;
};
const ACTIVE = new Set(["claimed", "provider_started", "ambiguous", "published"]);
const HOUR = 3_600_000;

class ClaimDb {
  rows: Row[] = [];
  now = Date.parse("2026-10-01T03:00:00Z");
  private seq = 0;

  claim(scheduledPostId: string, candidates: readonly AiLabTopicCandidate[], leaseSeconds = 900) {
    for (const row of this.rows) {
      if (row.state === "claimed" && row.leaseUntil <= this.now) Object.assign(row, { state: "expired", reason: "LEASE_EXPIRED" });
    }
    const existing = this.rows.find((row) => row.scheduledPostId === scheduledPostId && ACTIVE.has(row.state));
    if (existing) return { claim: null, rejected: [], conflict: `SCHEDULE_ALREADY_CLAIMED:${existing.state.toUpperCase()}` };
    const rejected: Array<{ eventKey: string; reason: string }> = [];
    for (const candidate of candidates) {
      if (candidate.kind === "diary") {
        const hit = this.rows.find((row) => row.kind === "diary" && row.eventKey === candidate.eventKey && ACTIVE.has(row.state));
        if (hit) {
          rejected.push({ eventKey: candidate.eventKey, reason: `EVENT_${hit.state.toUpperCase()}` });
          continue;
        }
      } else {
        const recent = (hours: number) =>
          this.rows.filter((row) => row.kind === "evergreen" && ACTIVE.has(row.state) && row.claimedAt > this.now - hours * HOUR);
        if (recent(72).some((row) => row.eventKey === candidate.eventKey)) {
          rejected.push({ eventKey: candidate.eventKey, reason: "EVERGREEN_SEED_COOLDOWN" });
          continue;
        }
        if (candidate.themeTags.length > 0 && recent(48).some((row) => row.themeTags.some((tag) => candidate.themeTags.includes(tag as never)))) {
          rejected.push({ eventKey: candidate.eventKey, reason: "EVERGREEN_THEME_COOLDOWN" });
          continue;
        }
      }
      const row: Row = {
        claimId: `00000000-0000-0000-0000-${String(++this.seq).padStart(12, "0")}`,
        scheduledPostId,
        kind: candidate.kind,
        eventKey: candidate.eventKey,
        unitKey: candidate.unitKey,
        themeTags: [...candidate.themeTags],
        state: "claimed",
        claimedAt: this.now,
        leaseUntil: this.now + leaseSeconds * 1000,
        xPostId: null,
        reason: null,
      };
      this.rows.push(row);
      return { claim: { claimId: row.claimId, kind: row.kind, eventKey: row.eventKey, unitKey: row.unitKey }, rejected, conflict: null };
    }
    return { claim: null, rejected, conflict: null };
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
    if (row.state === "claimed" || (row.state === "provider_started" && /^PROVIDER_REJECTED:(400|401|422|429)$/u.test(reason))) {
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
    Object.assign(row, { state: "published", xPostId, reason: null });
    return "PUBLISHED";
  }

  stateOf(eventKey: string) {
    return this.rows.filter((row) => row.eventKey === eventKey).map((row) => row.state);
  }

  /** 本番の createAiLabTopicPort と同じ形のポート（RPC の代わりにこの ClaimDb を呼ぶ）。 */
  port(scheduledPostId: string, candidates: readonly AiLabTopicCandidate[], hooks: Partial<AiLabTopicPort> = {}): AiLabTopicPort {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const name = String(url).split("/rpc/")[1];
      const body = JSON.parse(String(init?.body));
      try {
        const result = name === "claim_ai_lab_topic"
          ? (() => {
            const r = this.claim(body.p_scheduled_post_id, candidates, body.p_lease_seconds);
            return {
              claim: r.claim && { claim_id: r.claim.claimId, kind: r.claim.kind, event_key: r.claim.eventKey, unit_key: r.claim.unitKey },
              rejected: r.rejected.map((x) => ({ event_key: x.eventKey, reason: x.reason })),
              ...(r.conflict ? { conflict: r.conflict } : {}),
            };
          })()
          : name === "start_ai_lab_topic_provider"
          ? this.start(body.p_claim_id, body.p_scheduled_post_id, body.p_event_key)
          : name === "release_ai_lab_topic_claim"
          ? this.release(body.p_claim_id, body.p_scheduled_post_id, body.p_event_key, body.p_reason)
          : name === "mark_ai_lab_topic_claim_ambiguous"
          ? this.ambiguous(body.p_claim_id, body.p_scheduled_post_id, body.p_event_key, body.p_reason)
          : this.settle(body.p_claim_id, body.p_scheduled_post_id, body.p_event_key, body.p_unit_key, body.p_x_post_id);
        return new Response(JSON.stringify(result), { status: 200 });
      } catch (error) {
        return new Response(JSON.stringify({ message: (error as Error).message, code: "P0001" }), { status: 400 });
      }
    }) as typeof fetch;
    // 本番と同じ createAiLabTopicPort を通す（RPC の呼び出し形・応答の検証・題材の引き当ても一緒に検証される）。
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

/** 1スケジュール分の dispatch。X 呼び出し回数を数える。 */
function dispatch(
  db: ClaimDb,
  index: number,
  candidates: readonly AiLabTopicCandidate[],
  overrides: Partial<Parameters<typeof dispatchAiLabScheduledBrandPost>[0]> = {},
  counter = { x: 0, completions: 0, topics: [] as string[] },
) {
  const scheduledPostId = `00000000-0000-0000-0000-${String(1000 + index).padStart(12, "0")}`;
  return {
    counter,
    run: () =>
      dispatchAiLabScheduledBrandPost({
        context,
        postType: "brand_post",
        scheduledPostId,
        openAiApiKey: "fixture-only",
        topic: db.port(scheduledPostId, candidates),
        loadRecentFingerprints: async () => [],
        generate: async ({ topicSeed }) => {
          counter.topics.push(topicSeed);
          return draftOf(TEXTS[index % 2]);
        },
        publishText: async () => {
          counter.x += 1;
          return { data: { id: String(1790000000000000000n + BigInt(index)) } };
        },
        completePublishedPost: async () => {
          counter.completions += 1;
          return { fingerprintPersisted: true };
        },
        ...overrides,
      }),
  };
}

// ---------------------------------------------------------------------------------------------------
// 1. 同時実行
// ---------------------------------------------------------------------------------------------------
test("(1) H1: two schedules that interleave (both pass every guard) cannot both publish the same event; X is reached once for it", async () => {
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
  // 新しい設計では負けた側は確保の時点で止まり、指紋の読み込みまで来ない。その場合もバリアを開ける。
  const outcomes = await Promise.allSettled(both.map((d) => d.run().catch((error) => {
    release();
    throw error;
  })));
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
  const loser = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
  assert.match(loser.reason.message, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  assert.equal(shared.x, 1, `same event reached X ${shared.x} times`);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["published"]);
});

test("(1) with evergreen available, the second schedule publishes a different topic -- never the same event", async () => {
  const db = new ClaimDb();
  const shared = { x: 0, completions: 0, topics: [] as string[] };
  const results = await Promise.all([0, 1].map((i) => dispatch(db, i, candidatesFor(INCIDENT_EVENT, i), {}, shared).run()));
  assert.equal(shared.x, 2);
  assert.notEqual(results[0].topicEventKey, results[1].topicEventKey);
  assert.equal(results.filter((r) => r.topicEventKey === INCIDENT_KEY).length, 1);
});

// ---------------------------------------------------------------------------------------------------
// 2〜5. X 前の失敗は自分の確保だけを解除する
// ---------------------------------------------------------------------------------------------------
test("(2) generation failure releases the pre-X claim (no X) and the event can be used later", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { generate: async () => { throw new Error("BRAND_POST_GENERATION_FAILED:500"); } });
  await assert.rejects(d.run, /BRAND_POST_GENERATION_FAILED/u);
  assert.equal(d.counter.x, 0);
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", "PRE_X_GENERATION_FAILED"]]);
  const next = dispatch(db, 1, diaryOnly(INCIDENT_EVENT));
  assert.equal((await next.run()).topicEventKey, INCIDENT_KEY);
});

test("(3) content guard failure releases the pre-X claim", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { generate: async () => draftOf("個人開発は、コードを書かない日もある。") });
  await assert.rejects(d.run, /AI_LAB_CONTENT_DIVERSITY_REJECTED/u);
  assert.equal(d.counter.x, 0);
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", "PRE_X_CONTENT_REJECTED"]]);
});

test("(4) (22) cross-brand fingerprint block still stops before X and releases the claim", async () => {
  const db = new ClaimDb();
  const hash = await fingerprintText(TEXTS[0]);
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), {
    loadRecentFingerprints: async () => [{ brandId: "kabumori", normalizedTextSha256: hash, publishedAt: NOW.toISOString() }],
  });
  await assert.rejects(d.run, /AI_LAB_CROSS_BRAND_DUPLICATE/u);
  assert.equal(d.counter.x, 0);
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", "PRE_X_FINGERPRINT_BLOCKED"]]);
});

test("(5) X never started (provider start refused) -> no X call, claim released", async () => {
  const db = new ClaimDb();
  const scheduledPostId = "00000000-0000-0000-0000-000000001000";
  const port = db.port(scheduledPostId, diaryOnly(INCIDENT_EVENT));
  let x = 0;
  await assert.rejects(
    () =>
      dispatchAiLabScheduledBrandPost({
        context, postType: "brand_post", scheduledPostId, openAiApiKey: "fixture-only",
        topic: { ...port, startProvider: async () => false },
        loadRecentFingerprints: async () => [],
        generate: async () => draftOf(TEXTS[0]),
        publishText: async () => { x += 1; return { data: { id: "1" } }; },
        completePublishedPost: async () => ({ fingerprintPersisted: true }),
      }),
    /AI_LAB_TOPIC_CLAIM_LOST/u,
  );
  assert.equal(x, 0);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["released"]);
});

test("(5) a definitive X rejection (400/401/422/429) releases; 403, 5xx and transport errors do not", async () => {
  for (const status of [400, 401, 422, 429]) {
    const db = new ClaimDb();
    const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { publishText: async () => { throw new Error(`X_REQUEST_FAILED:${status}`); } });
    await assert.rejects(d.run, /X_REQUEST_FAILED/u);
    assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["released", `PROVIDER_REJECTED:${status}`]]);
  }
  for (const message of ["X_REQUEST_FAILED:403", "X_REQUEST_FAILED:500", "X_REQUEST_FAILED:503", "X_REQUEST_FAILED:408", "fetch failed", "AbortError: timeout"]) {
    assert.equal(definitiveProviderRejection(new Error(message)), null, message);
  }
});

// ---------------------------------------------------------------------------------------------------
// 6〜8. X 開始後は再開放しない
// ---------------------------------------------------------------------------------------------------
test("(6) H1: provider started then timeout -> ambiguous; the next schedule cannot use the event", async () => {
  const db = new ClaimDb();
  const shared = { x: 0, completions: 0, topics: [] as string[] };
  await assert.rejects(dispatch(db, 0, diaryOnly(INCIDENT_EVENT), {
    publishText: async () => { shared.x += 1; throw new Error("response lost after provider accepted"); },
  }, shared).run);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["ambiguous"]);
  await assert.rejects(dispatch(db, 1, diaryOnly(INCIDENT_EVENT, 1), {}, shared).run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  assert.equal(shared.x, 1, "ambiguous X outcome must not let the next slot republish");
});

test("(7) X response without a post id -> ambiguous, not reopened", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { publishText: async () => ({ data: {} }) });
  await assert.rejects(d.run, /X_RESPONSE_MISSING_POST_ID/u);
  assert.deepEqual(db.rows.map((r) => [r.state, r.reason]), [["ambiguous", "PROVIDER_RESPONSE_WITHOUT_ID"]]);
  assert.equal(db.claim("00000000-0000-0000-0000-000000009999", diaryOnly(INCIDENT_EVENT)).claim, null);
});

test("(8) H1: process stops inside X (or right after a confirmed X id, before settling) -> the next schedule cannot claim the event", async () => {
  const db = new ClaimDb();
  let entered!: () => void;
  const inX = new Promise<void>((resolve) => (entered = resolve));
  const hung = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), {
    publishText: () => { entered(); return new Promise(() => {}); }, // never returns: crash/hang inside X
  });
  void hung.run().catch(() => {});
  await inX;
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["provider_started"]);
  db.now += 24 * HOUR; // lease is long gone; provider_started is still never reopened
  await assert.rejects(dispatch(db, 1, diaryOnly(INCIDENT_EVENT, 1)).run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
});

test("(8) a process that stops BEFORE X (claimed, never started) frees the event only after its lease, and the stale worker is fenced out", async () => {
  const db = new ClaimDb();
  const scheduledPostId = "00000000-0000-0000-0000-000000002000";
  const port = db.port(scheduledPostId, diaryOnly(INCIDENT_EVENT));
  const stale = await port.claim(); // then the worker "crashes" during generation
  assert.equal(db.claim("00000000-0000-0000-0000-000000002001", diaryOnly(INCIDENT_EVENT)).claim, null, "still leased");
  db.now += 16 * 60_000;
  const fresh = db.claim("00000000-0000-0000-0000-000000002002", diaryOnly(INCIDENT_EVENT));
  assert.equal(fresh.claim?.eventKey, INCIDENT_KEY);
  assert.equal(await port.startProvider(stale), false, "stale worker can never reach X");
  assert.equal(await port.release(stale, "PRE_X_FAILED"), "EXPIRED", "stale worker cannot release the new claim");
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["expired", "claimed"]);
});

// ---------------------------------------------------------------------------------------------------
// 9〜12. X 成功・確定・冪等性
// ---------------------------------------------------------------------------------------------------
test("(9) X success -> published; every other angle of the event is excluded; the next posts never return to it", async () => {
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
  // 5 つの切り口（changed/difficulty/decided/angle1/angle2）どれを候補にしても確保できない
  const units = new Set(Array.from({ length: 10 }, (_, i) => diaryOnly(INCIDENT_EVENT, i)[0].unitKey));
  assert.equal(units.size, 5);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(db.claim(`00000000-0000-0000-0000-00000000300${i}`, diaryOnly(INCIDENT_EVENT, i)).rejected[0].reason, "EVENT_PUBLISHED");
  }
});

test("(9) old-bug reproduction: the 9/30 event is 5 angles of one eventKey, and with another fresh event the order is newest-unused first, then evergreen", async () => {
  const keys = new Set(Array.from({ length: 10 }, (_, i) => diaryOnly(INCIDENT_EVENT, i)[0].eventKey));
  assert.deepEqual([...keys], [INCIDENT_KEY]);
  const db = new ClaimDb();
  const picked: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    picked.push((await dispatch(db, i, candidatesFor(INCIDENT_EVENT + OTHER_EVENT, 100 + i)).run()).topicEventKey);
    db.now += 3 * HOUR;
  }
  assert.deepEqual(picked.slice(0, 2), [OTHER_KEY, INCIDENT_KEY]);
  assert.ok(picked.slice(2).every((key) => key.startsWith("evergreen-")));
  assert.equal(new Set(picked).size, 4);
});

test("(10) H1: settle write fails after a confirmed X post -> completion still runs once, the event is NOT reopened", async () => {
  const db = new ClaimDb();
  const scheduledPostId = "00000000-0000-0000-0000-000000004000";
  const port = db.port(scheduledPostId, diaryOnly(INCIDENT_EVENT));
  let x = 0, completions = 0;
  const result = await dispatchAiLabScheduledBrandPost({
    context, postType: "brand_post", scheduledPostId, openAiApiKey: "fixture-only",
    topic: { ...port, settlePublished: async () => { throw new Error("AI_LAB_TOPIC_RPC_FAILED"); } },
    loadRecentFingerprints: async () => [],
    generate: async () => draftOf(TEXTS[0]),
    publishText: async () => { x += 1; return { data: { id: "1790000000000000001" } }; },
    completePublishedPost: async () => { completions += 1; return { fingerprintPersisted: true }; },
  });
  assert.equal(result.topicSettlement, "SETTLE_FAILED");
  assert.deepEqual([x, completions], [1, 1]);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["provider_started"]);
  await assert.rejects(dispatch(db, 1, diaryOnly(INCIDENT_EVENT, 1)).run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  assert.equal(x, 1, "same event was republished despite the completed first schedule");
});

test("(10) completion response uncertain -> X once, event published, confirmed-post error (never a retry)", async () => {
  const db = new ClaimDb();
  const d = dispatch(db, 0, diaryOnly(INCIDENT_EVENT), { completePublishedPost: async () => { throw new Error("network"); } });
  await assert.rejects(d.run, (error) => error instanceof AiLabConfirmedPostCompletionError);
  assert.equal(d.counter.x, 1);
  assert.deepEqual(db.stateOf(INCIDENT_KEY), ["published"]);
});

test("(11) settle retry with the same claim / event / unit / X id is idempotent", async () => {
  const db = new ClaimDb();
  const sid = "00000000-0000-0000-0000-000000005000";
  const port = db.port(sid, diaryOnly(INCIDENT_EVENT));
  const claim = await port.claim();
  assert.equal(await port.startProvider(claim), true);
  assert.equal(await port.settlePublished(claim, "1790000000000000005"), "PUBLISHED");
  assert.equal(await port.settlePublished(claim, "1790000000000000005"), "IDEMPOTENT");
});

test("(12) same scheduled post with a different X id / event / unit, or a second claim, is an explicit conflict", async () => {
  const db = new ClaimDb();
  const sid = "00000000-0000-0000-0000-000000006000";
  const port = db.port(sid, diaryOnly(INCIDENT_EVENT + OTHER_EVENT));
  const claim = await port.claim();
  await port.startProvider(claim);
  await port.settlePublished(claim, "1790000000000000006");
  await assert.rejects(() => port.settlePublished(claim, "1790000000000000099"), /AI_LAB_TOPIC_CLAIM_X_POST_CONFLICT/u);
  await assert.rejects(() => port.settlePublished({ ...claim, unitKey: `${claim.eventKey}#decided` }, "1790000000000000006"), /AI_LAB_TOPIC_CLAIM_IDENTITY_CONFLICT/u);
  const other: AiLabClaimedTopic = { ...claim, eventKey: INCIDENT_KEY, unitKey: `${INCIDENT_KEY}#changed` };
  await assert.rejects(() => port.settlePublished(other, "1790000000000000006"), /AI_LAB_TOPIC_CLAIM_/u);
  await assert.rejects(() => port.claim(), /AI_LAB_TOPIC_SCHEDULE_CONFLICT/u);
});

// ---------------------------------------------------------------------------------------------------
// 13〜15. 安定した event ID
// ---------------------------------------------------------------------------------------------------
const INSERTED = `
## 2026-09-29
event_id: 20260929-save-button-fix
changed: 通知設定画面の保存ボタンを直した
`;

test("(13) H1: inserting / reordering entries cannot rename or revive a used event", async () => {
  const db = new ClaimDb();
  await dispatch(db, 0, diaryOnly(INCIDENT_EVENT)).run();
  for (const markdown of [INSERTED + INCIDENT_EVENT, INCIDENT_EVENT + INSERTED, OTHER_EVENT + INCIDENT_EVENT + INSERTED]) {
    const keys = diaryOnly(markdown).map((c) => c.eventKey);
    assert.ok(keys.includes(INCIDENT_KEY));
    const result = db.claim(`00000000-0000-0000-0000-0000000070${keys.length}${markdown.length % 10}`, diaryOnly(markdown).filter((c) => c.eventKey === INCIDENT_KEY));
    assert.equal(result.claim, null);
    assert.equal(result.rejected[0].reason, "EVENT_PUBLISHED");
  }
});

test("(13) H1: an earlier entry losing its changed field (dropped by the parser) cannot rename a later event", () => {
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

test("event IDs: missing, malformed, wrong date, internal-looking or duplicate IDs are never candidates", () => {
  const bad = (id: string) => `\n## 2026-10-01\nevent_id: ${id}\nchanged: 何かを直した\n`;
  for (const id of ["", "20261001", "20260930-wrong-date", "20261001-Upper", "20261001-pr82-fix", "20261001-g3-task", "20261001-fix-08a7346c", "20261001-token-rotation", `20261001-${"a".repeat(60)}`]) {
    const { candidates, exclusions } = buildAiLabTopicCandidates({ markdown: bad(id), now: NOW, rotationIndex: 0 });
    assert.equal(candidates.filter((c) => c.kind === "diary").length, 0, id);
    assert.ok(exclusions.some((e) => e.reason === "DIARY_EVENT_ID_MISSING_OR_INVALID"), id);
  }
  const noId = "\n## 2026-10-01\nchanged: 何かを直した\n";
  assert.equal(diaryOnly(noId).length, 0);
  const dup = `${OTHER_EVENT}\n## 2026-09-30\nevent_id: 20261001-notification-settings\nchanged: 別の話\n`;
  const { candidates, exclusions } = buildAiLabTopicCandidates({ markdown: dup, now: NOW, rotationIndex: 0 });
  assert.equal(candidates.filter((c) => c.kind === "diary").length, 0);
  assert.ok(exclusions.some((e) => e.reason === "DIARY_EVENT_ID_DUPLICATE"));
  assert.equal(isValidDiaryEventId("20260930-x-auth-test-account-overlap", "2026-09-30"), true);
});

test("the real canonical diary: every entry has a valid, unique event ID and the sanitizer leaves entries unchanged (CI rule)", async () => {
  const markdown = await loadAiLabDevDiaryMarkdown();
  const entries = parseDevDiaryMarkdown(markdown);
  assert.ok(entries.length >= 8);
  const ids = entries.map((e) => e.eventId);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of entries) {
    assert.ok(entry.eventId && isValidDiaryEventId(entry.eventId, entry.date), `${entry.date}: ${entry.eventId}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// 16〜17. evergreen
// ---------------------------------------------------------------------------------------------------
test("(16) evergreen: same seed waits 72h, same theme tag waits 48h", async () => {
  const db = new ClaimDb();
  const pick = (...indexes: number[]) => indexes.map((i) => candidatesFor("", 0).find((c) => c.eventKey === `evergreen-${i}`)!);
  const first = (await dispatch(db, 0, pick(0)).run()).topicEventKey;
  assert.equal(first, "evergreen-0"); // tags: unglamorous_work
  db.now += 2 * HOUR;
  const out = db.claim("00000000-0000-0000-0000-000000008001", pick(0, 5, 2));
  assert.deepEqual(out.rejected, [
    { eventKey: "evergreen-0", reason: "EVERGREEN_SEED_COOLDOWN" },
    { eventKey: "evergreen-5", reason: "EVERGREEN_THEME_COOLDOWN" }, // shares unglamorous_work
  ]);
  assert.equal(out.claim?.eventKey, "evergreen-2");
  db.now += 47 * HOUR; // 49h after evergreen-0: theme cooldown over, seed cooldown still on
  const later = db.claim("00000000-0000-0000-0000-000000008002", pick(0, 5));
  assert.deepEqual(later.rejected, [{ eventKey: "evergreen-0", reason: "EVERGREEN_SEED_COOLDOWN" }]);
  assert.equal(later.claim?.eventKey, "evergreen-5");
});

test("(17) H1: evergreen pool exhausted -> the slot is skipped (no claim, no X); cooldown is never broken", async () => {
  const db = new ClaimDb();
  // 全 seed がこの72時間以内に投稿済み（1〜7時間前）。
  EVERGREEN_TOPIC_SEEDS.forEach((_, i) => {
    db.rows.push({
      claimId: `00000000-0000-0000-0000-0000000090${String(i).padStart(2, "0")}`,
      scheduledPostId: `00000000-0000-0000-0000-0000000091${String(i).padStart(2, "0")}`,
      kind: "evergreen", eventKey: `evergreen-${i}`, unitKey: `evergreen-${i}`, themeTags: [],
      state: "published", claimedAt: db.now - (i + 1) * HOUR, leaseUntil: db.now - i * HOUR, xPostId: String(i + 1), reason: null,
    });
  });
  const d = dispatch(db, 99, candidatesFor("", 0));
  await assert.rejects(d.run, /AI_LAB_TOPIC_POOL_EXHAUSTED/u);
  assert.equal(d.counter.x, 0);
  assert.equal(d.counter.topics.length, 0, "nothing was generated");
});

test("(13 in old list) empty / stale / unsafe diary -> only evergreen candidates", () => {
  for (const markdown of ["", "## 2026-09-01\nevent_id: 20260901-old\nchanged: だいぶ前の変更。\n", "## 2026-10-01\nevent_id: 20261001-unsafe\nchanged: 危険 https://example.com\n"]) {
    const candidates = candidatesFor(markdown);
    assert.ok(candidates.length === EVERGREEN_TOPIC_SEEDS.length && candidates.every((c) => c.kind === "evergreen"));
  }
});

test("a newly added diary event is the first candidate regardless of rotationIndex", () => {
  for (let i = -5; i < 40; i += 1) assert.equal(candidatesFor(INCIDENT_EVENT + OTHER_EVENT, i)[0].eventKey, OTHER_KEY);
});

// ---------------------------------------------------------------------------------------------------
// ログ・RPC の形
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
`;
  const { candidates, exclusions } = buildAiLabTopicCandidates({ markdown, now: NOW, rotationIndex: 3 });
  assert.ok(exclusions.length >= 4);
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
    scheduledPostId: "00000000-0000-0000-0000-00000000a000",
    candidates,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      sent = String(init?.body);
      assert.match(String(url), /\/rest\/v1\/rpc\/claim_ai_lab_topic$/u);
      return new Response(JSON.stringify({ claim: null, rejected: [] }), { status: 200 });
    }) as typeof fetch,
  });
  assert.doesNotMatch(sent, /[぀-ヿ一-龯]/u, "topic text is never sent to the database");
  assert.deepEqual(Object.keys(JSON.parse(sent).p_candidates[0]).sort(), ["event_key", "kind", "theme_tags", "unit_key"]);
});

test("claim RPC: malformed responses and opaque errors fail closed; only AI_LAB_TOPIC_CLAIM_* codes pass through", async () => {
  const base = { supabaseUrl: "https://fixture.invalid", serviceRoleKey: "k", scheduledPostId: "00000000-0000-0000-0000-00000000b000", candidates: candidatesFor("") };
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: reply({ nope: true }) }), /AI_LAB_TOPIC_CLAIM_INVALID_RESPONSE/u);
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: reply({ claim: { claim_id: "x", kind: "diary", event_key: "X認証", unit_key: "u" }, rejected: [] }) }), /AI_LAB_TOPIC_CLAIM_INVALID_RESPONSE/u);
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: reply({ message: "relation \"ai_lab_topic_claims\" does not exist" }, 404) }), /^BrandContextError: AI_LAB_TOPIC_RPC_FAILED$|AI_LAB_TOPIC_RPC_FAILED/u);
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: reply({ message: "AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT" }, 400) }), /AI_LAB_TOPIC_CLAIM_INVALID_ARGUMENT/u);
  await assert.rejects(() => claimAiLabTopic({ ...base, fetchImpl: (async () => { throw new Error("network"); }) as typeof fetch }), /network/u);
});

test("claim RPC unavailable (e.g. migration not applied) -> the dispatcher never reaches X", async () => {
  const sid = "00000000-0000-0000-0000-00000000c000";
  const port = createAiLabTopicPort({
    supabaseUrl: "https://fixture.invalid", serviceRoleKey: "k", scheduledPostId: sid, candidates: candidatesFor(INCIDENT_EVENT),
    fetchImpl: (async () => new Response(JSON.stringify({ message: "not found" }), { status: 404 })) as typeof fetch,
  });
  let x = 0, generated = 0;
  await assert.rejects(() =>
    dispatchAiLabScheduledBrandPost({
      context, postType: "brand_post", scheduledPostId: sid, openAiApiKey: "fixture-only", topic: port,
      loadRecentFingerprints: async () => [],
      generate: async () => { generated += 1; return draftOf(TEXTS[0]); },
      publishText: async () => { x += 1; return { data: { id: "1" } }; },
      completePublishedPost: async () => ({ fingerprintPersisted: true }),
    }), /AI_LAB_TOPIC_RPC_FAILED/u);
  assert.deepEqual([x, generated], [0, 0]);
});

// ---------------------------------------------------------------------------------------------------
// 18〜20, 23: 実 SQL・配線・他ブランドの静的確認
// ---------------------------------------------------------------------------------------------------
test("(18)(19)(20) migration: AI-Lab-only claims table + five service_role functions, drift fail-closed, ACL self-check; runner exists", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("../../../migrations/", import.meta.url);
  const files = await readdir(dir);
  assert.ok(!files.some((f) => f.endsWith("_ai_lab_topic_event_usage.sql")), "the superseded PR82 usage migration is gone");
  const name = files.find((f) => f.endsWith("_ai_lab_topic_claims.sql"));
  assert.ok(name);
  const sql = (await readFile(new URL(name!, dir), "utf8")).replace(/--.*$/gmu, "");
  assert.match(sql, /AI_LAB_TOPIC_CLAIMS_SCHEMA_DRIFT/u);
  assert.match(sql, /AI_LAB_TOPIC_CLAIMS_PREFLIGHT/u);
  assert.match(sql, /AI_LAB_TOPIC_CLAIMS_ACL/u);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('ai_lab_topic_claims:ai_salaryman_lab', 0\)\)/u);
  assert.match(sql, /revoke all on table public\.ai_lab_topic_claims from public, anon, authenticated, service_role;/u);
  assert.doesNotMatch(sql, /grant [a-z, ]+ on table public\.ai_lab_topic_claims/u);
  assert.equal((sql.match(/grant execute on function public\.[a-z_]+\([a-z, ]+\) to service_role;/gu) ?? []).length, 5);
  assert.equal((sql.match(/security definer\s+set search_path = ''/gu) ?? []).length, 5);
  assert.doesNotMatch(sql, /\b(post_text|body|content|normalized_text)\b text/u);
  // テーブル・関数以外の既存オブジェクトに触れない
  const touched = new Set([...sql.matchAll(/public\.([a-z_]+)/gu)].map((m) => m[1]));
  assert.deepEqual([...touched].sort(), [
    "ai_lab_topic_claims", "ai_lab_topic_event_usage", "claim_ai_lab_topic", "mark_ai_lab_topic_claim_ambiguous",
    "release_ai_lab_topic_claim", "settle_ai_lab_topic_claim_published", "start_ai_lab_topic_provider",
  ]);
  // SQL の event_key CHECK と TS の AI_LAB_EVENT_KEY_PATTERN が同じキーを受け入れる
  const diaryRe = new RegExp(/event_key ~ '(\^diary:[^']+)'/u.exec(sql)![1], "u");
  const evergreenRe = new RegExp(/event_key ~ '(\^evergreen-[^']+)'/u.exec(sql)![1], "u");
  for (const key of [INCIDENT_KEY, OTHER_KEY, "evergreen-0", "evergreen-6", "diary-2026-10-01-1", "diary:X認証", "evergreen-x", "diary:2026-x", `${INCIDENT_KEY}#changed`]) {
    assert.equal(diaryRe.test(key) || evergreenRe.test(key), AI_LAB_EVENT_KEY_PATTERN.test(key), key);
  }
  const runner = await readFile(new URL("../../../tests/ai_lab_topic_claims_run.sh", import.meta.url), "utf8");
  for (const label of ["session B waited for A", "drift_case missing_pk", "drift_case policy", "pool exhausted", "anon cannot execute"]) {
    assert.ok(runner.includes(label), label);
  }
});

test("(23) x-test-post wires the claim port into the AI Lab brand_post branch only; no other function imports the AI Lab modules", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const source = await readFile(new URL("../../x-test-post/index.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (scheduledPost.post_type === "brand_post")');
  const block = source.slice(start, source.indexOf("AI_LAB_POST_CONFIRMED_BUT_COMPLETION_UNCONFIRMED", start));
  assert.match(block, /buildAiLabTopicCandidates\(/u);
  assert.match(block, /createAiLabTopicPort\(/u);
  assert.match(block, /topic: topicPort,/u);
  assert.equal((source.match(/createAiLabTopicPort\(/gu) ?? []).length, 1);
  assert.doesNotMatch(source, /recordAiLabTopicUsage|loadAiLabTopicUsage|selectAiLabRotatingTopicSeed/u);
  const functionsDir = new URL("../../", import.meta.url);
  for (const fn of await readdir(functionsDir)) {
    if (fn === "_shared" || fn === "x-test-post" || fn.includes(".")) continue;
    for (const file of await readdir(new URL(`${fn}/`, functionsDir)).catch(() => [])) {
      if (!file.endsWith(".ts")) continue;
      const body = await readFile(new URL(`${fn}/${file}`, functionsDir), "utf8");
      assert.doesNotMatch(body, /ai_lab_(brand_post_store|scheduled_brand_post|dev_diary_context|theme_guard)/u, `${fn}/${file}`);
    }
  }
});

test("the real bundled diary: simulated posts over a day use each fresh event at most once, then evergreen, never repeating a seed inside its cooldown", async () => {
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
