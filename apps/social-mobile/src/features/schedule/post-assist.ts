// G1 TASK 26: the AI post assist (draft / refine / hashtags) in the schedule composer. Pure: the composer keeps the state;
// this decides whether anything may be sent, builds each request once, and turns the answers into text the person can
// edit and then adopt. Nothing here schedules or posts: an adopted candidate only becomes the text of a local preview row.
import {
  newPostAssistKey,
  requestPostAssist,
  type PostAssistFunctionsClient,
  type PostAssistInput,
  type PostAssistPlatform,
  type PostAssistUiState,
} from '../../data/post-assist-client.ts';

export type { PostAssistUiState };

export type AssistMode = 'draft' | 'refine' | 'hashtags';

export const ASSIST_MODES: { mode: AssistMode; label: string; detail: string }[] = [
  { mode: 'draft', label: 'AIで下書き', detail: 'メモから投稿文の案を作ります。' },
  { mode: 'refine', label: '書き直し', detail: 'この本文を、指示に沿って書き直した案を作ります。' },
  { mode: 'hashtags', label: 'ハッシュタグ案', detail: 'この本文は変えずに、ハッシュタグの案だけを作ります。' },
];

/** The endpoint's input limits (G6 POST_ASSIST_LIMITS, PR #566): checked here so a request that would be refused is not sent. */
export const ASSIST_LIMITS = { notes: 2000, draft: 1000, instruction: 300 } as const;

/** Everything a request depends on, read fresh from the screen on every render. */
export type AssistEnv = {
  client: PostAssistFunctionsClient | null;
  accessToken: string | null;
  userId: string | null;
  /** The brand the composer plans for (the selected account's brand). */
  brandId: string | null;
  /** The signed-in person's own personal workspace (snapshot.personalWorkspaceId); null when it is not known for sure. */
  workspaceId: string | null;
  platform: PostAssistPlatform;
  /** Sample data: there is no backend to ask. */
  preview: boolean;
  /** This very access token was answered 401: nothing is sent until the person has signed in again (a new token). */
  loginRefused: boolean;
};

export type AssistBlock = 'preview' | 'signed_out' | 'relogin' | 'no_workspace' | 'other_workspace';

export const ASSIST_BLOCK_TEXT: Record<AssistBlock, string> = {
  preview: 'サンプル表示では、AI投稿アシストは使えません。本文は手で書いて続けられます。',
  signed_out: 'ログインが確認できないため、AI投稿アシストは使えません。ログインし直してください。',
  relogin: 'ログインの有効期限が切れたため、ログインし直すまでAIには依頼できません（設定画面からログアウトして、もう一度ログインしてください）。本文はこのまま手で書いて続けられます。',
  no_workspace: 'ご自身の個人ワークスペースを確認できないため、AI投稿アシストは使えません。本文は手で書いて続けられます。',
  other_workspace: 'このアカウントのワークスペースでは、AI投稿アシストは使えません（ご自身のワークスペースだけで使えます）。',
};

/** Why nothing may be sent right now; null when a request may be made. Fail-closed: anything unknown blocks. */
export function assistBlock(env: AssistEnv): AssistBlock | null {
  if (env.preview || !env.client) return 'preview';
  if (!env.accessToken || !env.userId) return 'signed_out';
  if (env.loginRefused) return 'relogin';
  if (!env.brandId || !env.workspaceId) return 'no_workspace';
  // The person's own workspace only: a brand they merely see (another account's workspace) is never sent.
  if (env.brandId !== env.workspaceId) return 'other_workspace';
  return null;
}

/** Who and where a request is for. An answer is used only while this is still the same. */
export function assistScope(env: AssistEnv): string | null {
  return assistBlock(env) === null ? `${env.userId}\n${env.brandId}` : null;
}

export type AssistFields = { notes: string; instruction: string };

