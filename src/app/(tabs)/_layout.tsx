import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { Colors } from '@/constants/theme';

// Bottom navigation (user decision 2026-09-29): ホーム / 銘柄 / ニュース / レポート / メニュー.
// iOS shows at most 5 native tabs (a 6th would collapse into "その他"), so トピック一覧 /
// AIに聞く / ポートフォリオ / 設定 live inside the メニュー tab (menu.tsx).
//
// This must be a route group's own _layout.tsx (not a plain component
// rendered from the root layout): expo-router/unstable-native-tabs only
// registers screens that have a matching NativeTabs.Trigger here
// (useOnlyUserDefinedScreens) -- any route outside this group's file tree
// (portfolio.tsx, topic-detail.tsx, topics.tsx, settings.tsx, ai.tsx, search.tsx) is simply invisible
// to this navigator, so router.push() to it silently does nothing. Those
// routes live as siblings of the (tabs) group instead, as plain Stack
// screens pushed on top -- see SignedInNavigator in src/app/_layout.tsx.
export default function TabsLayout() {
  const colors = Colors.light;

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      labelStyle={{ selected: { color: colors.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>ホーム</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="explore">
        <NativeTabs.Trigger.Label>銘柄</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="news">
        <NativeTabs.Trigger.Label>ニュース</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'newspaper', selected: 'newspaper.fill' }}
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="reports">
        <NativeTabs.Trigger.Label>レポート</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'chart.line.uptrend.xyaxis', selected: 'chart.line.uptrend.xyaxis' }}
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="menu">
        <NativeTabs.Trigger.Label>メニュー</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'line.3.horizontal', selected: 'line.3.horizontal' }}
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
