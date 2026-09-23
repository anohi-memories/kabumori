// The Settings entry map.
//
// Kept as data so the set of entries -- and the fact that none of them dead-ends -- is checked by
// tests rather than by reading a screen. `kind` is what the screen does with an entry, not how it
// looks.

import type { LegalLink } from '@/lib/legal-links';

export type SettingsEntry = {
  id: string;
  label: string;
  description: string;
  kind: 'link' | 'action' | 'destructive' | 'info';
  /** Present only for `link` entries that have a configured destination. */
  url?: string;
  /** Present only for `link` entries whose destination is not configured yet. */
  unavailableMessage?: string;
};

export function settingsEntries(
  legal: LegalLink[],
  account: { email: string | null },
): SettingsEntry[] {
  const legalEntries: SettingsEntry[] = legal.map((link) => ({
    id: link.key,
    label: link.label,
    description: link.url ? '' : '準備中',
    kind: 'link',
    ...(link.url ? { url: link.url } : { unavailableMessage: link.unavailableMessage }),
  }));

  return [
    {
      id: 'account-email',
      label: 'ログイン中のメールアドレス',
      description: account.email ?? '取得できませんでした',
      kind: 'info',
    },
    {
      id: 'password',
      label: 'パスワードを変更',
      description: '再設定用のメールを送ります',
      kind: 'action',
    },
    {
      id: 'notifications',
      label: '通知の設定',
      description: '「重要ニュース」画面から変更できます',
      kind: 'info',
    },
    ...legalEntries,
    { id: 'logout', label: 'ログアウト', description: '', kind: 'action' },
    {
      id: 'delete-account',
      label: 'アカウントを削除',
      description: '登録した銘柄・通知・レポートもすべて削除されます',
      kind: 'destructive',
    },
  ];
}
