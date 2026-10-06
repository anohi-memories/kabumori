import { AuthError, Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';

import { RECOVERY_PATH, resetEmailIssue } from '@/lib/password-recovery';
import { removeThisDevicePushTokenBestEffort } from '@/lib/push-notifications';
import {
  createEnrollmentGate,
  createSessionBoundTransport,
  EnrollmentCancelledError,
  reactivateServiceExplicitly,
  startServiceAutomatically,
  type EnrollmentContext,
  type EnrollmentOutcome,
} from '@/lib/service-enrollment';
import { supabase, supabasePublicConfig } from '@/lib/supabase';

// Every accepted session is enrolled in Kabumori through the common-account lifecycle RPC
// public.start_kabumori_service(): for auth.uid() only, it ensures the common account, the active
// `kabumori` entitlement and the profile row in one idempotent server transaction, and never restarts an
// ended service. It replaces the former ensure_my_profile() call, so the profile is never created outside
// the service start. Each request carries the access token of the session it was started for (never the
// shared client's later token) and is cancelled if that session goes away first.
function contextOf(session: Session): EnrollmentContext {
  return { userId: session.user.id, accessToken: session.access_token };
}

function transportFor(context: EnrollmentContext) {
  return createSessionBoundTransport({
    url: supabasePublicConfig.url,
    apiKey: supabasePublicConfig.publishableKey,
    accessToken: context.accessToken,
  });
}

const enrollmentGate = createEnrollmentGate((context, signal) =>
  startServiceAutomatically(transportFor(context), 'kabumori', signal),
);

/** Enrolls the session's person in Kabumori (shared, one request per person). Throws only on a transient failure or a cancellation. */
export function prepareSession(session: Session): Promise<EnrollmentOutcome> {
  return enrollmentGate.ensure(contextOf(session));
}

/** The person's own click: restart Kabumori at the lifecycle version the server reported. Sent once, now. */
export function reactivateKabumori(session: Session, lifecycleVersion: number): Promise<EnrollmentOutcome> {
  return enrollmentGate.explicit(contextOf(session), (context, signal) =>
    reactivateServiceExplicitly(transportFor(context), 'kabumori', lifecycleVersion, signal),
  );
}

/** Forgets the remembered outcome and cancels pending work (sign-out, another person, an explicit retry). */
export function resetServiceEnrollment() {
  enrollmentGate.reset();
}

/** Shares the provider's enrollment so a sign-in reports a transient failure; a superseded request is not an error. */
async function enrollAfterSignIn(session: Session) {
  try {
    await prepareSession(session);
  } catch (failure) {
    if (!(failure instanceof EnrollmentCancelledError)) throw failure;
  }
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('ログインセッションを開始できませんでした。');
  await enrollAfterSignIn(data.session);
  return data.session;
}

export async function signUpWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  if (data.session) await enrollAfterSignIn(data.session);
  return data;
}

export async function signOut() {
  // Best-effort, while the session (and its RLS authorization) is still
  // valid -- removing this device's own token, not other devices'.
  await removeThisDevicePushTokenBestEffort();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  resetServiceEnrollment();
}

/**
 * Sends the password reset email. The deep link it returns to is built from the app's own scheme,
 * so the same code works in development and in a release build without a hardcoded URL.
 *
 * Supabase deliberately answers the same way whether or not the address has an account, and this
 * function keeps that property: the caller shows one neutral message either way, so the screen
 * cannot be used to find out who is registered.
 */
export async function requestPasswordReset(email: string) {
  const issue = resetEmailIssue(email);
  if (issue) throw new Error(issue);
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
    redirectTo: Linking.createURL(RECOVERY_PATH),
  });
  if (error) throw error;
}

export function authErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return '認証処理に失敗しました。時間をおいてお試しください。';
  const message = error.message.toLowerCase();
  const code = error instanceof AuthError ? error.code : undefined;

  if (code === 'invalid_credentials' || message.includes('invalid login credentials')) {
    return 'メールアドレスまたはパスワードが正しくありません。';
  }
  if (code === 'email_not_confirmed' || message.includes('email not confirmed')) {
    return 'メール確認が完了していません。確認メールのリンクを開いてください。';
  }
  if (code === 'user_already_exists' || message.includes('already registered')) {
    return 'このメールアドレスはすでに登録されています。';
  }
  if (code === 'weak_password' || message.includes('password should be')) {
    return 'パスワードが短すぎるか、安全性の条件を満たしていません。';
  }
  if (code === 'validation_failed' || message.includes('invalid email')) {
    return '正しいメールアドレスを入力してください。';
  }
  if (code === 'over_request_rate_limit' || message.includes('rate limit')) {
    return '試行回数が多すぎます。しばらく待ってからお試しください。';
  }
  return error.message;
}
