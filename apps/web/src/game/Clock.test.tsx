// BUILD M7-T1's client half. R79 fixes the behaviour and the actor runs it; what is asserted here
// is that the component RENDERS it rather than deciding it:
//
//   * the turn clock belongs to the active player;
//   * a prompt held by the non-active player runs its own `PROMPT_CLOCK_SECONDS` clock and the
//     turn clock pauses — which reaches the browser as `turnDeadline: null` in the `clock` frame,
//     so the component shows a stopped clock because the server stopped it, not because it worked
//     out that a prompt was open;
//   * remaining time is `deadline - now` measured against a monotonic delta, as
//     `apps/server/src/match/protocol.ts` documents, never against the browser's wall clock.
//
// Every duration comes from `apps/server/src/config.ts`; no test below spells a number of seconds.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DISCONNECT_GRACE_MS,
  MATCH_CEILING_MS,
  PROMPT_CLOCK_MS,
  TURN_CLOCK_MS,
} from "../../../server/src/config.ts";
import Clock, { formatClock, readClock, type ClockFrame, type ClockProps } from "./Clock.tsx";

afterEach(cleanup);

const NOW = 1_700_000_000_000;

function frame(over: Partial<ClockFrame["clocks"]> = {}, now = NOW): ClockFrame {
  return {
    now,
    clocks: {
      turnDeadline: now + TURN_CLOCK_MS,
      promptDeadline: null,
      graceDeadline: { p1: null, p2: null },
      ceilingAt: now + MATCH_CEILING_MS,
      ...over,
    },
  };
}

/** A monotonic source the test drives by hand, so no timer is involved. */
function monotonicAt(value: { ms: number }): () => number {
  return () => value.ms;
}

function props(over: Partial<ClockProps> = {}): ClockProps {
  return { youMs: null, opponentMs: null, viewer: "p1", activePlayer: "p1", ...over };
}

// ---------------------------------------------------------------------------------------------
// R79: whose clock is running
// ---------------------------------------------------------------------------------------------

describe("R79 — the turn clock belongs to the active player", () => {
  it("counts down for the active player and is idle for the other", () => {
    const readout = readClock(props({ frame: frame(), activePlayer: "p1", viewer: "p1" }), 0);
    expect(readout.you.kind).toBe("turn");
    expect(readout.you.remainingMs).toBe(TURN_CLOCK_MS);
    expect(readout.you.totalMs).toBe(TURN_CLOCK_MS);
    expect(readout.opponent.kind).toBe("idle");
    expect(readout.turn).toBe(readout.you);
  });

  it("follows the viewer's seat, not p1", () => {
    const readout = readClock(props({ frame: frame(), activePlayer: "p1", viewer: "p2" }), 0);
    expect(readout.opponent.kind).toBe("turn");
    expect(readout.you.kind).toBe("idle");
    expect(readout.turn).toBe(readout.opponent);
  });

  it("arms no prompt clock while nobody holds a prompt", () => {
    expect(readClock(props({ frame: frame() }), 0).prompt).toBe(null);
  });
});

