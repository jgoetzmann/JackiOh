/**
 * The match clock (BUILD M7-T1, SPEC §9.5, R79).
 *
 * Four independent deadlines, all of them scheduled through the injected `Timers` port and none
 * of them visible to the engine — SPEC §9.3 keeps time out of `reduce`, so an expiry here only
 * reports *which* clock ran out and the actor turns that into the `timeout`, `disconnectExpired`
 * or `ceilingReached` action that the engine does see:
 *
 *  - the turn clock (R79: `turnClockSeconds`), which belongs to the active player, is reset when
 *    the turn changes, and **pauses while a prompt is open for the non-active player**;
 *  - that non-active holder's prompt clock (R79: `promptClockSeconds`), whose expiry answers only
 *    that prompt;
 *  - a disconnect grace countdown per player (§9.5: `disconnectGraceSeconds`), which does **not**
 *    pause the turn clock — §9.5: "The clock keeps running while a player is disconnected";
 *  - the hard wall-clock ceiling (R79: `matchCeilingMinutes`), measured from `startedAt`.
 *
 * Nothing in this file reads `Date.now()`: `input.timers.now()` is the only clock, which is what
 * makes the M7-T1 fake-timer tests exact rather than approximate.
 *
 * Every number comes from the injected `ServerConfig` (filled from `src/config.ts` by
 * `defaultConfig()`), so R79's values are stated once and a test can shrink them.
 */

import type { PlayerId } from "@jackioh/shared";
import type { MatchClocks, ServerConfig, Timer } from "../api/ports";
import type { ClockExpiry, ClockView, CreateMatchClock, MatchClock } from "./contracts";

// Unit conversions, not configuration: these two are the definitions of a second and a minute,
// and every lifecycle *duration* comes from `ServerConfig` (R79) rather than from here.
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

const PLAYERS: readonly PlayerId[] = ["p1", "p2"];

/** R79: the ceiling is one deadline measured from the moment the match started. */
export function matchCeilingAt(startedAt: number, config: ServerConfig): number {
  return startedAt + config.matchCeilingMinutes * MS_PER_MINUTE;
}

/**
 * The `MatchClocks` a match row carries before its actor has synced once (§9.5: the deadlines are
 * stored on the match so both clients render them). Only the ceiling is known at that point: the
 * turn clock starts when the actor's first `sync` reports who is active.
 */
export function initialClocks(startedAt: number, config: ServerConfig): MatchClocks {
  return {
    turnDeadline: null,
    promptDeadline: null,
    graceDeadline: { p1: null, p2: null },
    ceilingAt: matchCeilingAt(startedAt, config),
  };
}

type Countdown = { timer: Timer | null; deadline: number | null };

const idle = (): Countdown => ({ timer: null, deadline: null });

