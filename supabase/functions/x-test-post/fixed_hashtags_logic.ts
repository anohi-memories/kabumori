// Fixed, code-side hashtags shared by every full report post type (close_report, morning_report — and
// any future report that wants the same tags). Never left to the model, or to a Voice rewrite pass, to
// generate, omit, or duplicate: appended exactly once, after every format/fact/Voice check has already
// finished, directly onto the text handed to the X API.
import {
  appendProfileReportFixedHashtags,
  KABUMORI_CODE_PROFILE,
} from "../_shared/brand/brand_profiles.ts";

export const KABUMORI_REPORT_FIXED_HASHTAG_LIST = KABUMORI_CODE_PROFILE.reportFixedHashtags;
export const KABUMORI_REPORT_FIXED_HASHTAGS = KABUMORI_REPORT_FIXED_HASHTAG_LIST.join(" ");

export function appendKabumoriReportFixedHashtags(text: string): string {
  return appendProfileReportFixedHashtags(KABUMORI_CODE_PROFILE, text);
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
