// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import test from "node:test";
import { prepareNewsCandidate, type IncomingNewsCandidate, type PreparedNewsCandidate } from "./news_candidate_logic.ts";
import {
  classifyTdnetPriority,
  decideTdnetFailure,
  effectiveTier,
  isClaimable,
  planTdnetClaims,
  TDNET_WORKER_LIMITS,
  tdnetGroupKey,
  toTdnetQueueInsert,
  type TdnetQueueRow,
} from "./tdnet_intake_logic.ts";
import { runTdnetEnrichmentWorker, type TdnetWorkerDeps } from "./tdnet_enrichment_worker.ts";
import { createTdnetQueueRepository, type TdnetQueueRepository } from "./tdnet_queue_repository.ts";

const T0 = Date.parse("2026-10-06T06:00:00.000Z");
let seq = 0;

function incoming(over: Partial<IncomingNewsCandidate> = {}): IncomingNewsCandidate {
  seq += 1;
  return {
    sourceType: "tdnet", sourceName: "tdnet", sourceUrl: `https://www.release.tdnet.info/inbs/${seq}.pdf`,
    title: "業績予想の修正に関するお知らせ", bodySummary: null, companyName: `会社${seq}`, companyCode: `${1000 + seq}`,
    entityKey: `company:${1000 + seq}`, category: "other_corporate_ir", publishedAt: new Date(T0).toISOString(), ...over,
  };
}

function rowOf(over: Partial<TdnetQueueRow> = {}): TdnetQueueRow {
  const candidate = incoming();
  const insert = toTdnetQueueInsert(candidate)!;
  return {
    id: `row-${seq}`, ...insert, state: "queued", attempt_count: 0, last_error: null, next_attempt_at: new Date(T0).toISOString(),
    claimed_by: null, claimed_at: null, lease_expires_at: null, candidate_id: null, discovered_at: new Date(T0).toISOString(), ...over,
  } as TdnetQueueRow;
}

// ------------------------------------------------------------ priority

test("priority: TOB / revision / buyback decisions are tier 1; ETF, status notices and personnel are tier 3", () => {
  const tier = (title: string) => classifyTdnetPriority(title).tier;
  for (const title of ["（株）〇〇に対する公開買付けの開始に関するお知らせ", "業績予想の修正に関するお知らせ", "剰余金の配当（増配）に関するお知らせ",
    "自己株式取得に係る事項の決定に関するお知らせ", "自己株式の消却に関するお知らせ", "第三者割当による新株式の発行に関するお知らせ",
    "当社工場における火災の発生について", "サイバー攻撃による被害に関するお知らせ", "上場廃止の決定について", "大型受注に関するお知らせ"]) {
    assert.equal(tier(title), 1, title);
  }
  for (const title of ["ETFの収益分配のお知らせ", "SPDRゴールド・シェアに関する日々の開示事項", "自己株式の取得状況に関するお知らせ",
    "支配株主等に関する事項について", "役員人事に関するお知らせ", "第3回新株予約権の月間行使状況に関するお知らせ", "資金の借入れに関するお知らせ"]) {
    assert.equal(tier(title), 3, title);
  }
  assert.equal(tier("2027年3月期 第2四半期決算短信〔日本基準〕（連結）"), 2);
  assert.equal(tier("お知らせ"), 2);
});

test("priority: a routine notice that mentions a high-tier keyword stays low (routine is checked first)", () => {
  assert.equal(classifyTdnetPriority("自己株式の取得状況及び取得終了に関するお知らせ").tier, 3);
  assert.equal(classifyTdnetPriority("上場ETF（管理会社：〇〇）に関する日々の開示事項（受注・解約）").tier, 3);
});

