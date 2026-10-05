import { BrandContextError } from "./brand_context.ts";
import { fetchRecentKabumoriFingerprints } from "./kabumori_recent_fingerprints.ts";
import type { PublishedFingerprint } from "./cross_brand_dedupe.ts";
import { AI_LAB_EVENT_KEY_PATTERN, type AiLabTopicCandidate } from "./ai_lab_dev_diary_context.ts";

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
}

export async function loadRecentPublishedFingerprints({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<PublishedFingerprint[]> {
  const params = new URLSearchParams({
    select: "brand_id,normalized_text_sha256,published_at",
    order: "published_at.desc",
    limit: "200",
  });
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/published_content_fingerprints?${params}`,
    {
      headers: serviceHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new BrandContextError("PUBLISHED_FINGERPRINT_READ_FAILED");
  }
  const rows = await response.json() as Array<{
    brand_id?: unknown;
    normalized_text_sha256?: unknown;
    published_at?: unknown;
  }>;
  if (!Array.isArray(rows)) {
    throw new BrandContextError("PUBLISHED_FINGERPRINT_READ_FAILED");
  }
  return rows.flatMap((row) =>
    typeof row.brand_id === "string" &&
      typeof row.normalized_text_sha256 === "string" &&
      typeof row.published_at === "string"
      ? [{
        brandId: row.brand_id,
        normalizedTextSha256: row.normalized_text_sha256,
        publishedAt: row.published_at,
      }]
      : []
  );
}

export async function loadAiLabRecentDedupeFingerprints({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}): Promise<PublishedFingerprint[]> {
  const [persisted, kabumoriReports] = await Promise.all([
    loadRecentPublishedFingerprints({ supabaseUrl, serviceRoleKey, fetchImpl }),
    fetchRecentKabumoriFingerprints({
      supabaseUrl,
      serviceRoleKey,
      strict: true,
      fetchImpl,
    }),
  ]);
  return [...persisted, ...kabumoriReports];
}

/**
 * Read-only: how many AI Lab brand_post schedule rows come strictly before `scheduledFor`. Consecutive
 * posts get consecutive numbers, which is the rotation index for topic selection (no schema/RPC change,
 * no new write). Returns null on any failure so the caller can fall back instead of blocking a post.
 */
export async function countAiLabBrandPostsBefore({
  supabaseUrl,
  serviceRoleKey,
  scheduledFor,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledFor: string;
  fetchImpl?: typeof fetch;
}): Promise<number | null> {
  try {
    const params = new URLSearchParams({
      select: "id",
      brand_id: "eq.ai_salaryman_lab",
      post_type: "eq.brand_post",
      scheduled_for: `lt.${scheduledFor}`,
      limit: "1",
    });
    const response = await fetchImpl(`${supabaseUrl}/rest/v1/scheduled_posts?${params}`, {
      headers: { ...serviceHeaders(serviceRoleKey), Prefer: "count=exact" },
    });
    if (!response.ok) return null;
    const total = /\/(\d+)$/u.exec(response.headers.get("content-range") ?? "")?.[1];
    return total === undefined ? null : Number(total);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// 題材イベントの確保（claim）ライフサイクル。DB 側は migration 20261004090000_ai_lab_topic_claims.sql の
// 5関数（service_role の EXECUTE のみ）。claim_id がフェンシングトークンで、どの関数も自分の claim しか変えない。
// ---------------------------------------------------------------------------------------------------

/** 確保できた題材。topic（生成に渡す題材文）は DB に送らず、ローカルの候補から引き当てる。 */
export type AiLabClaimedTopic = {
  claimId: string;
  kind: "diary" | "evergreen";
  eventKey: string;
  unitKey: string;
  topic: string;
};

export type AiLabTopicClaimResponse = {
  claim: { claimId: string; kind: "diary" | "evergreen"; eventKey: string; unitKey: string } | null;
  rejected: Array<{ eventKey: string; reason: string }>;
  conflict: string | null;
};

/** ディスパッチャが使う題材ポート。X の前後で何を呼ぶかは ai_lab_scheduled_brand_post.ts が決める。 */
export type AiLabTopicPort = {
  /** 優先順の候補から1件を確保する。確保できなければ（全部使用済み・クールダウン中・衝突）例外。X には進まない。 */
  claim: () => Promise<AiLabClaimedTopic>;
  /** X へ送る直前に呼ぶ。true の場合だけ X へ進んでよい。 */
  startProvider: (claim: AiLabClaimedTopic) => Promise<boolean>;
  /** X 前の失敗、または X が投稿を作らなかったと証明できた失敗（PROVIDER_NO_POST:<evidence>）での解除。結果の状態を返す。 */
  release: (claim: AiLabClaimedTopic, reason: string) => Promise<string>;
  /** X の結果が不明。再開放しない。 */
  markAmbiguous: (claim: AiLabClaimedTopic, reason: string) => Promise<string>;
  /** X の post id を確認した後の確定。"PUBLISHED" / "IDEMPOTENT"。衝突は例外。 */
  settlePublished: (claim: AiLabClaimedTopic, xPostId: string) => Promise<string>;
};

const CLAIM_ERROR_CODE = /^AI_LAB_TOPIC_CLAIM_[A-Z_]+$/u;

async function callAiLabTopicRpc(
  {
    supabaseUrl,
    serviceRoleKey,
    fetchImpl,
  }: { supabaseUrl: string; serviceRoleKey: string; fetchImpl: typeof fetch },
  name: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { ...serviceHeaders(serviceRoleKey), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // DB が返した理由コード（AI_LAB_TOPIC_CLAIM_*）だけを通す。それ以外の本文はログにも例外にも出さない。
    let code = "AI_LAB_TOPIC_RPC_FAILED";
    try {
      const message = (await response.json() as { message?: unknown })?.message;
      if (typeof message === "string" && CLAIM_ERROR_CODE.test(message)) code = message;
    } catch {
      // keep the generic code
    }
    throw new BrandContextError(code);
  }
  return await response.json() as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 優先順の候補を DB に渡し、最初に確保できた1件（無ければ null）と、確保できなかった理由を受け取る。 */
export async function claimAiLabTopic({
  supabaseUrl,
  serviceRoleKey,
  scheduledPostId,
  candidates,
  leaseSeconds = 900,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledPostId: string;
  candidates: readonly AiLabTopicCandidate[];
  leaseSeconds?: number;
  fetchImpl?: typeof fetch;
}): Promise<AiLabTopicClaimResponse> {
  const payload = await callAiLabTopicRpc({ supabaseUrl, serviceRoleKey, fetchImpl }, "claim_ai_lab_topic", {
    p_scheduled_post_id: scheduledPostId,
    // 題材文（topic）は送らない。キーとテーマタグだけ。
    p_candidates: candidates.map((candidate) => ({
      kind: candidate.kind,
      event_key: candidate.eventKey,
      unit_key: candidate.unitKey,
      theme_tags: candidate.themeTags,
    })),
    p_lease_seconds: leaseSeconds,
  });
  if (!isRecord(payload) || !Array.isArray(payload.rejected)) {
    throw new BrandContextError("AI_LAB_TOPIC_CLAIM_INVALID_RESPONSE");
  }
  const rejected = payload.rejected.map((row) => {
    if (!isRecord(row) || typeof row.event_key !== "string" || typeof row.reason !== "string") {
      throw new BrandContextError("AI_LAB_TOPIC_CLAIM_INVALID_RESPONSE");
    }
    return { eventKey: row.event_key, reason: row.reason };
  });
  const conflict = typeof payload.conflict === "string" ? payload.conflict : null;
  if (payload.claim === null || payload.claim === undefined) return { claim: null, rejected, conflict };
  const claim = payload.claim;
  if (
    !isRecord(claim) || typeof claim.claim_id !== "string" || !UUID_PATTERN.test(claim.claim_id) ||
    (claim.kind !== "diary" && claim.kind !== "evergreen") ||
    typeof claim.event_key !== "string" || !AI_LAB_EVENT_KEY_PATTERN.test(claim.event_key) ||
    typeof claim.unit_key !== "string"
  ) {
    throw new BrandContextError("AI_LAB_TOPIC_CLAIM_INVALID_RESPONSE");
  }
  return {
    claim: { claimId: claim.claim_id, kind: claim.kind, eventKey: claim.event_key, unitKey: claim.unit_key },
    rejected,
    conflict,
  };
}

/**
 * 本番の題材ポート。claim() は呼ばれた時点の候補で DB に確保を依頼し、確保できた unitKey を候補の題材文へ
 * 引き当てる。確保できない・衝突・引き当て不能はすべて例外（X には進まない）。
 */
export function createAiLabTopicPort({
  supabaseUrl,
  serviceRoleKey,
  scheduledPostId,
  candidates,
  onClaimResult,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledPostId: string;
  candidates: readonly AiLabTopicCandidate[];
  onClaimResult?: (result: AiLabTopicClaimResponse) => void;
  fetchImpl?: typeof fetch;
}): AiLabTopicPort {
  const rpc = { supabaseUrl, serviceRoleKey, fetchImpl };
  const fence = (claim: AiLabClaimedTopic) => ({
    p_claim_id: claim.claimId,
    p_scheduled_post_id: scheduledPostId,
    p_event_key: claim.eventKey,
  });
  const port: AiLabTopicPort = {
    claim: async () => {
      if (candidates.length === 0) throw new BrandContextError("AI_LAB_TOPIC_POOL_EXHAUSTED");
      const result = await claimAiLabTopic({ supabaseUrl, serviceRoleKey, scheduledPostId, candidates, fetchImpl });
      onClaimResult?.(result);
      if (result.conflict) throw new BrandContextError("AI_LAB_TOPIC_SCHEDULE_CONFLICT");
      if (!result.claim) throw new BrandContextError("AI_LAB_TOPIC_POOL_EXHAUSTED");
      const claimed = result.claim;
      const candidate = candidates.find((c) => c.unitKey === claimed.unitKey && c.eventKey === claimed.eventKey);
      if (!candidate) {
        // DB が候補に無いものを返した（起こらないはず）。確保は X 前なので解除して中断する。
        await port.release({ ...claimed, topic: "" }, "PRE_X_CLAIM_MISMATCH").catch(() => "RELEASE_FAILED");
        throw new BrandContextError("AI_LAB_TOPIC_CLAIM_INVALID_RESPONSE");
      }
      return { ...claimed, topic: candidate.topic };
    },
    startProvider: async (claim) =>
      (await callAiLabTopicRpc(rpc, "start_ai_lab_topic_provider", fence(claim))) === true,
    release: async (claim, reason) =>
      String(await callAiLabTopicRpc(rpc, "release_ai_lab_topic_claim", { ...fence(claim), p_reason: reason })),
    markAmbiguous: async (claim, reason) =>
      String(await callAiLabTopicRpc(rpc, "mark_ai_lab_topic_claim_ambiguous", { ...fence(claim), p_reason: reason })),
    settlePublished: async (claim, xPostId) =>
      String(
        await callAiLabTopicRpc(rpc, "settle_ai_lab_topic_claim_published", {
          ...fence(claim),
          p_unit_key: claim.unitKey,
          p_x_post_id: xPostId,
        }),
      ),
  };
  return port;
}

export async function recordAndCompleteAiLabBrandPost({
  supabaseUrl,
  serviceRoleKey,
  scheduledPostId,
  xPostId,
  normalizedTextSha256,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  scheduledPostId: string;
  xPostId: string;
  normalizedTextSha256: string;
  fetchImpl?: typeof fetch;
}): Promise<{ fingerprintPersisted: boolean }> {
  const response = await fetchImpl(
    `${supabaseUrl}/rest/v1/rpc/complete_ai_salaryman_lab_brand_post`,
    {
      method: "POST",
      headers: {
        ...serviceHeaders(serviceRoleKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_scheduled_post_id: scheduledPostId,
        p_x_post_id: xPostId,
        p_normalized_text_sha256: normalizedTextSha256,
      }),
    },
  );
  if (!response.ok) throw new BrandContextError("AI_LAB_COMPLETION_RPC_FAILED");
  const payload = await response.json() as unknown;
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (
    typeof row !== "object" || row === null ||
    typeof (row as Record<string, unknown>).fingerprint_persisted !== "boolean"
  ) {
    throw new BrandContextError("AI_LAB_COMPLETION_RPC_INVALID_RESPONSE");
  }
  return {
    fingerprintPersisted:
      (row as { fingerprint_persisted: boolean }).fingerprint_persisted,
  };
}