export const createMatchClock: CreateMatchClock = ({ timers, config, startedAt, onExpire }) => {
  const turnMs = config.turnClockSeconds * MS_PER_SECOND;
  const promptMs = config.promptClockSeconds * MS_PER_SECOND;
  const graceMs = config.disconnectGraceSeconds * MS_PER_SECOND;
  const ceilingAt = matchCeilingAt(startedAt, config);

  let stopped = false;

  // The turn clock. `remaining` is the authority while it is paused: R79's pause resumes with the
  // time the clock had left, not from full.
  let owner: PlayerId | null = null;
  let turnKey: string | null = null;
  let remaining = turnMs;
  const turn: Countdown = idle();

  // The non-active holder's prompt clock. `holder` outlives its timer on purpose: the prompt is
  // still open after the clock runs out (the actor answers it with `timeout`), and a later `sync`
  // that still reports the same holder must not re-arm a second 30 s window.
  let holder: PlayerId | null = null;
  const prompt: Countdown = idle();

  const grace: Record<PlayerId, Countdown> = { p1: idle(), p2: idle() };

  // R79: one timer for the whole match, measured from `startedAt` — so a clock rebuilt after a
  // crash inherits the ceiling the match already had rather than starting a fresh hour.
  let ceiling: Timer | null = null;

  const cancel = (countdown: Countdown): void => {
    countdown.timer?.cancel();
    countdown.timer = null;
    countdown.deadline = null;
  };

  const report = (expiry: ClockExpiry): void => {
    if (stopped) return;
    onExpire(expiry);
  };

  /** R79: pausing banks the time left; arming spends it. */
  function pauseTurn(): void {
    if (turn.timer === null) return;
    remaining = Math.max(0, (turn.deadline ?? timers.now()) - timers.now());
    cancel(turn);
  }

  function armTurn(): void {
    if (stopped || owner === null || turn.timer !== null) return;
    const player = owner;
    const ms = Math.max(0, remaining);
    turn.deadline = timers.now() + ms;
    turn.timer = timers.after(ms, () => {
      turn.timer = null;
      turn.deadline = null;
      remaining = 0;
      report({ kind: "turn", player });
    });
  }

  function armPrompt(player: PlayerId): void {
    cancel(prompt);
    holder = player;
    prompt.deadline = timers.now() + promptMs;
    prompt.timer = timers.after(promptMs, () => {
      prompt.timer = null;
      prompt.deadline = null;
      report({ kind: "prompt", player });
    });
  }

  function clearPrompt(): void {
    cancel(prompt);
    holder = null;
  }

  function stop(): void {
    stopped = true;
    cancel(turn);
    clearPrompt();
    for (const player of PLAYERS) cancel(grace[player]);
    ceiling?.cancel();
    ceiling = null;
  }

  ceiling = timers.after(Math.max(0, ceilingAt - timers.now()), () => {
    ceiling = null;
    report({ kind: "ceiling" });
  });

  const clock: MatchClock = {
    sync: (view: ClockView): void => {
      // Once a match is over it stays over: a late `sync` must never re-arm a deadline.
      if (stopped) return;
      if (view.over) {
        stop();
        return;
      }

      // R79: "The turn clock belongs to the active player". Both halves of the key matter — the
      // turn number alone would miss a replaced turn, and the active player alone would miss a
      // turn that somehow stayed with the same player.
      const key = `${String(view.turn)}:${view.active}`;
      if (key !== turnKey) {
        turnKey = key;
        owner = view.active;
        cancel(turn);
        remaining = turnMs;
      }

      const pendingFor = view.pendingFor;
      if (pendingFor === null || pendingFor === view.active) {
        // R79 gives its own clock to a prompt held by the *non-active* player. A prompt the active
        // player owes is governed by their turn clock instead (§2.5: "When the active player's
        // turn clock runs out, their open prompts are answered by the AI policy and the turn
        // ends"), so it gets no second, shorter deadline.
        clearPrompt();
      } else if (pendingFor !== holder) {
        armPrompt(pendingFor);
      }

      // R79's pause condition is the open prompt itself, not its clock: a prompt whose own clock
      // has already run out is still open, and the turn clock stays paused until it is answered.
      if (pendingFor !== null && pendingFor !== view.active) pauseTurn();
      else armTurn();
    },

    // §9.5: "Disconnect grace (60 s) and concede end the match as a loss" and "the grace countdown
    // is stored on the match so both clients show it". It runs beside the turn clock, never
    // instead of it.
    startGrace: (player: PlayerId): void => {
      if (stopped) return;
      const countdown = grace[player];
      // NOT IN SPEC: a second `startGrace` before `clearGrace` keeps the first deadline, so a
      // flapping socket cannot extend its own grace window indefinitely.
      if (countdown.timer !== null) return;
      countdown.deadline = timers.now() + graceMs;
      countdown.timer = timers.after(graceMs, () => {
        countdown.timer = null;
        countdown.deadline = null;
        report({ kind: "grace", player });
      });
    },

    clearGrace: (player: PlayerId): void => {
      cancel(grace[player]);
    },

    snapshot: (): MatchClocks => ({
      turnDeadline: turn.deadline,
      promptDeadline: prompt.deadline,
      graceDeadline: { p1: grace.p1.deadline, p2: grace.p2.deadline },
      ceilingAt,
    }),

    /**
     * The acting deadline this player is under. A prompt clock they hold outranks the turn clock,
     * and a paused turn clock still reports its banked remainder, which is the frozen number the
     * clients render while R79's pause is in effect. The grace countdowns are read from
     * `snapshot().graceDeadline`: they are not a deadline to act by, they are a deadline to come
     * back by, and both clients show them for both players.
     */
    remainingFor: (player: PlayerId): number | null => {
      if (stopped) return null;
      if (holder === player && prompt.deadline !== null) {
        return Math.max(0, prompt.deadline - timers.now());
      }
      if (owner !== player) return null;
      if (turn.deadline !== null) return Math.max(0, turn.deadline - timers.now());
      return Math.max(0, remaining);
    },

    stop,
  };

  return clock;
};