test("queue insert: only well-formed TDnet items, https only, group key buckets one issuer's 5 minutes", () => {
  assert.equal(toTdnetQueueInsert(incoming({ sourceType: "company_ir" })), null);
  assert.equal(toTdnetQueueInsert(incoming({ sourceUrl: "http://x/a.pdf" })), null);
  assert.equal(toTdnetQueueInsert(incoming({ companyCode: "" })), null);
  const a = tdnetGroupKey("7203", "2026-10-06T06:00:10.000Z");
  assert.equal(a, tdnetGroupKey("7203", "2026-10-06T06:04:00.000Z"));
  assert.notEqual(a, tdnetGroupKey("7203", "2026-10-06T06:06:00.000Z"));
  assert.notEqual(a, tdnetGroupKey("6758", "2026-10-06T06:00:10.000Z"));
});

// ------------------------------------------------------------ planning

test("plan: high tier first, then age; oldest slot guarantees the oldest low-tier row a place", () => {
  const old = rowOf({ priority_tier: 3, published_at: new Date(T0 - 60 * 60_000).toISOString(), group_key: "old" });
  const highs = Array.from({ length: 12 }, (_, i) => rowOf({ priority_tier: 1, published_at: new Date(T0 - i * 1000).toISOString(), group_key: `h${i}` }));
  const plan = planTdnetClaims([...highs, old], T0, { maxItems: 10 });
  assert.equal(plan.length, 10);
  assert.equal(plan[0].rows[0].group_key, "old");
  assert.equal(plan[0].reason, "oldest");
  assert.ok(plan.slice(1).every((group) => group.rows[0].priority_tier === 1));
});

test("plan: aging lifts a long-waiting low-tier row above fresh mid-tier rows", () => {
  const waiting = rowOf({ priority_tier: 3, published_at: new Date(T0 - 5 * 3600_000).toISOString(), group_key: "w" });
  assert.equal(effectiveTier(waiting, T0), 1);
  const fresh = Array.from({ length: 4 }, (_, i) => rowOf({ priority_tier: 2, published_at: new Date(T0 - i * 1000).toISOString(), group_key: `f${i}` }));
  const plan = planTdnetClaims([...fresh, waiting], T0, { maxItems: 3, oldestSlots: 0 });
  assert.equal(plan[0].rows[0].group_key, "w");
});

test("plan: same-issuer disclosures stay one atomic group; an oversized first group is taken whole, later ones are not", () => {
  const sibling = (n: number) => rowOf({ group_key: "same", published_at: new Date(T0 + n).toISOString(), priority_tier: 1 });
  const bundle = [sibling(1), sibling(2), sibling(3), sibling(4)];
  const other = rowOf({ group_key: "other", priority_tier: 1, published_at: new Date(T0 + 10).toISOString() });
  const plan = planTdnetClaims([...bundle, other], T0, { maxItems: 3, oldestSlots: 0 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].rows.length, 4);
  assert.equal(planTdnetClaims(Array.from({ length: 9 }, (_, i) => sibling(i)), T0, { maxItems: 20 })[0].rows.length, TDNET_WORKER_LIMITS.maxGroupMembers);
});

test("claimable: queued, due retry, expired lease; not live lease, completed or exhausted", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  assert.equal(isClaimable(rowOf(), T0), true);
  assert.equal(isClaimable(rowOf({ state: "failed_retryable", next_attempt_at: iso(T0 + 1000) }), T0), false);
  assert.equal(isClaimable(rowOf({ state: "failed_retryable", next_attempt_at: iso(T0 - 1) }), T0), true);
  assert.equal(isClaimable(rowOf({ state: "enriching", claimed_by: "w", lease_expires_at: iso(T0 + 1000) }), T0), false);
  assert.equal(isClaimable(rowOf({ state: "enriching", claimed_by: "w", lease_expires_at: iso(T0 - 1) }), T0), true);
  assert.equal(isClaimable(rowOf({ state: "candidate_created" }), T0), false);
  assert.equal(isClaimable(rowOf({ attempt_count: TDNET_WORKER_LIMITS.maxAttempts + 1 }), T0), false);
});

