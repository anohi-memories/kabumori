import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

// Versioned so a future redesign can show onboarding again just by bumping the key, without
// needing new migration logic. AsyncStorage already ships with the app (src/lib/supabase.ts uses
// it for the session), so this adds no new dependency.
export const ONBOARDING_V1_KEY = 'kabumori:onboarding:v1';

export type OnboardingState = {
  /**
   * `null` while the stored value is still being read (fast, local, no network -- but not
   * synchronous). `true` once known complete, `false` once known incomplete.
   *
   * Deliberately fails open on any read error: `true`, not `false`. If we cannot determine
   * whether onboarding was already seen, showing the normal app is the safe failure -- it must
   * never become impossible to reach signup/login because local storage is unavailable or corrupt.
   */
  completed: boolean | null;
  /** Marks onboarding complete for this device. Safe to call multiple times. */
  complete: () => void;
};

export function useOnboardingV1(): OnboardingState {
  const [completed, setCompleted] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(ONBOARDING_V1_KEY)
      .then((value) => {
        if (active) setCompleted(value === 'true');
      })
      .catch(() => {
        if (active) setCompleted(true);
      });
    return () => {
      active = false;
    };
  }, []);

  function complete() {
    // The UI moves on immediately; the write is best-effort. A failed write only means onboarding
    // may show again on the next cold start -- mildly repetitive, never a trap.
    setCompleted(true);
    AsyncStorage.setItem(ONBOARDING_V1_KEY, 'true').catch(() => {});
  }

  return { completed, complete };
}
