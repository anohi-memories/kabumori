import { buildConsultRequest, CONSULT_FUNCTION, consultFailure, parseConsultResponse, type ConsultOutcome, type ConsultTurn } from '../domain/consult-session.ts';

/** The slice of the Supabase client this needs; keeps the call testable without the SDK. */
export type ConsultFunctionsClient = {
  functions: {
    invoke: (name: string, options: { body: Record<string, unknown>; headers: Record<string, string> }) => Promise<{ data: unknown; error: unknown }>;
  };
};

/**
 * One request to the authenticated consultation endpoint. The AI provider is
 * only ever reached by the server; this sends the workspace selector, the
 * message and bounded session turns, and returns a validated answer or a safe
 * error. It never saves anything.
 */
export async function requestConsult(
  client: ConsultFunctionsClient,
  accessToken: string,
  input: { brandId: string; message: string; priorTurns: readonly ConsultTurn[] },
): Promise<ConsultOutcome> {
  try {
    const { data, error } = await client.functions.invoke(CONSULT_FUNCTION, {
      body: buildConsultRequest(input),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    let payload = data;
    if (error) {
      // A non-2xx answer still carries the endpoint's own error code in its body.
      const context = (error as { context?: unknown }).context;
      payload = null;
      if (context instanceof Response) {
        try {
          payload = await context.clone().json();
        } catch { /* keep the generic error */ }
      }
      if (payload === null) return { ok: false, error: consultFailure('CONSULT_REQUEST_FAILED') };
    }
    return parseConsultResponse(payload);
  } catch {
    return { ok: false, error: consultFailure('CONSULT_REQUEST_FAILED') };
  }
}