test("failure decision: transient errors back off, permanent ones and the last attempt fall back to a body-less candidate", () => {
  const retry1 = decideTdnetFailure(1, "TDNET_PDF_FETCH_FAILED:503", T0);
  assert.deepEqual(retry1, { action: "retry", nextAttemptAt: new Date(T0 + 5 * 60_000).toISOString() });
  assert.deepEqual(decideTdnetFailure(2, "TDNET_QUEUE_ERROR", T0), { action: "retry", nextAttemptAt: new Date(T0 + 15 * 60_000).toISOString() });
  assert.deepEqual(decideTdnetFailure(3, "TDNET_PDF_FETCH_FAILED:503", T0), { action: "fallback_without_body" });
  for (const code of ["TDNET_PDF_TOO_LARGE", "TDNET_PDF_INVALID", "TDNET_PDF_TEXT_EMPTY", "TDNET_PDF_FETCH_FAILED:404"]) {
    assert.deepEqual(decideTdnetFailure(1, code, T0), { action: "fallback_without_body" }, code);
  }
});

// ------------------------------------------------------------ worker (in-memory repository with the real claim semantics)

function memoryRepo(initial: TdnetQueueRow[], clock: { now: number }): TdnetQueueRepository & { rows: TdnetQueueRow[] } {
  const rows = initial.map((row) => ({ ...row }));
  const find = (id: string) => rows.find((row) => row.id === id)!;
  return {
    rows,
    async enqueue(inserts) {
      let inserted = 0;
      for (const insert of inserts) {
        if (rows.some((row) => row.source_url === insert.source_url)) continue;
        rows.push({ ...insert, id: `q${rows.length}`, state: "queued", attempt_count: 0, last_error: null, next_attempt_at: new Date(clock.now).toISOString(), claimed_by: null, claimed_at: null, lease_expires_at: null, candidate_id: null, discovered_at: new Date(clock.now).toISOString() });
        inserted += 1;
      }
      return inserted;
    },
    async readClaimable(now) { return rows.filter((row) => isClaimable(row, now)).map((row) => ({ ...row })); },
    async claim(candidates, workerId, now) {
      const won: TdnetQueueRow[] = [];
      for (const read of candidates) {
        const row = find(read.id);
        // The same predicate the PATCH filter expresses: attempt_count unchanged and still claimable.
        if (row.attempt_count !== read.attempt_count || !isClaimable(row, now)) continue;
        Object.assign(row, { state: "enriching", claimed_by: workerId, claimed_at: new Date(now).toISOString(), lease_expires_at: new Date(now + TDNET_WORKER_LIMITS.leaseMs).toISOString(), attempt_count: row.attempt_count + 1 });
        won.push({ ...row });
      }
      return won;
    },
    async markCandidateCreated(id, candidateId, lastError) { Object.assign(find(id), { state: "candidate_created", candidate_id: candidateId, last_error: lastError, claimed_by: null, lease_expires_at: null }); },
    async markSkipped(id, reason) { Object.assign(find(id), { state: "skipped_routine", last_error: reason, claimed_by: null, lease_expires_at: null }); },
    async markRetry(id, next, err) { Object.assign(find(id), { state: "failed_retryable", next_attempt_at: next, last_error: err, claimed_by: null, lease_expires_at: null }); },
    async markTerminal(id, err) { Object.assign(find(id), { state: "failed_terminal", last_error: err, claimed_by: null, lease_expires_at: null }); },
    async sweepExhausted(now) {
      const exhausted = rows.filter((row) => row.attempt_count >= TDNET_WORKER_LIMITS.maxAttempts + 1 && row.state !== "candidate_created" && row.state !== "failed_terminal" && (row.state !== "enriching" || Date.parse(row.lease_expires_at!) < now));
      for (const row of exhausted) Object.assign(row, { state: "failed_terminal", last_error: "TDNET_QUEUE_ATTEMPTS_EXHAUSTED" });
      return exhausted.length;
    },
    async stats() { return { queued: 0, enriching: 0, failedRetryable: 0, failedTerminal: 0, oldestWaitingMinutes: null }; },
  };
}

