// G1 TASK 48: what the Threads card says and offers when the stored credential can no longer be used, following G4's contract
// (docs/postona/threads-connect-publish-contract-for-g1-g3-20261113.md §1.3, PR #664). Pure; G1-owned copy only.

/** Refusals whose way out is the person's own reconnect of the Threads account (G4 §1.2). */
export const RECONNECT_CODES: readonly string[] = ['CREDENTIALS_EXPIRED', 'CREDENTIALS_MISSING', 'CONNECTION_NOT_VERIFIED'];

/** "確認する" on an unknown outcome, refused 409 CREDENTIALS_EXPIRED: the requested G1 copy (G4 §1.3). */
export const UNCERTAIN_EXPIRED_COPY = 'Threadsとの接続が切れたため確認できません。同じThreadsアカウントで接続し直すと、投稿の状態を確かめてから接続を更新します。';

/** Shown above the reconnect entry while a post of this account is still open (uncertain / in progress). */
export const RECONNECT_SAME_ACCOUNT_NOTE = '結果を確認中の投稿があります。投稿の状態を確かめられるのは、同じThreadsアカウントで接続し直したときだけです。';

/**
 * A reconnect refused (H5's generic COMPLETE_OUTCOME_UNKNOWN) while this account has an open post. H5 uses the same code for other
 * causes, so this says what may be happening, never that it is (G4 §1.3: a distinct code would need an H5 runtime change).
 */
export const RECONNECT_WHILE_OPEN_COPY = '接続を更新できませんでした。結果を確認中の投稿があるため、Threadsで投稿の結果が確定するまで接続を更新できないことがあります。しばらくしてから接続し直してください。';

export const needsReconnect = (code: string | null | undefined) => typeof code === 'string' && RECONNECT_CODES.includes(code);
