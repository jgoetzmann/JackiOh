// docs/polish/1-animations.md, behaviour B29: the frame loop (S5). It asks for frames only while
// there is work, clamps dt, requests nothing while the page is hidden and calls onResume when it
// comes back. Frames and visibility are fakes driven by hand; `now` is a plain variable.

import { describe, expect, it, vi } from "vitest";

import { FX_MAX_DT_MS } from "./constants.ts";
import { createFrameLoop, type FxFrame } from "./loop.ts";
import type { FxFrameSource, FxVisibility } from "./types.ts";

/** A frame source whose callbacks run only when the test says so. */
function fakeFrames() {
  let nextHandle = 1;
  const pending = new Map<number, (timestampMs: number) => void>();
  const requests = vi.fn();
  const cancels = vi.fn();
  const source: FxFrameSource = {
    request(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      requests(handle);
      return handle;
    },
    cancel(handle) {
      cancels(handle);
      pending.delete(handle);
    },
  };
  return {
    source,
    requests,
    cancels,
    pending: () => pending.size,
    /** Runs every pending callback once, as one animation frame at `timestamp`. */
    run(timestamp: number): void {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(timestamp);
    },
  };
}

/** A visibility source flipped by hand. `ping` notifies without a change. */
function fakeVisibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const source: FxVisibility = {
    hidden: () => hidden,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    listeners: () => listeners.size,
    set(next: boolean): void {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
    ping(): void {
      for (const listener of [...listeners]) listener();
    },
  };
}

function harness(onFrame: (frame: FxFrame) => boolean = () => false) {
  let clock = 1_000;
  const frames = fakeFrames();
  const visibility = fakeVisibility();
  const seen: FxFrame[] = [];
  const onResume = vi.fn();
  const frameSpy = vi.fn((frame: FxFrame) => {
    seen.push(frame);
    return onFrame(frame);
  });
  const loop = createFrameLoop({
    frames: frames.source,
    visibility: visibility.source,
    now: () => clock,
    onFrame: frameSpy,
    onResume,
  });
  return {
    loop,
    frames,
    visibility,
    seen,
    onResume,
    onFrame: frameSpy,
    setNow(value: number): void {
      clock = value;
    },
    /** Moves the clock to `at` and runs the pending frame with that timestamp. */
    frameAt(at: number): void {
      clock = at;
      frames.run(at);
    },
  };
}

describe("B29 frames only while there is work", () => {
  it("B29 nothing is requested until wake()", () => {
    const h = harness();
    expect(h.frames.pending()).toBe(0);
    expect(h.loop.running()).toBe(false);
    h.loop.wake();
    expect(h.frames.pending()).toBe(1);
    expect(h.loop.running()).toBe(true);
  });

  it("B29 a second wake while a frame is pending requests nothing more", () => {
    const h = harness();
    h.loop.wake();
    h.loop.wake();
    h.loop.wake();
    expect(h.frames.pending()).toBe(1);
    expect(h.frames.requests).toHaveBeenCalledTimes(1);
  });

  it("B29 frames keep coming while onFrame returns true, and stop the frame it returns false", () => {
    let work = 3;
    const h = harness(() => {
      work -= 1;
      return work > 0;
    });
    h.loop.wake();
    h.frameAt(1_016);
    expect(h.frames.pending()).toBe(1);
    h.frameAt(1_032);
    expect(h.frames.pending()).toBe(1);
    h.frameAt(1_048);
    expect(h.frames.pending()).toBe(0);
    expect(h.loop.running()).toBe(false);
    expect(h.onFrame).toHaveBeenCalledTimes(3);
  });

  it("B29 after the loop stops, wake() starts it again", () => {
    const h = harness(() => false);
    h.loop.wake();
    h.frameAt(1_016);
    expect(h.loop.running()).toBe(false);
    h.loop.wake();
    expect(h.frames.pending()).toBe(1);
    h.frameAt(1_100);
    expect(h.onFrame).toHaveBeenCalledTimes(2);
  });
});