function depsFor(repo: TdnetQueueRepository, clock: { now: number }, over: Partial<TdnetWorkerDeps> = {}) {
  const created: PreparedNewsCandidate[][] = [];
  const stored = new Map<string, string>();
  const deps: TdnetWorkerDeps = {
    repo, workerId: "w1", now: () => clock.now,
    prepare: (candidate) => prepareNewsCandidate(candidate),
    findDuplicate: async (prepared) => (stored.has(prepared.sourceUrl) ? { id: stored.get(prepared.sourceUrl)! } : null),
    loadPdfSummary: async () => "業績予想 修正前 修正後",
    createCandidates: async (members) => {
      created.push(members);
      const ids = new Map<string, string>();
      for (const member of members) { const id = `cand-${stored.size}`; stored.set(member.sourceUrl, id); ids.set(member.sourceUrl, id); }
      return ids;
    },
    ...over,
  };
  return { deps, created, stored };
}

test("worker: 0 rows is a no-op; 1/3/6/20/100 rows drain within the per-run bound, highest tier first", async () => {
  for (const [count, expected] of [[0, 0], [1, 1], [3, 3], [6, 6], [20, 10], [100, 10]] as const) {
    const clock = { now: T0 };
    const repo = memoryRepo(Array.from({ length: count }, (_, i) => rowOf({ priority_tier: i % 3 === 0 ? 1 : 2, published_at: new Date(T0 - i * 60_000).toISOString() })), clock);
    const { deps } = depsFor(repo, clock);
    const result = await runTdnetEnrichmentWorker(deps, { maxItems: 10 });
    assert.equal(result.candidatesCreated, expected, `count=${count}`);
    assert.equal(repo.rows.filter((row) => row.state === "candidate_created").length, expected);
  }
});

test("worker: PDF concurrency never exceeds the configured level (and is capped at 3)", async () => {
  for (const [asked, cap] of [[1, 1], [2, 2], [3, 3], [9, 3]] as const) {
    const clock = { now: T0 };
    const repo = memoryRepo(Array.from({ length: 12 }, (_, i) => rowOf({ group_key: `g${i}`, published_at: new Date(T0 - i * 60_000).toISOString() })), clock);
    let active = 0, peak = 0;
    const { deps } = depsFor(repo, clock, { loadPdfSummary: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return "本文"; } });
    await runTdnetEnrichmentWorker(deps, { maxItems: 12, concurrency: asked });
    assert.ok(peak <= cap && peak >= Math.min(cap, 2) - (cap === 1 ? 0 : 0), `asked=${asked} peak=${peak}`);
  }
});

test("priority: a buyback decision that mentions the status notice is not routine; takeover defence is high", () => {
  assert.equal(classifyTdnetPriority("自己株式の取得枠拡大及び自己株式の取得状況に関するお知らせ").tier, 1);
  assert.equal(classifyTdnetPriority("自己株式の取得状況に関するお知らせ").reason, "buyback_status_routine");
  assert.equal(classifyTdnetPriority("当社株式の大量買付行為への対応方針（買収防衛策）の継続について").tier, 1);
});

test("worker: skipRoutine records strictly routine notices without a PDF or candidate; off by default", async () => {
  const mk = () => [
    rowOf({ priority_tier: 3, priority_reason: "etf_etn_routine", group_key: "a", title: "ETFの収益分配のお知らせ" }),
    rowOf({ priority_tier: 3, priority_reason: "personnel_routine", group_key: "b", title: "役員人事に関するお知らせ" }),
  ];
  let clock = { now: T0 };
  let repo = memoryRepo(mk(), clock);
  let pdf = 0;
  let w = depsFor(repo, clock, { loadPdfSummary: async () => { pdf += 1; return "本文"; } });
  let result = await runTdnetEnrichmentWorker(w.deps, { skipRoutine: true });
  assert.equal(result.skippedRoutine, 1);
  assert.equal(pdf, 1, "only the non-skippable one fetched a PDF");
  assert.deepEqual(repo.rows.map((r) => r.state).sort(), ["candidate_created", "skipped_routine"]);
  assert.equal(repo.rows.find((r) => r.state === "skipped_routine")!.last_error, "etf_etn_routine");
  clock = { now: T0 }; repo = memoryRepo(mk(), clock); pdf = 0;
  w = depsFor(repo, clock, { loadPdfSummary: async () => { pdf += 1; return "本文"; } });
  result = await runTdnetEnrichmentWorker(w.deps);
  assert.equal(result.skippedRoutine, 0);
  assert.equal(pdf, 2);
});

