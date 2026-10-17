import { Modal, Pressable, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import AccountDeletionScreen from '@/app/account-deletion';
import { useServiceLifecycle } from '@/features/service-lifecycle/service-lifecycle';

/**
 * The POSTONA end / common-ID management screen, rendered OUTSIDE the per-login enrollment gate (a sibling after it),
 * so re-authentication -- a new login of the same person -- keeps the flow instead of destroying it. One instance per
 * person (keyed by the person): the screen itself drops what belonged to the old login (verification, consent,
 * preview, result) and asks for a fresh preview. Another person or sign-out closes it (the provider).
 */
export function ServiceLifecycleSurface() {
  const { openFor, close } = useServiceLifecycle();
  if (openFor === null) return null;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <Pressable accessibilityRole="button" onPress={close} style={{ padding: 16, paddingBottom: 0 }}>
          <Text style={{ color: colors.primary, fontWeight: '700' }}>‹ 閉じる</Text>
        </Pressable>
        <AccountDeletionScreen key={openFor} />
      </View>
    </Modal>
  );
}
