import { generateImportantNewsPost, type GenerationCandidate, type GenerationRunner, type PostGenerationResult } from "./post_generation_logic.ts";

// P0.6: shared by both the generate_ready cron batch and the immediate post-judgement trigger. All
// double-generation protection lives in claim() being an atomic conditional update (ready_for_generation
// -> generating), mirroring the existing publish flow's claim() (-> publishing) in publish_logic.ts. Two
// concurrent dispatchGeneration calls for the same candidate can both attempt to claim, but the
// conditional WHERE guard means at most one PATCH actually matches a row — the loser sees claimed=null and
// returns { claimed: false } without ever calling the generation model.
export type GenerationDispatchRepository = {
  claim(candidateId: string): Promise<GenerationCandidate | null>;
  save(candidateId: string, result: PostGenerationResult): Promise<void>;
  saveError(candidateId: string, code: string): Promise<void>;
};

export type GenerationDispatchResult =
  | { claimed: false }
  | { claimed: true; result: PostGenerationResult }
  | { claimed: true; error: string };

export async function dispatchGeneration(
  candidateId: string,
  repository: GenerationDispatchRepository,
  runner: GenerationRunner,
): Promise<GenerationDispatchResult> {
  const claimed = await repository.claim(candidateId);
  if (!claimed) return { claimed: false };
  try {
    const generated = await generateImportantNewsPost(claimed, runner);
    await repository.save(candidateId, generated);
    return { claimed: true, result: generated };
  } catch (error) {
    const code = error instanceof Error ? error.message : "NEWS_GENERATION_DISPATCH_FAILED";
    // Best-effort: if even saveError fails, the row is left in "generating" until the caller's own
    // exception handling logs it — never silently swallowed, but also never thrown past this function,
    // since a dispatch failure must not fail the judgement (or cron batch) call that triggered it.
    try { await repository.saveError(candidateId, code); } catch { /* best-effort, logged by caller */ }
    return { claimed: true, error: code };
  }
}