test("worker: a stored duplicate is detected before any PDF is fetched", async () => {
  const clock = { now: T0 };
  const row = rowOf();
  const repo = memoryRepo([row], clock);
  let pdfCalls = 0;
  const { deps, stored } = depsFor(repo, clock, { loadPdfSummary: async () => { pdfCalls += 1; return "x"; } });
  stored.set(row.source_url, "existing-1");
  const result = await runTdnetEnrichmentWorker(deps);
  assert.equal(pdfCalls, 0);
  assert.equal(result.alreadyStored, 1);
  assert.equal(repo.rows[0].candidate_id, "existing-1");
  assert.equal(repo.rows[0].state, "candidate_created");
});

test("worker: transient PDF failure -> retry with backoff -> success next time; third attempt falls back body-less", async () => {
  const clock = { now: T0 };
  const repo = memoryRepo([rowOf()], clock);
  let calls = 0;
  const { deps, created } = depsFor(repo, clock, { loadPdfSummary: async () => { calls += 1; throw new Error("TDNET_PDF_FETCH_FAILED:503"); } });
  let result = await runTdnetEnrichmentWorker(deps);
  assert.equal(result.pdfFailedRetry, 1);
  assert.equal(repo.rows[0].state, "failed_retryable");
  // not due yet: nothing happens
  result = await runTdnetEnrichmentWorker(deps);
  assert.equal(result.claimedItems, 0);
  clock.now += 6 * 60_000;
  result = await runTdnetEnrichmentWorker(deps);
  assert.equal(repo.rows[0].attempt_count, 2);
  assert.equal(result.pdfFailedRetry, 1);
  clock.now += 16 * 60_000;
  result = await runTdnetEnrichmentWorker(deps);
  assert.equal(result.fallbackWithoutBody, 1);
  assert.equal(repo.rows[0].state, "candidate_created");
  assert.equal(repo.rows[0].last_error, "TDNET_PDF_FETCH_FAILED:503");
  assert.equal(created.length, 1);
  assert.equal(created[0][0].bodySummary, null);
  assert.equal(calls, 3);
});

test("worker: malformed / oversize PDF falls back immediately without retry (legacy outcome, never lost)", async () => {
  for (const code of ["TDNET_PDF_TOO_LARGE", "TDNET_PDF_INVALID", "TDNET_PDF_TEXT_EMPTY"]) {
    const clock = { now: T0 };
    const repo = memoryRepo([rowOf()], clock);
    const { deps, created } = depsFor(repo, clock, { loadPdfSummary: async () => { throw new Error(code); } });
    const result = await runTdnetEnrichmentWorker(deps);
    assert.equal(result.fallbackWithoutBody, 1, code);
    assert.equal(repo.rows[0].state, "candidate_created");
    assert.equal(created[0][0].bodySummary, null);
  }
});

test("worker: crash mid-run leaves a lease; after it expires another worker finishes it exactly once", async () => {
  const clock = { now: T0 };
  const repo = memoryRepo([rowOf()], clock);
  const { deps: crashing } = depsFor(repo, clock, { loadPdfSummary: async () => { throw new TypeError("process died"); } });
  // a thrown non-code error becomes a retry; simulate a hard crash by claiming without finishing
  const [row] = await repo.readClaimable(clock.now);
  await repo.claim([row], "dead-worker", clock.now);
  assert.equal(repo.rows[0].state, "enriching");
  let result = await runTdnetEnrichmentWorker(crashing);
  assert.equal(result.claimedItems, 0, "live lease is respected");
  clock.now += TDNET_WORKER_LIMITS.leaseMs + 1000;
  const { deps, created } = depsFor(repo, clock);
  result = await runTdnetEnrichmentWorker(deps);
  assert.equal(result.candidatesCreated, 1);
  assert.equal(repo.rows[0].attempt_count, 2);
  result = await runTdnetEnrichmentWorker(deps);
  assert.equal(created.length, 1, "never inserted twice");
});

