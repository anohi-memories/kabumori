import { newsDetailRedirectPath } from '@/lib/detail-navigation';
import { recoveryRedirectPath } from '@/lib/password-recovery';

// expo-router calls this for every URL the OS hands the app, before routing. Only password
// recovery links are rewritten (to `/`, where the auth gate's recovery screen takes over); see
// recoveryRedirectPath() for why, and why everything else passes through untouched. A `news/<id>` link is
// pointed at the root-stack news detail (the nested news-tab detail route no longer exists).
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  const recovery = recoveryRedirectPath(path);
  if (recovery !== path) return recovery;
  return newsDetailRedirectPath(path) ?? path;
}
