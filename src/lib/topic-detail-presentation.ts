// Pure presentation helpers for the topic detail screen (no RN imports, so they are testable with Deno
// and bundled by Metro). Nothing here creates content: it only chooses colours/numbering and splits
// text that already exists in the curated catalog.

import type { TopicDetailRole } from '@/lib/topic-detail-catalog';
import type { TopicLevel } from '@/lib/home-topic';

/** Level colour system: one family, three accents (pale green / pale blue / pale lavender). */
export const TOPIC_DETAIL_LEVEL_COLORS: Record<TopicLevel, {
  /** The Hero card's tint (also the colour its art fades into). */
  hero: string;
  /** Badge / number-circle fill. */
  badge: string;
  /** Soft block tint (example card, takeaway block). */
  soft: string;
  /** Outline of the example card. */
  outline: string;
  /** Headings and accents; clears the AA text contrast on `badge`, `soft` and `hero`. */
  strong: string;
}> = {
  beginner: { hero: '#e9f5ec', badge: '#d6ecdb', soft: '#eef7f0', outline: '#c1e0c9', strong: '#246a3e' },
  intermediate: { hero: '#e6f1fb', badge: '#d3e8f9', soft: '#edf5fc', outline: '#bcd8f1', strong: '#22578f' },
  advanced: { hero: '#eeeaf9', badge: '#e1daf7', soft: '#f2effc', outline: '#cfc6f0', strong: '#4d3d9e' },
};

/**
 * The three ordinary learning steps are numbered 1-3 in reading order; the example and the takeaway are
 * special blocks without a number.
 */
export function topicDetailStepNumber(role: TopicDetailRole): number | null {
  switch (role) {
    case 'basics':
      return 1;
    case 'why':
      return 2;
    case 'market':
      return 3;
    default:
      return null;
  }
}

// Only an explicit caution lead-in counts. The text is never rewritten and never invented: this just
// lets an existing last sentence be shown as an inset band.
const CAUTION_LEAD = /^(ただし|ただ、|もっとも)/;

/**
 * Splits a section body into the main text and its final caution sentence, when (and only when) the body
 * has at least two sentences and the last one starts with a caution lead-in. Otherwise `caution` is null
 * and `lead` is the unchanged body.
 */
export function splitTrailingCaution(body: string): { lead: string; caution: string | null } {
  const sentences = body.split(/(?<=。)/u).filter((sentence) => sentence.length > 0);
  if (sentences.length < 2) return { lead: body, caution: null };
  const last = sentences[sentences.length - 1];
  if (!CAUTION_LEAD.test(last)) return { lead: body, caution: null };
  return { lead: sentences.slice(0, -1).join(''), caution: last };
}

/** Hero art: the approved topic backgrounds are 1942x809. */
export const TOPIC_DETAIL_ART_ASPECT = 1942 / 809;
