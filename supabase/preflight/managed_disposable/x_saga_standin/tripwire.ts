// Runtime tripwires for the X saga stand-in tests (Phase 13, D-2): while armed, any attempt to reach the network or to read a
// secret-looking environment variable is recorded and refused. TEST SUPPORT ONLY (it replaces process-wide functions for the
// duration of one call and restores them in a `finally`). They back the static exclusion check with a live one: the static check
// says no such call is written, the tripwire says none happened.
export class TripwireError extends Error {
  constructor(readonly what: string) {
    super(`tripwire: ${what}`);
    this.name = 'TripwireError';
  }
}

/** Environment names that would carry a credential. Reading one while armed is a hit (the value is never returned). */
export const SECRET_ENV_NAME = /SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|SERVICE_ROLE|X_CLIENT|VAULT|OAUTH|PRIVATE|CREDENTIAL|DATABASE_URL|SUPABASE_URL|ANON_KEY/iu;

export type Tripwires = { hits: string[]; restore(): void };

type Mutable = Record<string, unknown>;

/**
 * Replaces fetch, the Deno socket functions, WebSocket and Deno.env.get (for secret-looking names). `subprocess: true` also blocks
 * Deno.Command (for the tests that never need psql). Call `restore()` -- or use `withTripwires`.
 */
let armed = false;
export function armTripwires(options: { subprocess?: boolean } = {}): Tripwires {
  // not re-entrant: two overlapping arms would restore each other's replacements and leave the process tripwired
  if (armed) throw new Error('the tripwires are already armed');
  armed = true;
  const hits: string[] = [];
  const restorers: (() => void)[] = [];
  const replace = (holder: object, name: string, make: (original: unknown) => unknown, label: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(holder, name);
    if (!descriptor || !descriptor.configurable) throw new Error(`cannot arm the tripwire on ${label}`);
    const original = descriptor.value ?? (holder as Mutable)[name];
    Object.defineProperty(holder, name, { value: make(original), writable: true, enumerable: descriptor.enumerable ?? false, configurable: true });
    restorers.push(() => Object.defineProperty(holder, name, descriptor));
  };
  // a plain function: callable and constructible, so `new WebSocket(...)` and `new Deno.Command(...)` are recorded too
  const refuse = (what: string) => function (): never {
    hits.push(what);
    throw new TripwireError(what);
  };
  replace(globalThis, 'fetch', () => refuse('fetch'), 'fetch');
  replace(globalThis, 'WebSocket', () => refuse('WebSocket'), 'WebSocket');
  for (const name of ['connect', 'connectTls', 'listen', 'listenTls'] as const) {
    if (Object.getOwnPropertyDescriptor(Deno, name)) replace(Deno, name, () => refuse(`Deno.${name}`), `Deno.${name}`);
  }
  if (options.subprocess) replace(Deno, 'Command', () => refuse('Deno.Command'), 'Deno.Command');
  replace(Deno.env, 'get', (original) => (name: string) => {
    if (SECRET_ENV_NAME.test(name)) {
      hits.push(`Deno.env.get(${name})`);
      throw new TripwireError(`Deno.env.get(${name})`);
    }
    return (original as (n: string) => string | undefined).call(Deno.env, name);
  }, 'Deno.env.get');
  return { hits, restore: () => { while (restorers.length) restorers.pop()!(); armed = false; } };
}

/** Runs `body` with the tripwires armed; resolves with its result and the hits; always restores. */
export async function withTripwires<T>(body: () => Promise<T>, options: { subprocess?: boolean } = {}): Promise<{ result: T; hits: string[] }> {
  const wires = armTripwires(options);
  try {
    return { result: await body(), hits: [...wires.hits] };
  } finally {
    wires.restore();
  }
}
