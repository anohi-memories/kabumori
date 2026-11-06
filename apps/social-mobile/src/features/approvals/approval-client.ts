// G1 TASK 44: the app's client for G3's post approval + notification API (docs/postona/g3-approval-notification-contract-20261105.md,
// PR #644): POST /functions/v1/postona-x-approvals, the person's own access token and the project's public key, `{ action, payload }`.
// G1-owned: G3's API, SQL and Edge are not copied here. An answer the app cannot trust (5xx, a network failure, a timeout, a body that is
// not the contract's) is never shown as a result: it is UNCERTAIN, and the screen reads the candidate again.

export type CandidateState = 'pending_approval' | 'approved' | 'rejected';
export type Candidate = {
  candidateId: string;
  socialAccountId: string;
  body: string;
  contentSha256: string;
  scheduledAt: string;
  state: CandidateState;
  revision: number;
  reservationId: string | null;
  decidedAt: string | null;
  createdAt: string;
};
export type ApprovalNotification = {
  notificationId: string;
  kind: string;
  candidateId: string | null;
  reservationId: string | null;
  subjectRevision: number | null;
  state: string | null;
  scheduledAt: string | null;
  createdAt: string;
  readAt: string | null;
};
/** `definite`: the server's own refusal (4xx with a code). Otherwise the outcome is unknown and must be read back. */
export type ApprovalAnswer<T> = { ok: true; value: T } | { ok: false; code: string; status: number; definite: boolean };

export const APPROVAL_FUNCTION = 'postona-x-approvals';
export const UNCERTAIN = 'UNCERTAIN';
export const AUTH_REQUIRED = 'AUTH_REQUIRED';

export type ApprovalClient = {
  submit(input: { socialAccountId: string; clientRequestId: string; body: string; scheduledAt: string }): Promise<ApprovalAnswer<Candidate>>;
  revise(input: { candidateId: string; expectedRevision: number; body: string; scheduledAt: string }): Promise<ApprovalAnswer<Candidate>>;
  approve(input: { candidateId: string; expectedRevision: number; contentSha256: string }): Promise<ApprovalAnswer<Candidate>>;
  reject(input: { candidateId: string; expectedRevision: number }): Promise<ApprovalAnswer<Candidate>>;
  get(candidateId: string): Promise<ApprovalAnswer<Candidate>>;
  list(socialAccountId: string): Promise<ApprovalAnswer<Candidate[]>>;
  notifications(limit?: number): Promise<ApprovalAnswer<ApprovalNotification[]>>;
  markRead(notificationId: string): Promise<ApprovalAnswer<ApprovalNotification>>;
};

const STATES: readonly string[] = ['pending_approval', 'approved', 'rejected'];
const str = (v: unknown) => typeof v === 'string' && v.length > 0;
const strOrNull = (v: unknown) => v === null || typeof v === 'string';
function isCandidate(v: unknown): v is Candidate {
  const c = v as Record<string, unknown> | null;
  return !!c && str(c.candidateId) && str(c.socialAccountId) && typeof c.body === 'string' && typeof c.contentSha256 === 'string' && /^[0-9a-f]{64}$/u.test(c.contentSha256)
    && str(c.scheduledAt) && STATES.includes(String(c.state)) && Number.isSafeInteger(c.revision) && strOrNull(c.reservationId) && strOrNull(c.decidedAt) && str(c.createdAt);
}
function isNotification(v: unknown): v is ApprovalNotification {
  const n = v as Record<string, unknown> | null;
  return !!n && str(n.notificationId) && str(n.kind) && strOrNull(n.candidateId) && strOrNull(n.reservationId) && str(n.createdAt) && strOrNull(n.readAt)
    && strOrNull(n.scheduledAt ?? null) && strOrNull(n.state ?? null);
}

/** Plain http only for a loopback URL with `allowLoopbackHttpForTests` (the local Supabase tests); the key must be the public one. */
export function createApprovalClient(input: {
  supabaseUrl: string;
  publishableKey: string;
  accessToken: () => Promise<string | null>;
  fetch: typeof fetch;
  functionName?: string;
  timeoutMs?: number;
  allowLoopbackHttpForTests?: boolean;
}): ApprovalClient {
  const url = new URL(`${input.supabaseUrl.replace(/\/+$/u, '')}/functions/v1/${input.functionName ?? APPROVAL_FUNCTION}`);
  const loopback = input.allowLoopbackHttpForTests === true && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) throw new Error('APPROVAL_API_URL_MUST_BE_HTTPS');
  if (!/^sb_publishable_[A-Za-z0-9_-]{8,256}$/u.test(input.publishableKey)) throw new Error('APPROVAL_API_KEY_MUST_BE_PUBLIC');
  const timeoutMs = input.timeoutMs ?? 15000;

  async function call<T>(action: string, payload: Record<string, unknown>, read: (body: Record<string, unknown>) => T | null): Promise<ApprovalAnswer<T>> {
    const token = await input.accessToken();
    if (!token) return { ok: false, code: AUTH_REQUIRED, status: 401, definite: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let status: number;
    let body: Record<string, unknown> | null = null;
    try {
      const response = await input.fetch(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, apikey: input.publishableKey },
        body: JSON.stringify({ action, payload }),
        redirect: 'error',
        signal: controller.signal,
      });
      status = response.status;
      try { body = (await response.json()) as Record<string, unknown>; } catch { body = null; }
    } catch {
      return { ok: false, code: UNCERTAIN, status: 0, definite: false };
    } finally {
      clearTimeout(timer);
    }
    if (status === 200 && body?.ok === true) {
      const value = read(body);
      return value === null ? { ok: false, code: UNCERTAIN, status, definite: false } : { ok: true, value };
    }
    const code = body && body.ok === false && typeof body.code === 'string' ? body.code : UNCERTAIN;
    return { ok: false, code, status, definite: status >= 400 && status < 500 && code !== UNCERTAIN };
  }
  const one = (body: Record<string, unknown>) => (Array.isArray(body.candidates) && body.candidates.length === 1 && isCandidate(body.candidates[0]) ? body.candidates[0] : null);
  const many = (body: Record<string, unknown>) => (Array.isArray(body.candidates) && body.candidates.every(isCandidate) ? (body.candidates as Candidate[]) : null);
  const notes = (body: Record<string, unknown>) => (Array.isArray(body.notifications) && body.notifications.every(isNotification) ? (body.notifications as ApprovalNotification[]) : null);
  const note = (body: Record<string, unknown>) => { const all = notes(body); return all && all.length === 1 ? all[0] : null; };

  return {
    submit: (p) => call('submit', p, one),
    revise: (p) => call('revise', p, one),
    approve: (p) => call('approve', p, one),
    reject: (p) => call('reject', p, one),
    get: (candidateId) => call('get', { candidateId }, one),
    list: (socialAccountId) => call('list', { socialAccountId }, many),
    notifications: (limit = 50) => call('notifications', { limit }, notes),
    markRead: (notificationId) => call('markRead', { notificationId }, note),
  };
}
