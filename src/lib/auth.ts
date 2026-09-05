import { AuthError, Session } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

export async function ensureProfile(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(`プロフィールを確認できませんでした。${error.message}`);
  if (data) return;

  const { error: insertError } = await supabase.from('profiles').insert({ id: userId });
  if (insertError?.code === '23505') return;
  if (insertError) throw new Error(`プロフィールを作成できませんでした。${insertError.message}`);
}

export async function prepareSession(session: Session) {
  await ensureProfile(session.user.id);
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
  const { error } = await supabase.auth.signOut();
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
