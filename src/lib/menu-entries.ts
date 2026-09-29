// Entries of the メニュー tab. Kept as data (like settings-menu.ts) so the set of
// destinations -- and that each one is a real route -- is checked by tests.
// Each href is a root Stack screen (see SignedInNavigator in src/app/_layout.tsx),
// pushed on top of the tabs so back returns to the メニュー tab.

export type MenuEntry = {
  id: 'topics' | 'ai' | 'portfolio' | 'settings';
  label: string;
  description: string;
  href: '/topics' | '/ai' | '/portfolio' | '/settings';
};

export const MENU_ENTRIES: readonly MenuEntry[] = [
  { id: 'topics', label: '今日のトピック', description: '過去に配信されたトピックを一覧で読み返す', href: '/topics' },
  { id: 'ai', label: 'AIに聞く', description: '気になるニュースや銘柄について質問する（準備中）', href: '/ai' },
  { id: 'portfolio', label: 'ポートフォリオ', description: '保有・監視銘柄の一覧と損益を見る', href: '/portfolio' },
  { id: 'settings', label: '設定', description: 'アカウント・通知・投資知識レベル・規約', href: '/settings' },
];
