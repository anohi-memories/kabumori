import type { IncomingNewsCandidate, PreparedNewsCandidate } from "./news_candidate_logic.ts";
import {
  decideTdnetFailure,
  planTdnetClaims,
  queueRowToCandidate,
  safeQueueError,
  TDNET_SKIPPABLE_REASONS,
  TDNET_WORKER_LIMITS,
  type TdnetClaimGroup,
  type TdnetQueueRow,
} from "./tdnet_intake_logic.ts";
import type { TdnetQueueRepository } from "./tdnet_queue_repository.ts";

// TDnet T1 Stage B: drains the intake queue. Bounded (items, parallelism, wall-clock), idempotent (a row is
// claimed atomically, a stored duplicate is detected before any PDF is fetched), and crash-safe (an abandoned claim
// expires and the row is retried, never lost and never inserted twice).

export type TdnetWorkerDeps = {
  repo: TdnetQueueRepository;
  workerId: string;
  now: () => number;
  prepare: (candidate: IncomingNewsCandidate) => Promise<PreparedNewsCandidate>;
  /** Existing candidate with the same URL or content hash, if any. Checked BEFORE the PDF is fetched. */
  findDuplicate: (prepared: PreparedNewsCandidate) => Promise<{ id: string } | null>;
  /** The legacy PDF path (10MB / 40 pages / 15s limits live inside it). Throws a short error code. */
  loadPdfSummary: (sourceUrl: string) => Promise<string>;
  /** Inserts the event group through the normal candidate path; returns candidate id by source URL. */
  createCandidates: (members: PreparedNewsCandidate[]) => Promise<Map<string, string>>;
};

export type TdnetWorkerOptions = {
  maxItems?: number;
  concurrency?: number;
  budgetMs?: number;
  oldestSlots?: number;
  /** Record strictly routine notices as skipped_routine instead of creating candidates (flag, default off). */
  skipRoutine?: boolean;
};

export type TdnetWorkerResult = {
  plannedGroups: number;
  plannedItems: number;
  claimedItems: number;
  lostClaims: number;
  alreadyStored: number;
  skippedRoutine: number;
  pdfFetched: number;
  pdfFailedRetry: number;
  fallbackWithoutBody: number;
  candidatesCreated: number;
  insertFailed: number;
  skippedForBudget: number;
  swept: number;
  maxWaitMinutes: number;
  elapsedMs: number;
  errors: string[];
};

export async function runTdnetEnrichmentWorker(
  deps: TdnetWorkerDeps,
  options: TdnetWorkerOptions = {},
): Promise<TdnetWorkerResult> {
  const startedAt = deps.now();
  const concurrency = Math.min(Math.max(options.concurrency ?? TDNET_WORKER_LIMITS.defaultConcurrency, 1), TDNET_WORKER_LIMITS.maxConcurrency);
  const budgetMs = options.budgetMs ?? TDNET_WORKER_LIMITS.budgetMs;
  const result: TdnetWorkerResult = {
    plannedGroups: 0, plannedItems: 0, claimedItems: 0, lostClaims: 0, alreadyStored: 0, skippedRoutine: 0, pdfFetched: 0,
    pdfFailedRetry: 0, fallbackWithoutBody: 0, candidatesCreated: 0, insertFailed: 0, skippedForBudget: 0,
    swept: 0, maxWaitMinutes: 0, elapsedMs: 0, errors: [],
  };

  try {
    result.swept = await deps.repo.sweepExhausted(deps.now());
  } catch (error) {
    result.errors.push(`sweep:${safeQueueError(error)}`);
  }

  let plan: TdnetClaimGroup[] = [];
  try {
    const rows = await deps.repo.readClaimable(deps.now());
    plan = planTdnetClaims(rows, deps.now(), { maxItems: options.maxItems, oldestSlots: options.oldestSlots });
  } catch (error) {
    result.errors.push(`read:${safeQueueError(error)}`);
    result.elapsedMs = deps.now() - startedAt;
    return result;
  }
  result.plannedGroups = plan.length;
  result.plannedItems = plan.reduce((sum, group) => sum + group.rows.length, 0);

  let next = 0;
  async function lane(): Promise<void> {
    while (next < plan.length) {
      const group = plan[next++];
      if (deps.now() - startedAt > budgetMs) {
        result.skippedForBudget += group.rows.length;
        continue;
      }
      try {
        await processGroup(group);
      } catch (error) {
        // Whatever escaped processGroup leaves claimed rows to expire (lease) and be retried.
        result.errors.push(`group:${safeQueueError(error)}`);
      }
    }
  }

  async function processGroup(group: TdnetClaimGroup): Promise<void> {
    const claimed = await deps.repo.claim(group.rows, deps.workerId, deps.now());
    result.claimedItems += claimed.length;
    result.lostClaims += group.rows.length - claimed.length;
    const members: Array<{ row: TdnetQueueRow; candidate: IncomingNewsCandidate; fallbackError: string | null }> = [];
    for (const row of claimed) {
      if (options.skipRoutine && TDNET_SKIPPABLE_REASONS.has(row.priority_reason)) {
        result.skippedRoutine += 1;
        await deps.repo.markSkipped(row.id, row.priority_reason);
        continue;
      }
      const candidate = queueRowToCandidate(row);
      const prepared = await deps.prepare(candidate);
      const duplicate = await deps.findDuplicate(prepared);
      if (duplicate) {
        result.alreadyStored += 1;
        await deps.repo.markCandidateCreated(row.id, duplicate.id, null);
        continue;
      }
      try {
        members.push({ row, candidate: { ...candidate, bodySummary: await deps.loadPdfSummary(row.source_url) }, fallbackError: null });
        result.pdfFetched += 1;
      } catch (error) {
        const code = safeQueueError(error);
        const decision = decideTdnetFailure(row.attempt_count, code, deps.now());
        if (decision.action === "retry") {
          result.pdfFailedRetry += 1;
          await deps.repo.markRetry(row.id, decision.nextAttemptAt, code);
        } else {
          // Same outcome as the legacy path: the candidate is stored without a body (so it is never lost).
          result.fallbackWithoutBody += 1;
          members.push({ row, candidate, fallbackError: code });
        }
      }
    }
    if (members.length === 0) return;
    let ids: Map<string, string>;
    try {
      const prepared = await Promise.all(members.map((member) => deps.prepare(member.candidate)));
      ids = await deps.createCandidates(prepared);
    } catch (error) {
      const code = safeQueueError(error);
      result.insertFailed += members.length;
      result.errors.push(`insert:${code}`);
      for (const member of members) {
        if (member.row.attempt_count >= TDNET_WORKER_LIMITS.maxAttempts) {
          await deps.repo.markTerminal(member.row.id, code);
        } else {
          const decision = decideTdnetFailure(member.row.attempt_count, code, deps.now());
          await deps.repo.markRetry(member.row.id, decision.action === "retry" ? decision.nextAttemptAt : new Date(deps.now() + 5 * 60_000).toISOString(), code);
        }
      }
      return;
    }
    for (const member of members) {
      await deps.repo.markCandidateCreated(member.row.id, ids.get(member.row.source_url) ?? null, member.fallbackError);
      result.candidatesCreated += 1;
      result.maxWaitMinutes = Math.max(result.maxWaitMinutes, Math.round((deps.now() - Date.parse(member.row.published_at)) / 60000));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => lane()));
  result.elapsedMs = deps.now() - startedAt;
  return result;
}
