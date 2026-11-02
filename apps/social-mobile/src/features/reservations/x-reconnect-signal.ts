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

// People who restarted the X service from this app (G5 answered the explicit restart). G4 PR 617 refuses to refresh a connection made
// before a restart and no server status shows it, so this is the only evidence the app holds. Same limits as above: memory only, this
// device only. Cleared by a new connect only: G3 does not read the generation, so an accepted write says nothing about it.
const restarted = new Set<string>();

export function markXServiceRestarted(userId: string) {
  if (restarted.has(userId)) return;
  restarted.add(userId);
  changed();
}

export function clearXServiceRestarted(userId: string | null | undefined) {
  if (typeof userId === 'string' && restarted.delete(userId)) changed();
}

export function isXServiceRestarted(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && restarted.has(userId);
}

/** Re-renders the screen when the signals change; read them with isXReconnectRequired / isXServiceRestarted. */
export function useXReconnectSignal(): number {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => version);
}
