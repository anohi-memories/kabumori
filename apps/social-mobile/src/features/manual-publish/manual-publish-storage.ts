// The device storage behind the durable record of an unresolved attempt (see manual-publish-store.ts for what is
// stored and why). This is the ONLY file of the feature that touches AsyncStorage, and it holds no logic.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAttemptStore, type AttemptStore } from './manual-publish-store.ts';

export const attemptStore: AttemptStore = createAttemptStore({
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
});
