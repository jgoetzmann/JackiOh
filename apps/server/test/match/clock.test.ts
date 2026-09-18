/**
 * BUILD M7-T1's fake-timer tests for the match clock (SPEC §9.5, R79).
 *
 * One test per clock path, all of them on `createManualTimers()`: the clock schedules every
 * deadline through the `Timers` port, so `timers.advance(ms)` fires exactly the callbacks that
 * are due and the assertions are on the millisecond rather than on a tolerance.
 *
 * Every duration is derived from the injected config, so these tests state R79's numbers nowhere:
 * they check the behaviour around whatever `src/config.ts` says.
 */

import { describe, expect, it } from "vitest";
import { createManualTimers, testConfig } from "../fakes/deps";
import { createMatchClock, initialClocks, matchCeilingAt } from "../../src/match/clock";
import type { ClockExpiry, ClockView } from "../../src/match/contracts";
import type { ServerConfig } from "../../src/api/ports";

/** Unit conversion only: R79's durations come from the config below. */
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function harness(
  options: { config?: Partial<ServerConfig>; startedOffsetMs?: number } = {},
): {
  timers: ReturnType<typeof createManualTimers>;
  config: ServerConfig;
  expiries: ClockExpiry[];
  startedAt: number;
  clock: ReturnType<typeof createMatchClock>;
  turnMs: number;
  promptMs: number;
  graceMs: number;
  ceilingMs: number;
} {
  const timers = createManualTimers();
  const config = testConfig(options.config ?? {});
  const expiries: ClockExpiry[] = [];
  const startedAt = timers.now() - (options.startedOffsetMs ?? 0);
  const clock = createMatchClock({
    timers,
    config,
    startedAt,
    onExpire: (expiry) => expiries.push(expiry),
  });
  return {
    timers,
    config,
    expiries,
    startedAt,
    clock,
    turnMs: config.turnClockSeconds * SECOND,
    promptMs: config.promptClockSeconds * SECOND,
    graceMs: config.disconnectGraceSeconds * SECOND,
    ceilingMs: config.matchCeilingMinutes * MINUTE,
  };
}

const view = (overrides: Partial<ClockView> = {}): ClockView => ({
  turn: 1,
  active: "p1",
  pendingFor: null,
  over: false,
  ...overrides,
});

