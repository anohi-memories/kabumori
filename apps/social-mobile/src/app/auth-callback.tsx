import { Redirect } from 'expo-router';

/**
 * Landing route for kabumori-social://auth-callback (Supabase Auth returns:
 * OAuth sign-in, e-mail confirmation, recovery, linking). AuthProvider
 * completes the callback from the delivered URL; this screen only returns
 * to the app and never parses or stores the link itself.
 */
export default function AuthCallbackScreen() {
  return <Redirect href="/" />;
}
