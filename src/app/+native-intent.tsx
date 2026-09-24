import { recoveryRedirectPath } from '@/lib/password-recovery';

// expo-router calls this for every URL the OS hands the app, before routing. Only password
// recovery links are rewritten (to `/`, where the auth gate's recovery screen takes over); see
// recoveryRedirectPath() for why, and why everything else passes through untouched.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return recoveryRedirectPath(path);
}
