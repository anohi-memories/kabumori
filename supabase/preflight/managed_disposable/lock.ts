// The plan lock: SHA-256 of every file the harness may send, pinned at review time. A file whose bytes differ is never
// sent (runner.ts). Regenerate deliberately with `deno run --allow-read --allow-write cli.ts --write-lock` and review
// the diff: a changed digest means a changed migration.
import type { Lock } from './runner.ts';

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildLock(paths: readonly string[], read: (path: string) => string): Promise<Lock> {
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) files[path] = await sha256Hex(read(path));
  return { files };
}
