import { useSyncExternalStore } from 'react';

// X accounts a server refused because the connection must be made again (x-write-view.ts). Memory only: after an app restart the
// next refusal says it again. Cleared by a new connect or a write the server accepted, never by a timer or by a read.
const required = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function markXReconnectRequired(accountId: string) {
  if (required.has(accountId)) return;
  required.add(accountId);
  changed();
}

export function clearXReconnectRequired(accountId: string) {
  if (required.delete(accountId)) changed();
}

export function clearAllXReconnectRequired() {
  if (!required.size) return;
  required.clear();
  changed();
}

export function isXReconnectRequired(accountId: string | null | undefined): boolean {
  return typeof accountId === 'string' && required.has(accountId);
}

/** Re-renders the screen when the set changes; read it with isXReconnectRequired. */
export function useXReconnectSignal(): number {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => version);
}