describe("R79 — a prompt held by the non-active player pauses the turn clock", () => {
  const paused = props({
    // The server stopped the turn clock and armed the prompt's own: that is what the frame says.
    frame: frame({ turnDeadline: null, promptDeadline: NOW + PROMPT_CLOCK_MS }),
    activePlayer: "p1",
    promptHolder: "p2",
    viewer: "p1",
    youMs: 30_000,
    opponentMs: null,
  });

  it("shows the active player's clock as paused", () => {
    const readout = readClock(paused, 0);
    expect(readout.you.kind).toBe("turn");
    expect(readout.you.paused).toBe(true);
    // Paused means stopped, so what is left is whatever the last view carried.
    expect(readout.you.remainingMs).toBe(30_000);
  });

  it("shows the prompt holder's own clock, over PROMPT_CLOCK_MS", () => {
    const readout = readClock(paused, 0);
    expect(readout.opponent.kind).toBe("prompt");
    expect(readout.opponent.remainingMs).toBe(PROMPT_CLOCK_MS);
    expect(readout.opponent.totalMs).toBe(PROMPT_CLOCK_MS);
    expect(readout.prompt).toBe(readout.opponent);
  });

  it("does not run the paused clock down as time passes, and does run the prompt's", () => {
    const early = readClock(paused, 0);
    const later = readClock(paused, 5_000);
    expect(later.you.remainingMs).toBe(early.you.remainingMs);
    expect(later.opponent.remainingMs).toBe((early.opponent.remainingMs ?? 0) - 5_000);
  });

  it("does not pause when the prompt is the active player's own", () => {
    // R79 arms the separate clock only for a prompt held by the *non-active* player.
    const readout = readClock(
      props({
        frame: frame({ promptDeadline: NOW + PROMPT_CLOCK_MS }),
        activePlayer: "p1",
        promptHolder: "p1",
      }),
      0,
    );
    expect(readout.you.paused).toBe(false);
    expect(readout.you.kind).toBe("prompt");
  });

  it("decides nothing itself: no frame means no pause is claimed", () => {
    const readout = readClock(
      props({ frame: null, activePlayer: "p1", promptHolder: "p2", youMs: 30_000 }),
      0,
    );
    expect(readout.you.paused).toBe(false);
    expect(readout.you.remainingMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------------------------
// the monotonic delta (protocol.ts)
// ---------------------------------------------------------------------------------------------

describe("remaining time is deadline - now against a monotonic delta", () => {
  it("subtracts the elapsed monotonic time from the server's own now", () => {
    const readout = readClock(props({ frame: frame() }), 12_000);
    expect(readout.you.remainingMs).toBe(TURN_CLOCK_MS - 12_000);
  });

  it("is unaffected by the browser's wall clock being wrong", () => {
    // `frame.now` is the server's clock; a client 10 minutes off still reads the same remainder.
    const skewed = frame({}, NOW + 600_000);
    expect(readClock(props({ frame: skewed }), 0).you.remainingMs).toBe(TURN_CLOCK_MS);
  });

  it("never shows a negative number of seconds", () => {
    expect(formatClock(-5_000)).toBe("0s");
    expect(formatClock(null)).toBe("—");
    expect(formatClock(1_400)).toBe("2s");
  });
});

// ---------------------------------------------------------------------------------------------
// grace and the ceiling (§9.5, R79)
// ---------------------------------------------------------------------------------------------

describe("grace and the ceiling", () => {
  it("maps the frame's per-player grace onto the viewer's sides", () => {
    const readout = readClock(
      props({
        frame: frame({ graceDeadline: { p1: null, p2: NOW + DISCONNECT_GRACE_MS } }),
        viewer: "p1",
      }),
      0,
    );
    expect(readout.grace.you).toBe(null);
    expect(readout.grace.opponent).toBe(DISCONNECT_GRACE_MS);
  });

  it("falls back to the graceMs prop when no frame has arrived", () => {
    const readout = readClock(props({ frame: null, graceMs: { you: 1_000, opponent: null } }), 0);
    expect(readout.grace.you).toBe(1_000);
  });

  it("counts the wall-clock ceiling down from the frame", () => {
    expect(readClock(props({ frame: frame() }), 1_000).ceilingMs).toBe(MATCH_CEILING_MS - 1_000);
  });
});

// ---------------------------------------------------------------------------------------------
// what reaches the DOM
// ---------------------------------------------------------------------------------------------

describe("the rendered clock", () => {
  it("renders both sides, the turn clock and the ceiling", () => {
    const at = { ms: 0 };
    render(<Clock {...props({ frame: frame(), monotonic: monotonicAt(at) })} />);
    expect(screen.getByTestId("clock-you")).toHaveAttribute("data-kind", "turn");
    expect(screen.getByTestId("clock-opponent")).toHaveAttribute("data-kind", "idle");
    expect(screen.getByTestId("turn-clock")).toHaveAttribute("data-total-ms", String(TURN_CLOCK_MS));
    expect(screen.getByTestId("match-ceiling")).toHaveAttribute(
      "data-total-ms",
      String(MATCH_CEILING_MS),
    );
    expect(screen.queryByTestId("prompt-clock")).toBeNull();
    expect(screen.queryByTestId("grace-you")).toBeNull();
  });

  it("marks the turn clock paused and shows the prompt clock when R79 says so", () => {
    const at = { ms: 0 };
    render(
      <Clock
        {...props({
          frame: frame({ turnDeadline: null, promptDeadline: NOW + PROMPT_CLOCK_MS }),
          activePlayer: "p1",
          promptHolder: "p2",
          youMs: 30_000,
          monotonic: monotonicAt(at),
        })}
      />,
    );
    expect(screen.getByTestId("turn-clock")).toHaveAttribute("data-paused", "true");
    const prompt = screen.getByTestId("prompt-clock");
    expect(prompt).toHaveAttribute("data-side", "opponent");
    expect(prompt).toHaveAttribute("data-total-ms", String(PROMPT_CLOCK_MS));
  });

  it("renders grace-<side> only for the side that is actually away", () => {
    const at = { ms: 0 };
    render(
      <Clock
        {...props({
          frame: frame({ graceDeadline: { p1: NOW + DISCONNECT_GRACE_MS, p2: null } }),
          monotonic: monotonicAt(at),
        })}
      />,
    );
    const grace = screen.getByTestId("grace-you");
    expect(grace).toHaveAttribute("data-total-ms", String(DISCONNECT_GRACE_MS));
    expect(grace).toHaveAttribute("data-remaining-ms", String(DISCONNECT_GRACE_MS));
    expect(screen.queryByTestId("grace-opponent")).toBeNull();
  });

  it("still renders both sides from PlayerView.clockMs when no frame has arrived", () => {
    render(<Clock {...props({ youMs: 42_000, opponentMs: null, frame: null })} />);
    expect(screen.getByTestId("clock-you")).toHaveTextContent("42s");
    expect(screen.getByTestId("clock-opponent")).toHaveTextContent("—");
    expect(screen.queryByTestId("turn-clock")).toBeInTheDocument();
    expect(screen.queryByTestId("match-ceiling")).toBeNull();
  });

  it("ticks down as the monotonic clock advances, without a new frame", () => {
    const at = { ms: 0 };
    const pinned = props({ frame: frame(), monotonic: monotonicAt(at) });
    const view = render(<Clock {...pinned} />);
    expect(screen.getByTestId("clock-you")).toHaveTextContent(formatClock(TURN_CLOCK_MS));
    at.ms = 10_000;
    view.rerender(<Clock {...pinned} />);
    expect(screen.getByTestId("clock-you")).toHaveTextContent(formatClock(TURN_CLOCK_MS - 10_000));
  });
});