/** What the person still has to fix before the mode can be asked; null when the request may be sent. */
export function assistInputIssue(mode: AssistMode, rowText: string, fields: AssistFields): string | null {
  const check = (value: string, max: number, empty: string, long: string) => (!value.trim() ? empty : [...value].length > max ? long : null);
  if (mode === 'draft') return check(fields.notes, ASSIST_LIMITS.notes, 'AIへのメモを入力してください。', `メモは${ASSIST_LIMITS.notes}文字以内にしてください。`);
  const draft = check(rowText, ASSIST_LIMITS.draft, '先に本文を入力してください。', `本文は${ASSIST_LIMITS.draft}文字以内にしてください。`);
  if (draft || mode === 'hashtags') return draft;
  return check(fields.instruction, ASSIST_LIMITS.instruction, '書き直しの指示を入力してください。', `指示は${ASSIST_LIMITS.instruction}文字以内にしてください。`);
}

/** One press of a button: its own Idempotency-Key and the exact body. A same-key retry sends this same object again. */
export type AssistRequest = Readonly<{ key: string; scope: string; rowId: string; mode: AssistMode; input: PostAssistInput }>;

/** A new request for one press, or null when nothing may be sent (blocked, or the input is not ready). */
export function newAssistRequest(env: AssistEnv, uuid: () => string, rowId: string, mode: AssistMode, rowText: string, fields: AssistFields): AssistRequest | null {
  const scope = assistScope(env);
  if (scope === null || env.brandId === null || assistInputIssue(mode, rowText, fields) !== null) return null;
  const base = { brandId: env.brandId, platform: env.platform };
  const input: PostAssistInput = mode === 'draft'
    ? { ...base, mode, notes: fields.notes }
    : mode === 'refine'
      ? { ...base, mode, draft: rowText, instruction: fields.instruction }
      : { ...base, mode, draft: rowText };
  return Object.freeze({ key: newPostAssistKey(uuid), scope, rowId, mode, input: Object.freeze(input) });
}

/** Sends a request with the person's own token, or nothing (null) when the session or workspace is no longer the one it was made for. */
export function sendAssist(env: AssistEnv, request: AssistRequest): Promise<PostAssistUiState> | null {
  if (assistScope(env) !== request.scope || !env.client || !env.accessToken) return null;
  return requestPostAssist(env.client, env.accessToken, request.key, request.input);
}

export type AssistOutcomeView = { text: string; tone: 'warning' | 'danger'; retry: 'same_key' | 'new_key' | null };

/** What the screen says for an answer that has no candidates; null for candidates. */
export function assistOutcomeView(state: PostAssistUiState): AssistOutcomeView | null {
  switch (state.kind) {
    case 'candidates':
      return null;
    case 'relogin':
      return { text: 'ログインの有効期限が切れました。ログインし直してから、もう一度お試しください。', tone: 'danger', retry: null };
    case 'not_available':
      return { text: 'いまはAI投稿アシストを使えません（ログインの状態やご契約をご確認ください）。本文は手で書いて続けられます。', tone: 'warning', retry: 'new_key' };
    case 'retry_same_key':
      return { text: '混み合っています。少し待ってから「再試行」を押してください（同じ依頼をもう一度送ります）。', tone: 'warning', retry: 'same_key' };
    case 'new_key_needed':
      return { text: 'AIの結果を受け取れませんでした。「もう一度依頼」で新しく依頼できます。', tone: 'warning', retry: 'new_key' };
    case 'quota':
      return { text: 'AI投稿アシストの利用上限に達しました。時間をおいてからお試しください。', tone: 'warning', retry: null };
    case 'invalid_input':
      return { text: '依頼の内容を受け付けられませんでした。メモや本文を見直してください。', tone: 'danger', retry: null };
    case 'unavailable':
      return { text: 'いまはAIを使えません。本文は手で書いて続けられます。', tone: 'warning', retry: 'new_key' };
  }
}

/** The text with the hashtags it does not have yet appended (case-insensitive), on their own line. */
export function withHashtags(text: string, hashtags: readonly string[]): string {
  const present = new Set((text.match(/#[^\s#]+/gu) ?? []).map((tag) => tag.toLowerCase()));
  const added: string[] = [];
  for (const tag of hashtags) {
    if (present.has(tag.toLowerCase())) continue;
    present.add(tag.toLowerCase());
    added.push(tag);
  }
  if (added.length === 0) return text;
  const body = text.trimEnd();
  return body ? `${body}\n\n${added.join(' ')}` : added.join(' ');
}
