// Past "今日のトピック" list. There is no stored delivery history: the daily topic
// is a pure function of (level, JST date) (get_daily_kabumori_tip is
// deterministic), so "past topics" are just that same RPC evaluated for earlier
// dates. This module only produces the date sequence; fetching stays in
// daily-topic.ts. No RN imports, so it can be tested with Deno.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `count` JST dates going backwards from `today` (inclusive), skipping the first `offset`. Newest first. */
export function pastJstDates(today: string, count: number, offset = 0): string[] {
  const match = DATE.exec(today);
  if (!match || count <= 0) return [];
  const base = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(base)) return [];
  const dates: string[] = [];
  for (let index = offset; index < offset + count; index += 1) {
    dates.push(new Date(base - index * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

/** "9月29日（月）" style label for a YYYY-MM-DD date; the input string itself if malformed. */
export function formatTopicDate(date: string): string {
  const match = DATE.exec(date);
  if (!match) return date;
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${Number(match[2])}月${Number(match[3])}日（${weekday}）`;
}
