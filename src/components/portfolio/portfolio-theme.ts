import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import type { SparkTrend, Tone } from '@/lib/portfolio-view';

const palette = KABUMORI_COLORS.light;

// The portfolio dashboard's colours: Kabumori's ivory page, white cards, a calm green for gains and a calm red
// for losses (not trading-terminal intensity), a pale-green AI card and a deep-green call to action.
export const PF = {
  page: palette.background,
  card: '#ffffff',
  cardBorder: '#e4e9e5',
  ink: palette.text,
  muted: palette.muted,
  up: '#1f7a45',
  upSoft: '#e4f3e9',
  down: '#cf433e',
  downSoft: '#fcebe9',
  flat: palette.muted,
  flatSoft: '#eef0ed',
  aiBackground: '#e9f5ec',
  aiBorder: '#d3ead9',
  cta: '#1d5e38',
  radius: 18,
  gutter: 16,
} as const;

/** The sparkline's colour for the real history's direction: calm green up, restrained red down, neutral flat. */
export function sparkColor(trend: SparkTrend): string {
  return trend === 'up' ? PF.up : trend === 'down' ? PF.down : PF.flat;
}

export function toneColor(value: Tone): string {
  return value === 'up' ? PF.up : value === 'down' ? PF.down : PF.flat;
}

export function toneSoft(value: Tone): string {
  return value === 'up' ? PF.upSoft : value === 'down' ? PF.downSoft : PF.flatSoft;
}
