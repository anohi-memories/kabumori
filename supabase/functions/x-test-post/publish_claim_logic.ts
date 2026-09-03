// Closes the "check Storage receipt, then call X, then write the receipt" TOCTOU race: exactly one caller
// can ever hold the (post_type, date_jst) claim, enforced by the unique constraint on publish_claims, not
// by anything checked-then-acted-on in application code.
export const MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE = "morning_greeting";

export const PUBLISH_CLAIM_INSERT_FAILED = "PUBLISH_CLAIM_INSERT_FAILED";
export const PUBLISH_CLAIM_COMPLETE_FAILED = "PUBLISH_CLAIM_COMPLETE_FAILED";
export const PUBLISH_CLAIM_FAIL_RECORD_FAILED = "PUBLISH_CLAIM_FAIL_RECORD_FAILED";

type FetchLike = typeof fetch;

export type PublishClaimResult = {
  claimed: boolean;
};

function claimHeaders(serviceRoleKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// Atomically claims (post_type, date_jst). Never reclaims an existing row regardless of its status or
// age — a prior 'publishing', 'published', or 'failed' row for the same day all equally block a new claim,
// by design: a stuck or failed attempt is a human-review case, not something to retry automatically.
export async function claimPublishSlot(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  postType: string;
  dateJst: string;
  executionId: string;
  fetcher?: FetchLike;
}): Promise<PublishClaimResult> {
  const fetcher = args.fetcher ?? fetch;
  const response = await fetcher(
    `${args.supabaseUrl}/rest/v1/publish_claims?on_conflict=post_type,date_jst`,
    {
      method: "POST",
      headers: claimHeaders(args.serviceRoleKey, {
        Prefer: "return=representation,resolution=ignore-duplicates",
      }),
      body: JSON.stringify({
        post_type: args.postType,
        date_jst: args.dateJst,
        execution_id: args.executionId,
        status: "publishing",
      }),
    },
  );
  if (!response.ok) throw new Error(PUBLISH_CLAIM_INSERT_FAILED);
  const rows = await response.json();
  return { claimed: Array.isArray(rows) && rows.length > 0 };
}

export async function completePublishSlot(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  postType: string;
  dateJst: string;
  xPostId: string;
  fetcher?: FetchLike;
}): Promise<void> {
  const fetcher = args.fetcher ?? fetch;
  const params = new URLSearchParams({
    post_type: `eq.${args.postType}`,
    date_jst: `eq.${args.dateJst}`,
    status: "eq.publishing",
  });
  const response = await fetcher(`${args.supabaseUrl}/rest/v1/publish_claims?${params}`, {
    method: "PATCH",
    headers: claimHeaders(args.serviceRoleKey),
    body: JSON.stringify({
      status: "published",
      x_post_id: args.xPostId,
      published_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) throw new Error(PUBLISH_CLAIM_COMPLETE_FAILED);
}

export async function failPublishSlot(args: {
  supabaseUrl: string;
  serviceRoleKey: string;
  postType: string;
  dateJst: string;
  errorCode: string;
  fetcher?: FetchLike;
}): Promise<void> {
  const fetcher = args.fetcher ?? fetch;
  const params = new URLSearchParams({
    post_type: `eq.${args.postType}`,
    date_jst: `eq.${args.dateJst}`,
    status: "eq.publishing",
  });
  const response = await fetcher(`${args.supabaseUrl}/rest/v1/publish_claims?${params}`, {
    method: "PATCH",
    headers: claimHeaders(args.serviceRoleKey),
    body: JSON.stringify({ status: "failed", error_code: args.errorCode }),
  });
  if (!response.ok) throw new Error(PUBLISH_CLAIM_FAIL_RECORD_FAILED);
}
