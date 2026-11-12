// G1 TASK 47 (G2 #11 P3): what a screen inside the app may ask the service gate, now, before it writes anything.
// The gate (service-enrollment-gate.tsx) decides X autopost once per login; a service ended later (another device, another tab) is
// only seen when something asks again. This asks again with the same reviewed start RPC the gate uses at sign-in, which never restarts
// an ended service. Nothing here writes; it only says whether a write may be sent.
import { createContext, useContext } from 'react';

/** 'active': the server answered just now that the service runs for this login. Anything else sends nothing. */
export type LifecycleCheck = 'active' | 'ended' | 'unknown';

export type ServiceLifecycle = {
  /** The person the gate shows now; a screen holding another person's state must not use this. */
  userId: string | null;
  /**
   * One fresh check for the gate's current person and login. 'ended' (and a definite refusal) also closes the app to the gate's own
   * screen, which offers the read-only history; 'unknown' (no answer, another person or login meanwhile) changes nothing.
   */
  confirmActive: () => Promise<LifecycleCheck>;
};

/** Outside the gate (the mock preview) nothing is confirmed, so nothing is written. */
export const NO_SERVICE_LIFECYCLE: ServiceLifecycle = { userId: null, confirmActive: async () => 'unknown' };

export const ServiceLifecycleContext = createContext<ServiceLifecycle>(NO_SERVICE_LIFECYCLE);

export function useServiceLifecycle(): ServiceLifecycle {
  return useContext(ServiceLifecycleContext);
}
