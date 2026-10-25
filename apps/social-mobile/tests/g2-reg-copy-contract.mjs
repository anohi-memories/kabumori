// G2 QA helper (Issue #317, task postona-g2-existing-ui-regression-suite-consolidated-repair-20261025) -- QA only.
// The same-id copy contract M1-M4 (G2 #498 §3, checked on G1 #497 by G2 #504), judged by MEANING so that the
// g2-reg-* suites no longer pin one exact wording. Not a test file (no ".test." in the name).
import assert from 'node:assert/strict';

/** M1: a sentence that states what the server does with the same id as a FACT (old or new wording). */
const GUARANTEE = [/2回送/u, /二重[^。]*(?:送|投稿)[^。]*(?:ありません|しません|されません)/u, /サーバー[^。]*(?:送りません|ことはありません)/u, /(?:必ず|確実に)[^。]*(?:1回|一度|一回)/u];
export const guarantees = (line) => GUARANTEE.some((re) => re.test(line));
/** M2: a sentence that asks the person to look at X before sending again (the "I checked X" button note does not count). */
export const asksCheckX = (line) => !line.includes('「Xで確認しました」') && /Xで[^。]*(?:投稿済み|確認)[^。]*(?:ください|まで)/u.test(line);
/** M3: the same-id explanation sentence -- a line about the same send id that is not a button label ("...確認し直す"). */
export const isSameIdSentence = (line) => line.includes('同じ送信ID') && !/確認し直す$/u.test(line);

/**
 * Is the same-id explanation shown? Replaces the old `lines.includes(SAME_ID_LINE)` pins. It also asserts M1 on every
 * line and M2 on any screen that explains the same id, so a wording that promises again (or drops "check X") fails loudly here.
 */
export function sameIdShown(lines) {
  assert.deepEqual(lines.filter(guarantees), [], 'M1: no line states a server guarantee');
  const sentences = lines.filter(isSameIdSentence);
  // M2 on the screen: wherever the same id is explained, some sentence asks to check X first. (Per screen, not per
  // sentence: the restart re-entry adds a rule sentence -- "only a matching text can re-ask with the same id" -- beside it.)
  if (sentences.length > 0) assert.ok(lines.some(asksCheckX), `M2: the screen asks to check X before the same-id re-ask: ${sentences.join(' / ')}`);
  return sentences.length > 0;
}
