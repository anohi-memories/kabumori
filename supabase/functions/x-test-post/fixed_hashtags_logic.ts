// Fixed, code-side hashtags shared by every full report post type (close_report, morning_report — and
// any future report that wants the same tags). Never left to the model, or to a Voice rewrite pass, to
// generate, omit, or duplicate: appended exactly once, after every format/fact/Voice check has already
// finished, directly onto the text handed to the X API.
export const KABUMORI_REPORT_FIXED_HASHTAG_LIST = ["#日本株", "#日経平均", "#株式投資", "#かぶモリ"] as const;
export const KABUMORI_REPORT_FIXED_HASHTAGS = KABUMORI_REPORT_FIXED_HASHTAG_LIST.join(" ");

export function appendKabumoriReportFixedHashtags(text: string): string {
  return `${text.trim()}\n\n${KABUMORI_REPORT_FIXED_HASHTAGS}`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function hasKabumoriReportFixedHashtagsExactlyOnce(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.endsWith(KABUMORI_REPORT_FIXED_HASHTAGS)) return false;
  return KABUMORI_REPORT_FIXED_HASHTAG_LIST.every((tag) => countOccurrences(trimmed, tag) === 1);
}