describe("match clock", () => {
  it("expires the turn clock after turnClockSeconds and names the active player (R79)", () => {
    const { timers, clock, expiries, turnMs } = harness();
    clock.sync(view());

    timers.advance(turnMs - 1);
    expect(expiries).toEqual([]);

    timers.advance(1);
    expect(expiries).toEqual([{ kind: "turn", player: "p1" }]);
  });

  it("resets the turn clock when the turn changes", () => {
    const { timers, clock, expiries, turnMs } = harness();
    clock.sync(view());
    timers.advance(turnMs - SECOND);
    expect(expiries).toEqual([]);

    // R79: "The turn clock belongs to the active player" — the new turn starts from full.
    clock.sync(view({ turn: 2, active: "p2" }));
    expect(clock.remainingFor("p2")).toBe(turnMs);
    expect(clock.remainingFor("p1")).toBeNull();

    timers.advance(turnMs - 1);
    expect(expiries).toEqual([]);
    timers.advance(1);
    expect(expiries).toEqual([{ kind: "turn", player: "p2" }]);
  });

  it("R79: a prompt held by the non-active player pauses the turn clock, and only its own clock expires", () => {
    const { timers, clock, expiries, turnMs, promptMs } = harness();
    clock.sync(view());

    // Spend most of p1's turn, then a trap fires and asks p2 a question.
    const spent = turnMs - 15 * SECOND;
    timers.advance(spent);
    expect(clock.remainingFor("p1")).toBe(turnMs - spent);

    clock.sync(view({ pendingFor: "p2" }));
    expect(clock.snapshot().turnDeadline).toBeNull();
    expect(clock.snapshot().promptDeadline).toBe(timers.now() + promptMs);

    // The prompt outlives what was left of p1's turn: 60 s spent + a 30 s prompt is past the 75 s
    // turn clock, so an unpaused turn clock would have fired in here.
    timers.advance(promptMs);
    expect(expiries).toEqual([{ kind: "prompt", player: "p2" }]);
    expect(clock.remainingFor("p1")).toBe(turnMs - spent);

    // R79: when the pause ends the turn clock resumes with the time it had left, not from full.
    clock.sync(view());
    expect(clock.snapshot().turnDeadline).toBe(timers.now() + (turnMs - spent));
    timers.advance(turnMs - spent - 1);
    expect(expiries).toHaveLength(1);
    timers.advance(1);
    expect(expiries).toEqual([
      { kind: "prompt", player: "p2" },
      { kind: "turn", player: "p1" },
    ]);
  });

  it("does not pause the turn clock for a prompt held by the active player", () => {
    const { timers, clock, expiries, turnMs, promptMs } = harness();
    // §2.5: "When the active player's turn clock runs out, their open prompts are answered by the
    // AI policy and the turn ends" — their own prompt gets no second, shorter deadline.
    clock.sync(view({ pendingFor: "p1" }));
    expect(clock.snapshot().turnDeadline).toBe(timers.now() + turnMs);
    expect(clock.snapshot().promptDeadline).toBeNull();

    timers.advance(promptMs);
    expect(expiries).toEqual([]);

    timers.advance(turnMs - promptMs);
    expect(expiries).toEqual([{ kind: "turn", player: "p1" }]);
  });

  it("counts disconnect grace per player and reports whose it was", () => {
    const { timers, clock, expiries, graceMs } = harness();
    clock.startGrace("p2");
    expect(clock.snapshot().graceDeadline).toEqual({ p1: null, p2: timers.now() + graceMs });

    timers.advance(graceMs - 1);
    expect(expiries).toEqual([]);
    timers.advance(1);
    expect(expiries).toEqual([{ kind: "grace", player: "p2" }]);
    expect(clock.snapshot().graceDeadline.p2).toBeNull();
  });

  it("R147 keeps the first deadline when a second grace starts, so a flapping socket cannot extend it", () => {
    const { timers, clock, expiries, graceMs } = harness();
    clock.startGrace("p1");
    const deadline = clock.snapshot().graceDeadline.p1;
    expect(deadline).toBe(timers.now() + graceMs);

    // The socket flaps: another drop arrives while the first countdown is still running. Re-arming
    // here would hand the player a fresh window every time they bounced, and the match would stall
    // for as long as they kept it up.
    timers.advance(graceMs - SECOND);
    clock.startGrace("p1");
    expect(clock.snapshot().graceDeadline.p1).toBe(deadline);
    expect(expiries).toEqual([]);

    // It expires at the deadline the *first* drop set, not a second later.
    timers.advance(SECOND);
    expect(expiries).toEqual([{ kind: "grace", player: "p1" }]);

    // And a grace that has run out can be started again: the guard is about extending a live
    // countdown, not about refusing the next one.
    clock.startGrace("p1");
    expect(clock.snapshot().graceDeadline.p1).toBe(timers.now() + graceMs);
  });

  it("cancels grace when the player returns inside the window", () => {
    const { timers, clock, expiries, graceMs } = harness();
    clock.startGrace("p1");
    timers.advance(graceMs - SECOND);
    clock.clearGrace("p1");
    expect(clock.snapshot().graceDeadline.p1).toBeNull();

    timers.advance(graceMs * 2);
    expect(expiries.filter((expiry) => expiry.kind === "grace")).toEqual([]);
  });

  it("keeps the turn clock running while a player is disconnected (§9.5)", () => {
    const { timers, clock, expiries, turnMs, graceMs } = harness();
    clock.sync(view());
    const deadline = clock.snapshot().turnDeadline;

    clock.startGrace("p2");
    // §9.5: "The clock keeps running while a player is disconnected."
    expect(clock.snapshot().turnDeadline).toBe(deadline);

    timers.advance(turnMs);
    expect(expiries).toEqual([
      { kind: "grace", player: "p2" },
      { kind: "turn", player: "p1" },
    ]);
    expect(graceMs).toBeLessThan(turnMs);
  });

  it("fires the ceiling once, measured from startedAt (R79)", () => {
    const elapsed = 10 * MINUTE;
    const { timers, clock, expiries, startedAt, config, ceilingMs } = harness({
      startedOffsetMs: elapsed,
    });
    expect(clock.snapshot().ceilingAt).toBe(matchCeilingAt(startedAt, config));
    expect(clock.snapshot().ceilingAt).toBe(startedAt + ceilingMs);

    timers.advance(ceilingMs - elapsed - 1);
    expect(expiries).toEqual([]);
    timers.advance(1);
    expect(expiries).toEqual([{ kind: "ceiling" }]);

    timers.advance(ceilingMs);
    expect(expiries).toEqual([{ kind: "ceiling" }]);
    expect(timers.pending).toBe(0);
  });

  it("exposes every deadline through snapshot() and counts down through remainingFor()", () => {
    const { timers, clock, startedAt, turnMs, promptMs, graceMs, ceilingMs } = harness();
    expect(clock.snapshot()).toEqual({
      turnDeadline: null,
      promptDeadline: null,
      graceDeadline: { p1: null, p2: null },
      ceilingAt: startedAt + ceilingMs,
    });

    clock.sync(view());
    expect(clock.snapshot().turnDeadline).toBe(timers.now() + turnMs);

    timers.advance(10 * SECOND);
    expect(clock.remainingFor("p1")).toBe(turnMs - 10 * SECOND);
    expect(clock.remainingFor("p2")).toBeNull();

    clock.startGrace("p1");
    clock.sync(view({ pendingFor: "p2" }));
    expect(clock.snapshot()).toEqual({
      turnDeadline: null,
      promptDeadline: timers.now() + promptMs,
      graceDeadline: { p1: timers.now() + graceMs, p2: null },
      ceilingAt: startedAt + ceilingMs,
    });
    // The paused turn clock still reports its banked remainder; the prompt holder reports theirs.
    expect(clock.remainingFor("p1")).toBe(turnMs - 10 * SECOND);
    expect(clock.remainingFor("p2")).toBe(promptMs);

    timers.advance(SECOND);
    expect(clock.remainingFor("p2")).toBe(promptMs - SECOND);
    expect(clock.remainingFor("p1")).toBe(turnMs - 10 * SECOND);
  });

  it("stops everything once the match is over", () => {
    const { timers, clock, expiries } = harness();
    clock.sync(view());
    clock.startGrace("p1");
    clock.startGrace("p2");
    expect(timers.pending).toBeGreaterThan(0);

    clock.sync(view({ over: true }));
    expect(timers.pending).toBe(0);
    expect(clock.remainingFor("p1")).toBeNull();

    // A late sync must never re-arm a deadline on a finished match.
    clock.sync(view({ turn: 2, active: "p2" }));
    expect(timers.pending).toBe(0);
    timers.advance(60 * MINUTE);
    expect(expiries).toEqual([]);
  });

  it("stop() cancels every timer and is idempotent", () => {
    const { timers, clock, expiries } = harness();
    clock.sync(view({ pendingFor: "p2" }));
    clock.startGrace("p1");
    expect(timers.pending).toBeGreaterThan(0);

    clock.stop();
    clock.stop();
    expect(timers.pending).toBe(0);
    timers.advance(60 * MINUTE);
    expect(expiries).toEqual([]);
  });

  it("gives a fresh match row only the ceiling (§9.5)", () => {
    const { startedAt, config, ceilingMs } = harness();
    expect(initialClocks(startedAt, config)).toEqual({
      turnDeadline: null,
      promptDeadline: null,
      graceDeadline: { p1: null, p2: null },
      ceilingAt: startedAt + ceilingMs,
    });
  });
});
