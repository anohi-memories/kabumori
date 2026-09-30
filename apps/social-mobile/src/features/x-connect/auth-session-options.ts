/**
 * Auth-session options for the X *posting-account* connect flow (use-x-connect.ts).
 *
 * On iOS the auth sheet is an ASWebAuthenticationSession that shares Safari's cookies, so it silently
 * reuses whichever X account was logged in last. A person with more than one X account could not choose
 * which one to connect and could authorize the wrong one. Expo's documented iOS-only
 * `preferEphemeralSession` option (AuthSessionOpenOptions in expo-web-browser 57) asks the system for a
 * private session that does not share cookies with the normal browser, so X asks the person to sign in
 * to the account they intend. It is a request the browser may decline (see the API docs), so no UI copy
 * may promise an account chooser.
 *
 * Deliberately only iOS: on Android/Web expo-web-browser ignores or does not implement the option, and
 * those platforms keep the exact call they had before (no third argument). Nothing here clears cookies
 * or browsing data, and it does not touch the OAuth URL, state, PKCE values or callback handling.
 *
 * The app-login provider flows (auth-client-flows.ts) are a separate trust step and are not changed.
 */
export type XConnectAuthSessionOptions = { preferEphemeralSession: true };

export function xConnectAuthSessionOptions(platformOS: string): XConnectAuthSessionOptions | undefined {
  return platformOS === 'ios' ? { preferEphemeralSession: true } : undefined;
}