test("worker: two workers racing for the same rows split them; every row is processed once", async () => {
  const clock = { now: T0 };
  const repo = memoryRepo(Array.from({ length: 8 }, (_, i) => rowOf({ group_key: `g${i}`, published_at: new Date(T0 - i * 60_000).toISOString() })), clock);
  const a = depsFor(repo, clock, { workerId: "a", loadPdfSummary: async () => { await new Promise((r) => setTimeout(r, 2)); return "本文"; } });
  const b = depsFor(repo, clock, { workerId: "b", loadPdfSummary: async () => { await new Promise((r) => setTimeout(r, 2)); return "本文"; } });
  const [ra, rb] = await Promise.all([runTdnetEnrichmentWorker(a.deps, { maxItems: 8 }), runTdnetEnrichmentWorker(b.deps, { maxItems: 8 })]);
  const urlsA = a.created.flat().map((m) => m.sourceUrl);
  const urlsB = b.created.flat().map((m) => m.sourceUrl);
  assert.equal(urlsA.filter((url) => urlsB.includes(url)).length, 0, "no row created by both workers");
  assert.equal(urlsA.length + urlsB.length, 8);
  assert.equal(ra.lostClaims + rb.lostClaims >= 0, true);
  assert.ok(repo.rows.every((row) => row.state === "candidate_created" && row.attempt_count === 1));
});

test("worker: crash loop ends in failed_terminal (dead letter), not an endless retry", async () => {
  const clock = { now: T0 };
  const repo = memoryRepo([rowOf({ state: "enriching", claimed_by: "dead", lease_expires_at: new Date(T0 - 1).toISOString(), attempt_count: TDNET_WORKER_LIMITS.maxAttempts + 1 })], clock);
  const { deps } = depsFor(repo, clock);
  const result = await runTdnetEnrichmentWorker(deps);
  assert.equal(result.swept, 1);
  assert.equal(repo.rows[0].state, "failed_terminal");
  assert.equal(repo.rows[0].last_error, "TDNET_QUEUE_ATTEMPTS_EXHAUSTED");
});

test("worker: candidate insert failure retries, then dead-letters on the last attempt", async () => {
  const clock = { now: T0 };
  const repo = memoryRepo([rowOf()], clock);
  const { deps } = depsFor(repo, clock, { createCandidates: async () => { throw new Error("NEWS_CANDIDATE_INSERT_FAILED"); } });
  const result = await runTdnetEnrichmentWorker(deps);
  assert.equal(result.insertFailed, 1);
  assert.equal(repo.rows[0].state, "failed_retryable");
  clock.now += 6 * 60_000;
  await runTdnetEnrichmentWorker(deps);
  clock.now += 16 * 60_000;
  await runTdnetEnrichmentWorker(deps);
  assert.equal(repo.rows[0].state, "failed_terminal");
  assert.equal(repo.rows[0].attempt_count, 3);
});

test("worker: the wall-clock budget stops new groups and leaves the rows queued", async () => {
  const clock = { now: T0 };
  const repo = memoryRepo(Array.from({ length: 6 }, (_, i) => rowOf({ group_key: `g${i}`, published_at: new Date(T0 - i * 60_000).toISOString() })), clock);
  const { deps } = depsFor(repo, clock, { loadPdfSummary: async () => { clock.now += 40_000; return "本文"; } });
  const result = await runTdnetEnrichmentWorker(deps, { maxItems: 6, concurrency: 1, budgetMs: 70_000 });
  assert.ok(result.candidatesCreated >= 2 && result.candidatesCreated < 6);
  assert.equal(result.skippedForBudget, 6 - result.candidatesCreated);
  assert.equal(repo.rows.filter((row) => row.state === "queued").length, result.skippedForBudget);
});

