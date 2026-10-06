// 会社員AIラボ（ai_salaryman_lab）専用: X 投稿の結果を「投稿が作られなかったと証明できるか」で型付けする。
//
// 題材イベントの確保（ai_lab_topic_claims）は、X へ送り始めた後は原則として再開放しない。例外は「X 側が投稿を
// 作らなかったことを確実に言える」場合だけで、その判定をエラー文字列の部分一致で行うと、変換されたコード
// （VaultAccountXAuth は 401 を X_ACCESS_TOKEN_UNAUTHORIZED 等へ変える）や、送信前・送信中・応答後の区別を
// 取り違える。そこで、実際の送信関数（VaultAccountXAuth.send）に渡す1回ごとの X リクエストの結果を内側で
// 観測し、次のどちらかのときだけ AiLabProviderNoPostError を投げる:
//   - X へのリクエストが1度も行われていない（送信前の資格情報・トークン更新の失敗など）
//   - 行われた X リクエストのすべてに、X が「投稿を作らない」ステータス（400/401/422/429）で応答した
// 1回でも例外（タイムアウト・通信断・応答の読み取り失敗）や、その他のステータス（403・5xx・3xx 等）があれば、
// 元のエラーをそのまま投げる（＝結果不明。確保は保持される）。
//
// VaultAccountXAuth / postToX / トークン更新の仕様そのものは変更しない。エラーの message は従来と同じ値にする
// ので、外側の失敗処理（fail_scheduled_post 等）の挙動は変わらない。

/** X が投稿を作らずに返す応答。403（重複投稿・権限）・5xx は含めない（投稿済みの可能性を否定できない）。 */
export const AI_LAB_PROVEN_NO_POST_STATUSES: ReadonlySet<number> = new Set([400, 401, 422, 429]);

export type AiLabXRequestResult = { status: number; body: unknown };

/** X が投稿を作らなかったと証明できる失敗。evidence は DB の解除理由に使う非機密コード。 */
export class AiLabProviderNoPostError extends Error {
  readonly evidence: "NOT_SENT" | "HTTP_400" | "HTTP_401" | "HTTP_422" | "HTTP_429";
  constructor(message: string, evidence: AiLabProviderNoPostError["evidence"]) {
    super(message);
    this.name = "AiLabProviderNoPostError";
    this.evidence = evidence;
  }
}

type Observation = number | "threw";

function provenNoPost(observed: readonly Observation[]): AiLabProviderNoPostError["evidence"] | null {
  if (observed.length === 0) return "NOT_SENT";
  if (!observed.every((o) => typeof o === "number" && AI_LAB_PROVEN_NO_POST_STATUSES.has(o))) return null;
  return `HTTP_${observed.at(-1)}` as AiLabProviderNoPostError["evidence"];
}

/**
 * 1件のテキスト投稿を送る。`send` は VaultAccountXAuth.send（トークン更新と1回の再送を含む）、`request` は
 * 実際の X リクエスト。成功なら X の応答 body を返す。失敗は、証明できる場合だけ AiLabProviderNoPostError、
 * それ以外は元のエラー（または従来どおりの `X_REQUEST_FAILED:<status>`）。
 */
export async function sendAiLabXPost({
  send,
  request,
  onRequestFailedStatus,
}: {
  send: (request: (accessToken: string) => Promise<AiLabXRequestResult>) => Promise<AiLabXRequestResult>;
  request: (accessToken: string) => Promise<AiLabXRequestResult>;
  onRequestFailedStatus?: (status: number) => void;
}): Promise<unknown> {
  const observed: Observation[] = [];
  let result: AiLabXRequestResult;
  try {
    result = await send(async (accessToken) => {
      let response: AiLabXRequestResult;
      try {
        response = await request(accessToken);
      } catch (error) {
        observed.push("threw");
        throw error;
      }
      observed.push(response.status);
      return response;
    });
  } catch (error) {
    const evidence = provenNoPost(observed);
    if (evidence) {
      throw new AiLabProviderNoPostError(error instanceof Error ? error.message : "X_REQUEST_FAILED", evidence);
    }
    throw error;
  }
  if (result.status >= 200 && result.status < 300) return result.body;
  onRequestFailedStatus?.(result.status);
  const message = `X_REQUEST_FAILED:${result.status}`;
  // 送信関数がリクエストを行わずに応答を返すことは無いはずなので、その場合は証明できないものとして扱う。
  const evidence = observed.length > 0 ? provenNoPost(observed) : null;
  if (evidence) throw new AiLabProviderNoPostError(message, evidence);
  throw new Error(message);
}