describe("B29 frame timing", () => {
  it("B29 dt is the raw frame time, clamped to FX_MAX_DT_MS", () => {
    expect(FX_MAX_DT_MS).toBe(50);
    const h = harness(() => true);
    h.setNow(1_000);
    h.loop.wake();
    h.frameAt(1_016);
    h.frameAt(1_316);
    const [first, second] = h.seen;
    expect(first).toEqual({ dt: 16, raw: 16, now: 1_016, first: true });
    expect(second).toEqual({ dt: FX_MAX_DT_MS, raw: 300, now: 1_316, first: false });
  });

  it("B34 only the first frame after each wake is marked first: its raw time runs from the wake, not from a frame", () => {
    let frames = 0;
    const h = harness(() => {
      frames += 1;
      return frames < 3;
    });
    h.setNow(1_000);
    h.loop.wake();
    h.frameAt(1_004);
    h.frameAt(1_020);
    h.frameAt(1_036);
    expect(h.seen.map((frame) => frame.first)).toEqual([true, false, false]);
    // The loop stopped; the next wake starts a fresh run.
    h.setNow(5_000);
    h.loop.wake();
    h.frameAt(5_010);
    expect(h.seen.at(-1)?.first).toBe(true);
  });

  it("B29 a clock that runs backwards gives dt 0", () => {
    const h = harness(() => true);
    h.setNow(2_000);
    h.loop.wake();
    h.frameAt(2_016);
    h.frameAt(2_010);
    const last = h.seen.at(-1);
    expect(last?.raw).toBe(-6);
    expect(last?.dt).toBe(0);
  });

  it("B29 the first frame after a wake measures raw from the wake, not from the last frame", () => {
    const h = harness(() => false);
    h.setNow(500);
    h.loop.wake();
    h.frameAt(520);
    expect(h.seen[0]?.raw).toBe(20);

    h.setNow(5_000);
    h.loop.wake();
    h.frameAt(5_010);
    expect(h.seen[1]?.raw).toBe(10);
    expect(h.seen[1]?.dt).toBe(10);
  });
});

describe("B29 visibility", () => {
  it("B29 wake() requests nothing while the page is hidden", () => {
    const h = harness(() => true);
    h.visibility.set(true);
    h.loop.wake();
    expect(h.frames.pending()).toBe(0);
    expect(h.frames.requests).not.toHaveBeenCalled();
    expect(h.onFrame).not.toHaveBeenCalled();
  });

  it("B29 turning hidden cancels the pending frame", () => {
    const h = harness(() => true);
    h.loop.wake();
    expect(h.frames.pending()).toBe(1);
    h.visibility.set(true);
    expect(h.frames.pending()).toBe(0);
    expect(h.frames.cancels).toHaveBeenCalledTimes(1);
    h.frameAt(1_016);
    expect(h.onFrame).not.toHaveBeenCalled();
  });

  it("B29 turning visible calls onResume and requests nothing until the next wake", () => {
    const h = harness(() => true);
    h.loop.wake();
    h.visibility.set(true);
    h.visibility.set(false);
    expect(h.onResume).toHaveBeenCalledTimes(1);
    expect(h.frames.pending()).toBe(0);

    h.setNow(9_000);
    h.loop.wake();
    expect(h.frames.pending()).toBe(1);
    h.frameAt(9_016);
    expect(h.seen.at(-1)?.raw).toBe(16);
  });

  it("B29 a visibility event without a hide does not call onResume", () => {
    const h = harness(() => true);
    h.visibility.ping();
    h.visibility.set(false);
    expect(h.onResume).not.toHaveBeenCalled();
  });

  it("B29 hiding while idle requests nothing and resuming still calls onResume", () => {
    const h = harness(() => false);
    h.visibility.set(true);
    h.visibility.set(false);
    expect(h.onResume).toHaveBeenCalledTimes(1);
    expect(h.frames.pending()).toBe(0);
  });
});

describe("B29 dispose", () => {
  it("B29 dispose cancels the pending frame and stops listening to visibility", () => {
    const h = harness(() => true);
    h.loop.wake();
    h.loop.dispose();
    expect(h.frames.pending()).toBe(0);
    expect(h.visibility.listeners()).toBe(0);
    h.visibility.set(true);
    h.visibility.set(false);
    expect(h.onResume).not.toHaveBeenCalled();
    expect(h.loop.running()).toBe(false);
  });
});
