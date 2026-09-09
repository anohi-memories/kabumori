import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

// SDK 57 does not present remote notifications while the app is foregrounded
// unless an explicit handler is configured. Keep this at module scope so the
// handler is installed once when the root push module is loaded, rather than
// on every render or auth-state change.
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export type PushRegistrationResult =
  | { status: 'registered'; token: string }
  | { status: 'skipped'; reason: string }
  | { status: 'denied' }
  | { status: 'error'; message: string };

// Remembers this app instance's own Expo push token (if registration ever
// succeeded) purely so signOut() can best-effort remove it. Never persisted;
// lost on app restart, which is fine since registration re-runs on next login.
let cachedToken: string | null = null;

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'default',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

async function requestPermission(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === 'granted') return true;
  if (existing.status === 'denied' && !existing.canAskAgain) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
}

function resolveProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const legacy = (Constants as unknown as { easConfig?: { projectId?: unknown } }).easConfig;
  const projectId = extra?.eas?.projectId ?? legacy?.projectId ?? null;
  return typeof projectId === 'string' && projectId.length > 0 ? projectId : null;
}

// V1: request permission, obtain an Expo push token. Never throws -- every
// failure mode (simulator, denied permission, missing EAS projectId, SDK
// error) resolves to a typed result the caller can log/ignore, since push
// registration must never block or crash the rest of the app.
export async function registerForPushNotificationsAsync(): Promise<PushRegistrationResult> {
  if (Platform.OS === 'web') {
    return { status: 'skipped', reason: 'Web版はExpo Push通知の対象外です。' };
  }
  if (!Device.isDevice) {
    return { status: 'skipped', reason: 'シミュレータ/エミュレータではPush Tokenを取得できません。' };
  }

  try {
    const granted = await requestPermission();
    if (!granted) return { status: 'denied' };

    // Expo's SDK 57 docs require the Android channel to exist before asking
    // the native push service for a token. This is a no-op on iOS.
    await ensureAndroidChannel();

    const projectId = resolveProjectId();
    if (!projectId) {
      return {
        status: 'skipped',
        reason: 'EAS projectIdが未設定のため、Expo Push Tokenを取得できません（app.jsonのextra.eas.projectIdが必要です）。',
      };
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) {
      return { status: 'error', message: 'Expo Push Tokenを取得できませんでした。' };
    }
    cachedToken = token;
    return { status: 'registered', token };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Push Tokenの取得に失敗しました。',
    };
  }
}

// device_push_tokens.expo_push_token is the unique key (not per-user), so a
// device that switches accounts correctly reassigns to the new user_id
// rather than creating a duplicate row.
export async function upsertDevicePushToken(userId: string, token: string): Promise<void> {
  const deviceLabel = [Device.brand, Device.modelName].filter(Boolean).join(' ') || null;
  const { error } = await supabase.from('device_push_tokens').upsert(
    {
      user_id: userId,
      expo_push_token: token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      device_id: deviceLabel,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'expo_push_token' },
  );
  if (error) throw new Error(`Push Tokenを保存できませんでした。${error.message}`);
  cachedToken = token;
}

// Best-effort cleanup for this device's own token, called from signOut()
// while the session (and therefore the owning RLS policy) is still valid.
// A failure here must never block sign-out itself.
export async function removeThisDevicePushTokenBestEffort(): Promise<void> {
  if (!cachedToken) return;
  const token = cachedToken;
  cachedToken = null;
  try {
    await supabase.from('device_push_tokens').delete().eq('expo_push_token', token);
  } catch {
    // Sign-out must proceed regardless; a stale token row is harmless (the
    // send side treats DeviceNotRegistered as a permanent, non-retried failure).
  }
}
