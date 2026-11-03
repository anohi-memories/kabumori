import {
  parseDisconnectResponse,
  validDisconnectTarget,
  type ThreadsDisconnectResult,
  type ThreadsDisconnectTarget,
  type ThreadsDisconnector,
} from '@/domain/threads-disconnect';

export type ThreadsDisconnectDeps = {
  /** The signed-in person right now (read at every call, never cached). */
  session(): { userId: string; token: string } | null;
  /** The server entry with the person's own token. */
  invoke(body: Record<string, string>, token: string): Promise<{ ok: boolean; payload: unknown }>;
};

/**
 * One disconnect per tap: the same person who confirmed must still be signed in when it is sent (the server
 * then verifies the token with Auth and the session in the database). A second tap while one runs sends
 * nothing; a lost answer is never retried (the screen re-reads the accounts instead).
 */
export function createThreadsDisconnector(deps: ThreadsDisconnectDeps): ThreadsDisconnector {
  let running = false;
  return {
    async disconnect(target: ThreadsDisconnectTarget, confirmedBy: string): Promise<ThreadsDisconnectResult> {
      if (running) return { kind: 'failed', code: 'IN_PROGRESS', uncertain: false };
      running = true;
      try {
        const session = deps.session();
        if (!session) return { kind: 'failed', code: 'AUTH_REQUIRED', uncertain: false };
        if (session.userId !== confirmedBy) return { kind: 'failed', code: 'SESSION_CHANGED', uncertain: false };
        const checked = validDisconnectTarget(target);
        if (!checked) return { kind: 'failed', code: 'REQUEST_INVALID', uncertain: false };
        let answer: { ok: boolean; payload: unknown };
        try {
          answer = await deps.invoke({ action: 'disconnect', social_account_id: checked.id, expected_handle: checked.handle }, session.token);
        } catch {
          return { kind: 'failed', code: 'STORE_UNAVAILABLE', uncertain: true };
        }
        return parseDisconnectResponse(answer.payload, answer.ok);
      } finally {
        running = false;
      }
    },
  };
}
