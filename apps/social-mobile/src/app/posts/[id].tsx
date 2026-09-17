import { useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { colors } from '@/constants/theme';
import { Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
export default function PostDetailScreen() { const { id } = useLocalSearchParams<{ id: string }>(); const post = mockRepository.getHistory().find((item) => item.id === id); if (!post) return <Screen><Card><Text style={{ color: colors.ink, fontWeight: '800' }}>投稿が見つかりません</Text></Card></Screen>; return <Screen><SectionTitle detail={new Date(post.scheduledAt).toLocaleString('ja-JP')}>投稿詳細</SectionTitle><Card><Pill tone={post.status === 'published' ? 'success' : post.status === 'failed' ? 'danger' : 'warning'}>{post.status}</Pill><Text selectable style={{ color: colors.ink, fontSize: 16, lineHeight: 25 }}>{post.text}</Text><Text style={styles.muted}>この画面ではまだ投稿の編集・再送は行いません。</Text></Card></Screen>; }
