// B2 (docs/polish/2-sound.md): the first user gesture builds and resumes the context inside the
// gesture itself, which is what iOS requires, and later gestures resume it again only while it is
// not running. The events and the order come from the HTML standard's activation-triggering input
// events, which is why a touch `pointerdown` alone is not enough and `pointerup`/`touchend` are
// listened to as well.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAudioEngine } from "./engine.ts";
import { resetAudioSettingsForTests } from "./settings.ts";
import { FakeClock, FakeFetch, fakeContextFactory, fakeSpeech, type FakeAudio, type FakeAudioOptions, type FakeContextFactory } from "./test/fakeAudio.ts";
import type { AudioEngine, AudioState, VoiceLineTable, VoiceManifest } from "./types.ts";
import { UNLOCK_EVENTS, installAudioUnlock } from "./unlock.ts";

const LINES: VoiceLineTable = {
  version: 1,
  personas: { hustler: { say: "Rocko (English (US))", rate: 215, pbas: 50, pmod: 45, web: { pitch: 1.1, rate: 1.15 } } },
  cards: { "core-004": { kind: "unit", persona: "hustler", play: "Double or nothing, baby!", death: "House always wins." } },
};
const MANIFEST: VoiceManifest = { version: 1, format: "m4af aac@22050 mono 32000", files: {} };

const removers: (() => void)[] = [];
const engines: AudioEngine[] = [];

function rig(options: FakeAudioOptions = { state: "suspended", resumeMode: "run" }): { engine: AudioEngine; factory: FakeContextFactory } {
  const factory = fakeContextFactory(options);
  const engine = createAudioEngine({
    createContext: factory.create,
    speech: fakeSpeech().port,
    fetchBytes: new FakeFetch().fetchBytes,
    now: new FakeClock().now,
    visibility: () => "visible",
    lines: LINES,
    manifest: MANIFEST,
  });
  engines.push(engine);
  return { engine, factory };
}

function install(engine: Pick<AudioEngine, "unlock" | "state">): () => void {
  const remove = installAudioUnlock(engine);
  removers.push(remove);
  return remove;
}

/** The one-frame silent buffer sources connected straight to the destination (the iOS unlock). */
function silentUnlockSources(audio: FakeAudio) {
  return audio.nodes.filter(
    (n) =>
      n.kind === "bufferSource" &&
      n.started &&
      n.connections.includes(audio.destination) &&
      n.buffer !== null &&
      n.buffer.length === 1 &&
      Array.from({ length: n.buffer.numberOfChannels }, (_, c) => n.buffer?.channel(c) ?? new Float32Array(0)).every((data) =>
        data.every((x) => x === 0),
      ),
  );
}

