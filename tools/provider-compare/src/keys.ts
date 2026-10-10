// API keys are read at run time and kept only inside the provider closure. Nothing in this module returns, logs or
// formats a key; callers get an opaque string they hand straight to a provider constructor.

export type KeyEnv = { get(name: string): string | undefined };

export type KeySource = "env" | "keychain";

export type ResolvedKey = { key: string; source: KeySource };

const ENV_NAMES = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" } as const;

export type KeyProviderName = keyof typeof ENV_NAMES;

export function envNameFor(provider: KeyProviderName): string {
  return ENV_NAMES[provider];
}

/** macOS Keychain lookup by an explicit service name. Only called when the user passes --keychain-<provider>. */
export async function readMacKeychain(service: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(service)) return null;
  const output = await new Deno.Command("security", {
    args: ["find-generic-password", "-s", service, "-w"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!output.success) return null;
  const value = new TextDecoder().decode(output.stdout).trim();
  return value.length > 0 ? value : null;
}

export async function resolveApiKey(
  provider: KeyProviderName,
  options: {
    env: KeyEnv;
    keychainService?: string;
    readKeychain?: (service: string) => Promise<string | null>;
  },
): Promise<ResolvedKey | null> {
  const fromEnv = options.env.get(ENV_NAMES[provider])?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (options.keychainService) {
    const value = await (options.readKeychain ?? readMacKeychain)(options.keychainService);
    if (value) return { key: value, source: "keychain" };
  }
  return null;
}

/** Safe to print: says whether a key exists and where it came from, never any part of its value. */
export function describeKey(resolved: ResolvedKey | null): { present: boolean; source: KeySource | null } {
  return { present: resolved !== null, source: resolved?.source ?? null };
}
