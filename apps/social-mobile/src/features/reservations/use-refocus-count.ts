import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

/** Counts each return to this screen, not the first arrival: a tab stays mounted, so a read kept in an effect would not run again. */
export function useRefocusCount(): number {
  const [count, setCount] = useState(0);
  const arrived = useRef(false);
  useFocusEffect(useCallback(() => {
    if (arrived.current) setCount((value) => value + 1);
    arrived.current = true;
  }, []));
  return count;
}
