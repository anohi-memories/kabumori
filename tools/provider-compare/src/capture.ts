// Production request builders (requestImportantNewsJudgement, requestGenerationStep, ...) accept an injected
// `fetchImpl`. Handing them a fetch that records the body and aborts means the prompt and schema of a real
// production call are obtained without editing production code and without any network traffic.

type Json = Record<string, unknown>;

class CaptureDone extends Error {
  constructor() {
    super("CAPTURE_DONE");
    this.name = "CaptureDone";
  }
}

export type CapturedRequest = { url: string; body: Json };

export async function captureOpenAiRequest(
  call: (fetchImpl: typeof fetch) => Promise<unknown>,
): Promise<CapturedRequest> {
  let captured: CapturedRequest | null = null;
  const done = new CaptureDone();
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (body === null || typeof body !== "object") return Promise.reject(new Error("CAPTURE_BODY_NOT_JSON"));
    captured = { url: String(input), body: body as Json };
    return Promise.reject(done);
  }) as typeof fetch;
  try {
    await call(fetchImpl);
  } catch (error) {
    if (error !== done) throw error;
  }
  if (captured === null) throw new Error("CAPTURE_NO_REQUEST");
  return captured;
}
