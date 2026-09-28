import { Redirect } from 'expo-router';

/**
 * Landing route for kabumori-social://oauth-callback. The X connect flow reads
 * the callback from its own in-app browser session (useXConnect); if the OS
 * also opens this deep link, never parse or store its query here — just
 * return to the app.
 */
export default function OAuthCallbackScreen() {
  return <Redirect href="/" />;
}
