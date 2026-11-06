import { APPROVAL_FUNCTION } from './approval-client.ts';

/**
 * The approval + notification screens' gate. G3's API (PR #644) is a source candidate applied nowhere and its own release gate is off,
 * so the shipped app sends nothing: the screens say they are not open yet. Only a throw-away local copy turns this on.
 */
export const POSTONA_APPROVAL_UI_ENABLED = false;

/** The product entry. A local test points the same client at G3's localtest twin over loopback http instead. */
export const APPROVAL_ENDPOINT: { functionName: string; allowLoopbackHttpForTests: boolean } = { functionName: APPROVAL_FUNCTION, allowLoopbackHttpForTests: false };