test("starvation: a low-tier item among a steady stream of high-tier items is still processed within a bounded number of runs", async () => {
  const clock = { now: T0 };
  const low = rowOf({ priority_tier: 3, published_at: new Date(T0 - 10 * 60_000).toISOString(), group_key: "low" });
  const repo = memoryRepo([low], clock);
  const { deps } = depsFor(repo, clock);
  for (let run = 0; run < 6 && repo.rows.find((r) => r.id === low.id)!.state !== "candidate_created"; run += 1) {
    await repo.enqueue(Array.from({ length: 12 }, (_, i) => toTdnetQueueInsert(incoming({ title: "業績予想の修正に関するお知らせ", companyCode: `${5000 + run * 20 + i}`, publishedAt: new Date(clock.now - i * 1000).toISOString() }))!));
    await runTdnetEnrichmentWorker(deps, { maxItems: 4 });
    clock.now += 5 * 60_000;
  }
  assert.equal(repo.rows.find((r) => r.id === low.id)!.state, "candidate_created");
});

// ------------------------------------------------------------ repository request shapes

test("repository: enqueue is ON CONFLICT DO NOTHING; claim is a per-row conditional PATCH pinned to attempt_count", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const repo = createTdnetQueueRepository("https://x.supabase.co", "key", async (url, init) => {
    calls.push({ url, init });
    if (init?.method === "POST") return Response.json([{ id: "a" }]);
    return Response.json([{ ...rowOf(), attempt_count: 1 }]);
  });
  assert.equal(await repo.enqueue([toTdnetQueueInsert(incoming())!]), 1);
  assert.match(calls[0].url, /on_conflict=source_url/);
  assert.match((calls[0].init!.headers as Record<string, string>).Prefer, /resolution=ignore-duplicates/);
  const won = await repo.claim([rowOf({ attempt_count: 0 })], "w", T0);
  assert.equal(won.length, 1);
  const patch = calls[1];
  assert.equal(patch.init?.method, "PATCH");
  assert.match(decodeURIComponent(patch.url), /attempt_count=eq\.0/);
  assert.match(decodeURIComponent(patch.url), /or=\(state\.eq\.queued,and\(state\.eq\.failed_retryable/);
  assert.equal(JSON.parse(String(patch.init?.body)).attempt_count, 1);
  const lost = createTdnetQueueRepository("https://x.supabase.co", "key", async () => Response.json([]));
  assert.deepEqual(await lost.claim([rowOf()], "w", T0), []);
  const broken = createTdnetQueueRepository("https://x.supabase.co", "key", async () => new Response("no", { status: 500 }));
  await assert.rejects(broken.enqueue([toTdnetQueueInsert(incoming())!]), /TDNET_QUEUE_ENQUEUE_FAILED/);
});

test("flag OFF: queue code is only reachable behind IMPORTANT_NEWS_TDNET_QUEUE (no enqueue, no 6-page fetch, worker mode disabled)", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert.match(source, /function tdnetQueueEnabled\(\): boolean \{\s*return Deno\.env\.get\("IMPORTANT_NEWS_TDNET_QUEUE"\) === "enabled";\s*\}/u);
  const enqueue = source.indexOf(".enqueue(rows)");
  assert.ok(enqueue > 0 && source.indexOf(".enqueue(rows)", enqueue + 1) === -1);
  const guard = source.lastIndexOf("if (tdnetQueueEnabled()) {", enqueue);
  assert.ok(guard > 0 && enqueue - guard < 1200);
  assert.match(source, /maxPages: tdnetQueueEnabled\(\) \? 6 : undefined/u);
  const worker = source.indexOf('body.mode === "tdnet_enrich"');
  assert.match(source.slice(worker, worker + 400), /if \(!tdnetQueueEnabled\(\)\) return response\(\{ mode: body\.mode, status: "disabled" \}\)/u);
});
