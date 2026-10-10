// How the shared AI provider reads API keys.
//
// Keys live only in server-side environment variables (Supabase Edge Function secrets). This module never reads the
// environment itself: the caller passes a reader (in an Edge Function: `(name) => Deno.env.get(name)`), so tests use
// a fake and nothing here can reach a keychain, a file or a profile. The key is wrapped in an object whose string,
// JSON and inspect forms are redacted, and only the adapters call `reveal()` to put it in a request header.

import type { AiProvider } from "./types.ts";

/** The only environment variable each provider's key is read from. */
export const PROVIDER_API_KEY_ENV: Readonly<Record<AiProvider, string>> = Object.freeze({
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
});

export type EnvReader = (name: string) => string | undefined;

const REDACTED = "[REDACTED]";

/** Any secret (an API key, the Supabase service key): string, JSON and inspect forms are redacted. */
export class SecretValue {
  readonly #value: string;
  readonly label: string;

  constructor(label: string, value: string) {
    this.label = label;
    this.#value = value;
  }

  /** The raw value, for a request header only. Never log or return it. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for("Deno.customInspect")](): string {
    return `SecretValue(${this.label}, ${REDACTED})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SecretValue(${this.label}, ${REDACTED})`;
  }
}

export class ProviderApiKey extends SecretValue {
  readonly provider: AiProvider;

  constructor(provider: AiProvider, value: string) {
    super(provider, value);
    this.provider = provider;
  }
}

/**
 * A secret from the environment reader (for example the Supabase service key for the ledger guard). The reason
 * never contains the value. Only whitespace / control characters and emptiness are checked: the format is the
 * owner's business.
 */
export function resolveSecret(envName: string, readEnv: EnvReader):
  | { readonly ok: true; readonly value: SecretValue }
  | { readonly ok: false; readonly code: "KEY_MISSING" | "KEY_INVALID"; readonly envName: string } {
  let raw: string | undefined;
  try {
    raw = readEnv(envName);
  } catch {
    return { ok: false, code: "KEY_MISSING", envName };
  }
  if (raw === undefined || raw.trim() === "") return { ok: false, code: "KEY_MISSING", envName };
  if (/\s/u.test(raw) || [...raw].some((char) => (char.codePointAt(0) ?? 0) < 0x20 || char.codePointAt(0) === 0x7f)) {
    return { ok: false, code: "KEY_INVALID", envName };
  }
  return { ok: true, value: new SecretValue(envName, raw) };
}

export type KeyResolution =
  | { readonly ok: true; readonly key: ProviderApiKey }
  | { readonly ok: false; readonly code: "KEY_MISSING" | "KEY_INVALID"; readonly envName: string; readonly reason: string };

const MIN_KEY_LENGTH = 20;

/**
 * Resolve a provider key from the environment reader. The reasons never contain the value or any part of it.
 * An Anthropic Admin API key (organization administration power) is refused: inference must use a normal key.
 */
export function resolveProviderApiKey(provider: AiProvider, readEnv: EnvReader): KeyResolution {
  const envName = PROVIDER_API_KEY_ENV[provider];
  let raw: string | undefined;
  try {
    raw = readEnv(envName);
  } catch {
    return { ok: false, code: "KEY_MISSING", envName, reason: "environment not readable" };
  }
  if (raw === undefined || raw.trim() === "") return { ok: false, code: "KEY_MISSING", envName, reason: "not set" };
  const hasControl = [...raw].some((char) => {
    const point = char.codePointAt(0) ?? 0;
    return point < 0x20 || point === 0x7f;
  });
  if (/\s/u.test(raw) || hasControl) {
    return { ok: false, code: "KEY_INVALID", envName, reason: "contains whitespace or control characters" };
  }
  if (raw.length < MIN_KEY_LENGTH) return { ok: false, code: "KEY_INVALID", envName, reason: "too short" };
  if (provider === "anthropic" && raw.startsWith("sk-ant-admin")) {
    return { ok: false, code: "KEY_INVALID", envName, reason: "an Admin API key must not be used for inference" };
  }
  return { ok: true, key: new ProviderApiKey(provider, raw) };
}
