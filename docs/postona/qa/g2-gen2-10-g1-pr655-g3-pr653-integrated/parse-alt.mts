// G2 TASK 10 alternative measurement: G1's real parseJstInput (int10 throwaway tree, unchanged file) on the inputs the kana IME made hard to type.
import { parseJstInput } from '/Users/yuya/Developer/kabumori-g2-int10/apps/social-mobile/src/features/reservations/reservation-view.ts';
const now = new Date('2026-11-12T13:50:00+09:00');
const cases: [string, string][] = [
  ['ascii ok', '2026-11-20 09:30'],
  ['full-width digits + full-width minus', '２０２６－１１－２０ ０９:３０'],
  ['full-width year only', '２０２６-11-20 09:30'],
  ['katakana long mark U+30FC', '2026ー11ー20 09:30'],
  ['em dash U+2014', '2026—11—20 09:30'],
  ['en dash U+2013', '2026–11–20 09:30'],
  ['minus sign U+2212', '2026−11−20 09:30'],
  ['full-width hyphen-minus U+FF0D', '2026－11－20 09:30'],
  ['non-breaking hyphen U+2011', '2026‑11‑20 09:30'],
  ['ideographic space U+3000', '2026-11-20　09:30'],
  ['full-width colon U+FF1A', '2026-11-20 09：30'],
  ['no space (kana IME drop)', '2026-11-2009:30'],
  ['slash', '2026/11/20 09:30'],
  ['T separator', '2026-11-20T09:30'],
  ['trailing ideographic space', '2026-11-20 09:30　'],
  ['Arabic-Indic digits', '٢٠٢٦-١١-٢٠ ٠٩:٣٠'],
  ['not a real day', '2026-02-30 09:30'],
  ['past', '2026-11-12 13:00'],
];
for (const [name, text] of cases) {
  const r = parseJstInput(text, now);
  console.log(`${r.ok ? 'ACCEPT' : 'REFUSE'}\t${name}\t${r.ok ? r.iso : r.message}`);
}
