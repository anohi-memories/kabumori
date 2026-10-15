// 「AIに聞く」の開発用モック (offline, no network, no model). Reachable ONLY under __DEV__: the screen loads this
// file through `if (__DEV__) require(...)`, so a production bundle neither includes nor can call it.
//
// Everything it returns is a fixed SAMPLE written for layout / state testing: no figures, no real company facts, no
// "today's" prices or reasons. It exists so the answered / refused / failed / retry / unknown-time states can be
// seen and tested before the server (Phase B) exists. It is not a preview of what the AI will say.

import type { AskExample, AskFailureCode, AskRequest, AskResponse } from './ai-ask';

export const MOCK_BANNER_JA = '【開発用サンプル】';

/**
 * Extra example chips shown ONLY in a development build (the screen reads them from this module): each one fills the
 * input with a trigger of the mock below, so the failure / retry / refusal states can be driven by taps alone
 * (a Simulator's Japanese keyboard cannot type the ASCII triggers).
 */
export const MOCK_EXAMPLES: readonly AskExample[] = [
  { id: 'dev-error', scope: 'market', question: '【開発】通信エラーの表示を確認 [error]' },
  { id: 'dev-timeout', scope: 'market', question: '【開発】時間切れの表示を確認 [timeout]' },
  { id: 'dev-advice', scope: 'market', question: '【開発】売買の依頼を断る表示を確認 [advice]' },
];

// Fixed sample timestamp (a fixture, not "now"), so a known time can be shown next to an unknown one.
const SAMPLE_AS_OF = '2026-01-05T06:30:00.000Z';

// The bracketed ASCII forms exist so the states can be driven from a keyboard that cannot type Japanese.
const ADVICE = /買うべき|売るべき|買い時|売り時|おすすめ|オススメ|儲かる|必ず上がる|絶対|\[advice\]/i;
const FORCE_ERROR = /エラーテスト|\[error\]/i;
const FORCE_SLOW = /タイムアウトテスト|\[timeout\]/i;

/** Request ids that already failed once, so a retry of the same request succeeds (the retry path is visible). */
const failedOnce = new Set<string>();

export function resetMockAsk(): void {
  failedOnce.clear();
}

/** Synchronous core: the whole behaviour, so tests need no timers. */
export function mockAskNow(request: AskRequest): AskResponse {
  if (ADVICE.test(request.question)) return { status: 'refused', reason: 'investment_advice' };

  if (FORCE_ERROR.test(request.question) && !failedOnce.has(request.clientRequestId)) {
    failedOnce.add(request.clientRequestId);
    return { status: 'failed', code: 'network' as AskFailureCode };
  }
  if (FORCE_SLOW.test(request.question) && !failedOnce.has(request.clientRequestId)) {
    failedOnce.add(request.clientRequestId);
    return { status: 'failed', code: 'timeout' as AskFailureCode };
  }

  if (request.scope === 'holdings') {
    return {
      status: 'answered',
      answer: `${MOCK_BANNER_JA} 保有銘柄についての質問への、表示確認用の回答です。実際の内容ではありません。`,
      keyPoints: ['保有銘柄に関係する出来事を整理して表示します', '根拠にしたニュースやデータの時点を一緒に示します'],
      sources: [
        { kind: 'holding', title: '登録している保有銘柄（サンプル）', asOf: SAMPLE_AS_OF, ref: null },
        { kind: 'news', title: 'サンプルのニュース見出し（時刻が分からない例）', asOf: null, ref: null },
      ],
      generatedAt: SAMPLE_AS_OF,
      dataAsOf: null,
      usedHoldings: true,
    };
  }
  if (request.scope === 'stock') {
    return {
      status: 'answered',
      answer: `${MOCK_BANNER_JA} 銘柄コード ${request.tickerCode ?? '—'} についての質問への、表示確認用の回答です。`,
      keyPoints: [],
      sources: [{ kind: 'market_data', title: 'サンプルの市場データ', asOf: SAMPLE_AS_OF, ref: null }],
      generatedAt: SAMPLE_AS_OF,
      dataAsOf: SAMPLE_AS_OF,
      usedHoldings: false,
    };
  }
  return {
    status: 'answered',
    answer: `${MOCK_BANNER_JA} 市況についての質問への、表示確認用の回答です。実際の相場の内容ではありません。`,
    keyPoints: ['出典と取得時点が回答と一緒に表示されます'],
    sources: [
      { kind: 'report', title: 'サンプルの大引けレポート', asOf: SAMPLE_AS_OF, ref: null },
      { kind: 'news', title: 'サンプルのニュース見出し', asOf: SAMPLE_AS_OF, ref: null },
    ],
    generatedAt: SAMPLE_AS_OF,
    dataAsOf: SAMPLE_AS_OF,
    usedHoldings: false,
  };
}

/** The same behaviour after a short, fake "thinking" delay (so the sending state is visible in development). */
export function mockAsk(request: AskRequest, delayMs = 900): Promise<AskResponse> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(mockAskNow(request)), delayMs);
  });
}