function gesture(type: string, target: EventTarget = window): void {
  target.dispatchEvent(new Event(type, { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  resetAudioSettingsForTests();
});

afterEach(() => {
  for (const remove of removers.splice(0)) remove();
  for (const engine of engines.splice(0)) {
    try {
      engine.dispose();
    } catch {
      // Not what these tests are about.
    }
  }
  resetAudioSettingsForTests();
  vi.restoreAllMocks();
});

describe("B2 the first gesture unlocks audio, inside the gesture", () => {
  it("B2 UNLOCK_EVENTS are pointerdown, pointerup, touchend, click and keydown", () => {
    expect([...UNLOCK_EVENTS]).toEqual(["pointerdown", "pointerup", "touchend", "click", "keydown"]);
  });

  it.each(["pointerdown", "pointerup", "touchend", "click", "keydown"])(
    "B2 a %s on window builds exactly one context, resumes it and starts a one-frame silent source before the dispatch returns",
    (type) => {
      const { engine, factory } = rig({ state: "suspended", resumeMode: "stay" });
      install(engine);
      expect(factory.create).not.toHaveBeenCalled();

      gesture(type);

      // Everything below happened synchronously inside dispatchEvent: no await, no timer.
      expect(factory.create).toHaveBeenCalledTimes(1);
      expect(engine.contextsCreated()).toBe(1);
      const audio = factory.last();
      expect(audio.resume).toHaveBeenCalled();
      expect(silentUnlockSources(audio), "a one-frame silent buffer source played into the destination").not.toEqual([]);
      expect(audio.violations).toEqual([]);
    },
  );

  it("B2 events that are not gestures unlock nothing", () => {
    const { engine, factory } = rig();
    install(engine);

    for (const type of ["mousemove", "pointermove", "pointerover", "scroll", "touchstart", "focus", "wheel"]) gesture(type);

    expect(factory.create).not.toHaveBeenCalled();
    expect(engine.state()).toBe("locked");
  });

  it("B2 later gestures call resume() again only while the context is not running, and never build a second context", () => {
    const { engine, factory } = rig({ state: "suspended", resumeMode: "stay" });
    install(engine);

    gesture("pointerdown");
    const audio = factory.last();
    const afterFirst = audio.resume.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    gesture("pointerup");
    expect(audio.resume.mock.calls.length, "still suspended: resumed again").toBeGreaterThan(afterFirst);

    audio.state = "running";
    const whileRunning = audio.resume.mock.calls.length;
    gesture("click");
    gesture("keydown");
    expect(audio.resume.mock.calls.length, "running: left alone").toBe(whileRunning);

    // iOS can suspend the context again (a call, a backgrounding); the next tap resumes it.
    audio.state = "suspended";
    gesture("touchend");
    expect(audio.resume.mock.calls.length).toBeGreaterThan(whileRunning);

    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(engine.contextsCreated()).toBe(1);
  });

  it("B2 Safari's interrupted state reads as suspended, and the next gesture resumes it", () => {
    const { engine, factory } = rig({ state: "suspended", resumeMode: "run" });
    install(engine);
    gesture("pointerdown");
    const audio = factory.last();
    expect(engine.state()).toBe("running");

    audio.state = "interrupted";
    expect(engine.state()).toBe("suspended");
    const before = audio.resume.mock.calls.length;
    gesture("pointerup");

    expect(audio.resume.mock.calls.length).toBeGreaterThan(before);
    expect(engine.state()).toBe("running");
  });

  it("B2 a rejected resume() is swallowed: the gesture does not throw and nothing is left unhandled", async () => {
    const { engine, factory } = rig({ state: "suspended", resumeMode: "reject" });
    install(engine);

    expect(() => gesture("click")).not.toThrow();
    expect(() => engine.unlock()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(factory.last().resume).toHaveBeenCalled();
    expect(engine.state()).toBe("suspended");
  });

  it("B2 unlock() while running does nothing at all", () => {
    const { engine, factory } = rig({ state: "suspended", resumeMode: "run" });
    engine.unlock();
    const audio = factory.last();
    expect(engine.state()).toBe("running");
    const resumes = audio.resume.mock.calls.length;
    const nodes = audio.nodes.length;

    engine.unlock();
    engine.unlock();

    expect(audio.resume.mock.calls.length).toBe(resumes);
    expect(audio.nodes.length).toBe(nodes);
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it("B2 listens in the capture phase, so a gesture the page stops before it bubbles still unlocks", () => {
    const { engine, factory } = rig();
    install(engine);
    const button = document.createElement("button");
    document.body.append(button);
    button.addEventListener("pointerup", (e) => e.stopPropagation());
    button.addEventListener("click", (e) => e.stopImmediatePropagation());

    gesture("pointerup", button);

    expect(factory.create).toHaveBeenCalledTimes(1);
    button.remove();
  });

  it("B2 the remover takes every listener off", () => {
    const { engine, factory } = rig();
    const remove = install(engine);
    remove();

    for (const type of UNLOCK_EVENTS) gesture(type);

    expect(factory.create).not.toHaveBeenCalled();
    expect(engine.state()).toBe("locked");
  });

  it("B2 the listener calls unlock() synchronously for a locked or suspended engine", () => {
    for (const state of ["locked", "suspended"] as const satisfies readonly AudioState[]) {
      const unlock = vi.fn();
      const remove = install({ unlock, state: () => state });
      gesture("keydown");
      expect(unlock, state).toHaveBeenCalledTimes(1);
      remove();
    }
  });

  it("B2 the listener never calls unlock() for a running or unsupported engine", () => {
    for (const state of ["running", "unsupported"] as const satisfies readonly AudioState[]) {
      const unlock = vi.fn();
      const remove = install({ unlock, state: () => state });
      for (const type of UNLOCK_EVENTS) gesture(type);
      expect(unlock, state).not.toHaveBeenCalled();
      remove();
    }
  });
});
