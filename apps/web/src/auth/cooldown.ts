// A wait counted on the clock, not in timer ticks (R192's per-address mail interval, the gate's
// stated waits).
//
// WHY THE CLOCK. A countdown that took one second off per `setInterval` tick was wrong exactly when
// it mattered: a background tab's timers are frozen (iOS Safari) or throttled (desktop browsers),
// so a player who switched to the mail app for two minutes came back to "You can send another in
// 59 s", one coalesced tick later, just when they had found nothing in the inbox. So a wait is a
// DEADLINE (epoch ms), and the seconds left are read from the clock at every render. The interval
// only asks for a re-render once a second, and the page coming back into view asks for one at once.

import { useCallback, useEffect, useState } from "react";

/** Unit conversion, not configuration. */
const MS_PER_SECOND = 1000;

/** Whole seconds from `now` until `deadline` (epoch ms), rounded up; 0 once it has passed or for none. */
export function secondsUntil(deadline: number | null, now: number): number {
  if (deadline === null || !Number.isFinite(deadline)) return 0;
  return Math.max(0, Math.ceil((deadline - now) / MS_PER_SECOND));
}

/** The deadline `seconds` after `from` (epoch ms). */
export function deadlineAfter(seconds: number, from: number): number {
  return from + Math.max(0, seconds) * MS_PER_SECOND;
}

/**
 * The whole seconds left until `deadline`, read from the clock at every render. While the deadline
 * lies ahead the component re-renders once a second, and at once when the page is shown again
 * (`visibilitychange`, `pageshow`, `focus`), so a wait that ran out while the tab slept is over the
 * moment the player looks.
 */
export function useSecondsUntil(deadline: number | null): number {
  const [, rerender] = useState(0);
  const left = secondsUntil(deadline, Date.now());
  const running = left > 0;

  useEffect(() => {
    if (!running || deadline === null) return;
    const refresh = (): void => {
      rerender((count) => count + 1);
    };
    const timer = window.setInterval(() => {
      refresh();
      if (Date.now() >= deadline) window.clearInterval(timer);
    }, MS_PER_SECOND);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [deadline, running]);

  return left;
}

/** An address as the auth provider compares it: trimmed, case-insensitive. */
export function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

export type AddressCooldown = {
  /** Whole seconds left before the mailer may be used again for `address`; 0 for any other. */
  secondsFor: (address: string) => number;
  /** The provider's interval for `address` runs until `deadline` (epoch ms). */
  startUntil: (address: string, deadline: number) => void;
};

/**
 * R192: the provider's per-address mail interval, for the one address last mailed. A corrected
 * address can be sent to at once. `initial` is an interval already running when the screen opens
 * (a send this browser remembered before a reload, or one another device started).
 */
export function useAddressCooldown(initial: { address: string; deadline: number } | null = null): AddressCooldown {
  const [state, setState] = useState<{ key: string; deadline: number } | null>(() =>
    initial === null ? null : { key: addressKey(initial.address), deadline: initial.deadline },
  );
  const left = useSecondsUntil(state?.deadline ?? null);

  const secondsFor = useCallback(
    (address: string): number => (state !== null && state.key === addressKey(address) ? left : 0),
    [state, left],
  );
  const startUntil = useCallback((address: string, deadline: number): void => {
    setState({ key: addressKey(address), deadline });
  }, []);

  return { secondsFor, startUntil };
}
