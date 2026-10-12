import {
  isOurCallbackReturn,
  isRegisteredCallback,
  parseConnectCallback,
  parseConnectStart,
  threadsCallbackForward,
  type ThreadsConnectStart,
  type ThreadsConnectStarter,
} from '@/domain/threads-connect';

/** Everything the flow touches outside itself, injected (production: threads-connect-runtime.ts). */
export type ThreadsConnectStarterDeps = {
  /** The registered HTTPS callback (app config); null until it is configured and its app link verified. */
  registeredCallback: string | null;
  /** The signed-in person RIGHT NOW (read at every step, never cached). */
  session(): { userId: string; token: string } | null;
  /** POST to the connect function with this bearer; ok=false carries the error body. */
  invoke(body: Record<string, unknown>, token: string): Promise<{ ok: boolean; payload: unknown }>;
  /** The system auth browser; resolves when it closes (success with the return URL, or cancel/dismiss). */
  openAuthSession(url: string, redirectUrl: string): Promise<{ type: string; url?: string }>;
  /** Closes the auth browser when the return arrived through the app link instead. */
  dismissAuthSession(): void;
  /** App-link arrivals while the flow waits; returns an unsubscribe. */
  onAppLink(listener: (url: string) => void): () => void;
  /** Resolves after ms (the flow's deadline). */
  wait(ms: number): Promise<void>;
  now(): number;
};

/**
 * One Threads connect / reconnect, end to end, for the signed-in person:
 *   start (server, the person's own bearer) -> the official authorize URL, validated -> the system auth
 *   browser -> the FIRST return to our registered HTTPS callback (browser result or app link), exactly once
 *   -> the same person still signed in and the attempt not expired -> that exact URL forwarded unchanged to
 *   the server with the person's CURRENT bearer -> the server's verified receipt.
 * The app never reads, stores or logs the code or state (it only checks the URL's shape and forwards it),
 * never opens any other URL, and never calls the result "connected" from the browser alone. Concurrent
 * taps get IN_PROGRESS; nothing is retried on its own.
 */
export function createThreadsConnectStarter(deps: ThreadsConnectStarterDeps): ThreadsConnectStarter {
  let running = false;
  return {
    async start(): Promise<ThreadsConnectStart> {
      if (running) return { kind: 'unavailable', code: 'IN_PROGRESS' };
      running = true;
      try {
        return await run(deps);
      } catch {
        return { kind: 'failed', code: 'THREADS_CONNECT_RUNTIME_UNAVAILABLE', reconcile: false };
      } finally {
        running = false;
      }
    },
  };
}

async function run(deps: ThreadsConnectStarterDeps): Promise<ThreadsConnectStart> {
  const registered = deps.registeredCallback;
  if (!isRegisteredCallback(registered)) return { kind: 'unavailable', code: 'CALLBACK_NOT_CONFIGURED' };
  const starter = deps.session();
  if (!starter) return { kind: 'failed', code: 'AUTH_REQUIRED', reconcile: false };

  const started = await deps.invoke({ action: 'start' }, starter.token);
  const start = parseConnectStart(started.payload, started.ok, registered, deps.now());
  if (start.kind === 'failed') return start;

  // The first return wins: the auth browser's own result, or the app link; anything else is ignored.
  let settle: (value: string) => void = () => {};
  const fromLink = new Promise<string>((resolve) => { settle = resolve; });
  const unsubscribe = deps.onAppLink((url) => {
    if (isOurCallbackReturn(url, registered)) settle(url);
  });
  let first: string;
  try {
    const fromBrowser = deps.openAuthSession(start.authorizationUrl, registered)
      .then((result) => (result.type === 'success' && typeof result.url === 'string' ? result.url : 'canceled'))
      .catch(() => 'canceled');
    const deadline = deps.wait(Math.max(0, start.expiresAt - deps.now())).then(() => 'timeout');
    first = await Promise.race([fromLink, fromBrowser, deadline]);
  } finally {
    unsubscribe();
  }
  if (first === 'timeout') {
    deps.dismissAuthSession();
    return { kind: 'expired' };
  }
  if (first === 'canceled') return { kind: 'canceled' };
  deps.dismissAuthSession();

  // Still the same person, still in time.
  const current = deps.session();
  if (!current || current.userId !== starter.userId) return { kind: 'failed', code: 'SESSION_CHANGED', reconcile: false };
  if (deps.now() > start.expiresAt) return { kind: 'expired' };
  const forward = threadsCallbackForward(first, registered);
  if (!forward) return { kind: 'failed', code: 'CALLBACK_INVALID', reconcile: false };
  // The person declined on Threads: nothing to complete (the unused state simply expires on the server).
  if (new URL(first).searchParams.has('error')) return { kind: 'canceled' };

  const done = await deps.invoke(forward, current.token);
  return parseConnectCallback(done.payload, done.ok);
}
