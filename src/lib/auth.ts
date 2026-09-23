import { AuthError, Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';

import { RECOVERY_PATH, resetEmailIssue } from '@/lib/password-recovery';
import { removeThisDevicePushTokenBestEffort } from '@/lib/push-notifications';
import { supabase } from '@/lib/supabase';

// The profile row is created by public.ensure_my_profile(), which derives the id from auth.uid()
// inside one idempotent statement. The previous client-side select-then-insert could not be made
// atomic and defined this invariant in app code; the RPC makes it a server-side guarantee that a
// caller can only ever apply to their own account.
export async function ensureProfile() {
  const { error } = await supabase.rpc('ensure_my_profile');
  if (error) throw new Error(`プロフィールを準備できませんでした。${error.message}`);
}

export async function prepareSession(session: Session) {
  await ensureProfile();
  return session;
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.session) throw new Error('ログインセッションを開始できませんでした。');
  await prepareSession(data.session);
  return data.session;
}

export async function signUpWithEmail(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  if (data.session) await prepareSession(data.session);
  return data;
}

export async function signOut() {
  // Best-effort, while the session (and its RLS authorization) is still
  // valid -- removing this device's own token, not other devices'.
  await removeThisDevicePushTokenBestEffort();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
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
