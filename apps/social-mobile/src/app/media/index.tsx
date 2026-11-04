import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { ActionButton, Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import type { MediaAsset } from '@/features/media-box/media-box-client';
import { failureText, isRetryable, MEDIA_BLOCK_TEXT, sizeLabel } from '@/features/media-box/media-box-view';
import { useMediaBox } from '@/features/media-box/use-media-box';

type Source = { uri: string; headers: Record<string, string> };

/** The person's own video, played from the authenticated read (the player sends the same headers). */
function MediaVideo({ source }: { source: Source }) {
  const player = useVideoPlayer({ uri: source.uri, headers: source.headers });
  return <VideoView player={player} accessibilityLabel="素材の動画" style={{ width: '100%', height: 220, borderRadius: 12, backgroundColor: colors.ink }} nativeControls contentFit="contain" />;
}

function formatJst(iso: string): string {
  const date = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

export default function MediaScreen() {
  const box = useMediaBox();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (box.kind === 'blocked') {
    return <Screen><ScrollView contentContainerStyle={{ gap: 16 }}><SectionTitle detail="画像・動画を保存して管理">素材BOX</SectionTitle><Card><Text style={styles.muted}>{MEDIA_BLOCK_TEXT[box.block]}</Text></Card></ScrollView></Screen>;
  }

  const items = box.list.state === 'ready' ? box.list.items : [];
  const shownAsset: MediaAsset | null = items.find((item) => item.id === selected) ?? null;
  const deleting = (asset: MediaAsset) => box.removals.some((item) => item.asset.id === asset.id && item.state === 'deleting');
  const tile = (asset: MediaAsset) => {
    const source = asset.kind === 'image' ? box.sourceOf(asset) : null;
    return (
      <Pressable key={asset.id} accessibilityRole="button" accessibilityLabel={`素材 ${asset.display_name}`} onPress={() => { setSelected(selected === asset.id ? null : asset.id); setConfirmDelete(null); }} style={{ width: '47%' }}>
        <Card style={{ minHeight: 120, gap: 6 }}>
          {source ? <Image accessibilityLabel={`${asset.display_name} のプレビュー`} source={source} style={{ height: 96, borderRadius: 10, backgroundColor: colors.primarySoft }} resizeMode="cover" />
            : <View style={{ backgroundColor: colors.primarySoft, borderRadius: 10, height: 96, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.primary, fontSize: 22 }}>▶</Text></View>}
          <Text style={{ color: colors.ink, fontWeight: '700' }} numberOfLines={1}>{asset.display_name}</Text>
          <Text style={styles.muted}>{`${asset.kind === 'image' ? '画像' : '動画'}・${sizeLabel(asset.bytes)}`}</Text>
        </Card>
      </Pressable>
    );
  };
  const viewerSource = shownAsset ? box.sourceOf(shownAsset) : null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="画像・動画を保存して管理（ご自身だけが見られます）">素材BOX</SectionTitle>
        {box.notice ? <Pill tone={box.notice.tone}>{box.notice.text}</Pill> : null}
        <ActionButton label={box.picking ? '素材を選んでいます…' : '素材を追加'} disabled={box.picking} onPress={box.add} />
        <Text style={styles.muted}>画像（JPEG・PNG・WebP・HEIC、20MBまで）と動画（MP4・MOV、50MBまで）を保存できます。上限は200件・合計2GBです。</Text>

        {box.adds.map((add) => (
          <Card key={add.requestId}>
            <Text style={{ color: colors.ink, fontWeight: '700' }}>{`${add.name}（${sizeLabel(add.size)}）`}</Text>
            {add.state === 'sending' ? <Text style={styles.muted}>保存しています…（サーバーで確認できるまで、素材BOXには入りません）</Text> : null}
            {add.state === 'failed' && add.failure ? <Text style={styles.muted}>{failureText(add.failure)}</Text> : null}
            {add.state === 'failed' && add.failure && isRetryable(add.failure) ? <ActionButton label="もう一度送る" onPress={() => box.retryAdd(add.requestId)} /> : null}
            {add.state === 'failed' ? <ActionButton label="この素材の保存をやめる" onPress={() => box.discardAdd(add.requestId)} /> : null}
          </Card>
        ))}

        {box.removals.filter((item) => item.state !== 'deleting').map((item) => (
          <Card key={item.asset.id}>
            <Text style={{ color: colors.ink, fontWeight: '700' }}>{item.asset.display_name}</Text>
            <Text style={styles.muted}>{item.state === 'awaiting_purge' ? '削除済み・保存領域の解放待ち（解放されるまで上限に数えられます）' : `削除を完了できませんでした。${item.failure ? failureText(item.failure) : ''}`}</Text>
            <ActionButton label={item.state === 'awaiting_purge' ? '解放を確認する' : '削除をやり直す'} onPress={() => box.remove(item.asset)} />
          </Card>
        ))}

        {shownAsset ? (
          <Card>
            {shownAsset.kind === 'image' && viewerSource ? <Image accessibilityLabel={`${shownAsset.display_name} の画像`} source={viewerSource} style={{ width: '100%', height: 260, borderRadius: 12, backgroundColor: colors.primarySoft }} resizeMode="contain" /> : null}
            {shownAsset.kind === 'video' && viewerSource ? <MediaVideo key={shownAsset.id} source={viewerSource} /> : null}
            <Text style={{ color: colors.ink, fontWeight: '700' }}>{shownAsset.display_name}</Text>
            <Text style={styles.muted}>{`${shownAsset.kind === 'image' ? '画像' : '動画'}・${sizeLabel(shownAsset.bytes)}・${formatJst(shownAsset.created_at)} に保存`}</Text>
            <ActionButton label={confirmDelete === shownAsset.id ? '本当に削除する' : 'この素材を削除する'} disabled={deleting(shownAsset)} onPress={() => {
              if (confirmDelete !== shownAsset.id) { setConfirmDelete(shownAsset.id); return; }
              setConfirmDelete(null);
              box.remove(shownAsset);
            }} />
            {confirmDelete === shownAsset.id ? <Text style={styles.muted}>削除すると元に戻せません。もう一度押すと削除します。</Text> : null}
            <ActionButton label="閉じる" onPress={() => { setSelected(null); setConfirmDelete(null); }} />
          </Card>
        ) : null}

        {box.list.state === 'loading' ? <Card><Text style={styles.muted}>素材を読み込んでいます…</Text></Card> : null}
        {box.list.state === 'error' ? (
          <Card>
            <Text style={styles.muted}>{`素材を読み込めませんでした。${failureText(box.list.failure)}`}</Text>
            <ActionButton label="もう一度読み込む" onPress={box.reload} />
          </Card>
        ) : null}
        {box.list.state === 'ready' && !items.length ? <EmptyState title="素材はまだありません" detail="「素材を追加」から画像や動画を保存できます。" /> : null}
        {items.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{items.map(tile)}</View> : null}
        {box.list.state === 'ready' && box.list.next ? <ActionButton label={box.list.loadingMore ? '読み込んでいます…' : 'さらに読み込む'} disabled={box.list.loadingMore} onPress={box.more} /> : null}
        {box.list.state === 'ready' ? <ActionButton label="最新の状態を読み込む" onPress={box.reload} /> : null}
      </ScrollView>
    </Screen>
  );
}
