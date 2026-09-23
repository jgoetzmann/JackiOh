// B36 of docs/polish/3-ai.md: the practice controller's pacing loop, against a scripted host.
//
// The host here is a fake that holds every request open until the test answers it, so "exactly
// one request in flight" and "queued behind it" are observable, and the clock is vitest's fake
// timers, so "waits firstActionMs / actionGapMs / promptAnswerMs" is checked to the millisecond:
// nothing is sent one millisecond early, and exactly one `aiStep` is sent on time. The snapshots
// are fixture views from `src/test/fixtures.ts`; the controller reads nothing but a snapshot.
//
// Seats: the human is p1 and the AI p2 throughout, so `waitingPending` (a prompt pending for p2)
// is the AI's own prompt as the human sees it, and the AI's turns are the even ones.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionBody, DistributiveOmit, PlayerView } from "@jackioh/shared";

import { baseView, waitingPending } from "../test/fixtures.ts";
import type { PracticePacing } from "./config.ts";
import { createPracticeController } from "./controller.ts";
import type { PracticeController, PracticeTimers } from "./controller.ts";
import type { PracticeHost } from "./host.ts";
import type {
  PracticeDebug,
  PracticeRequestBody,
  PracticeResponse,
  PracticeSnapshot,
  PracticeStartConfig,
} from "./protocol.ts";

/** Three distinct gaps, none a multiple of another, so a wrong one cannot pass for the right one. */
const PACING: PracticePacing = { firstActionMs: 700, actionGapMs: 250, promptAnswerMs: 120 };
const LONGEST_GAP = 700;

const CONFIG: PracticeStartConfig = { seed: "ctl-seed", difficulty: "medium", humanSeat: "p1", deck: { kind: "random" } };

/** The global timers, looked up at call time so they are vitest's fake ones. */
const TIMERS: PracticeTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

// ---------------------------------------------------------------------------------------------
// the scripted host
// ---------------------------------------------------------------------------------------------

type Held = {
  id: number;
  body: PracticeRequestBody;
  answered: boolean;
  resolve(response: PracticeResponse): void;
  reject(error: unknown): void;
};

type Answer = DistributiveOmit<PracticeResponse, "id">;

type FakeHost = {
  host: PracticeHost;
  /** Every request, in the order the controller sent it. */
  requests: Held[];
  maxInFlight(): number;
  open(): Held[];
  /** Answer the oldest open request. */
  respond(answer: Answer): void;
  fail(error: unknown): void;
  disposed(): number;
};

function fakeHost(): FakeHost {
  const requests: Held[] = [];
  let inFlight = 0;
  let most = 0;
  let disposals = 0;

  const oldestOpen = (): Held => {
    const held = requests.find((request) => !request.answered);
    if (held === undefined) throw new Error("no request is open to answer");
    return held;
  };

  return {
    requests,
    host: {
      request(body) {
        inFlight += 1;
        most = Math.max(most, inFlight);
        return new Promise<PracticeResponse>((resolve, reject) => {
          requests.push({
            id: requests.length + 1,
            body,
            answered: false,
            resolve: (response) => {
              inFlight -= 1;
              resolve(response);
            },
            reject: (error) => {
              inFlight -= 1;
              reject(error);
            },
          });
        });
      },
      dispose() {
        disposals += 1;
      },
    },
    maxInFlight: () => most,
    open: () => requests.filter((request) => !request.answered),
    respond(answer) {
      const held = oldestOpen();
      held.answered = true;
      held.resolve({ id: held.id, ...answer } as PracticeResponse);
    },
    fail(error) {
      const held = oldestOpen();
      held.answered = true;
      held.reject(error);
    },
    disposed: () => disposals,
  };
}

function snap(view: Partial<PlayerView>, aiToAct: boolean, legal: ActionBody[] = []): PracticeSnapshot {
  return { view: baseView({ viewer: "p1", ...view }), legal, aiToAct, error: null };
}

/** The AI (p2) mid-turn with nothing pending. */
function aiTurn(turn: number, aiToAct = true): PracticeSnapshot {
  return snap({ turn, active: "p2", phase: "main", pending: null }, aiToAct);
}

/** The human's (p1) own main phase: nothing for the AI to do. */
function humanTurn(turn: number): PracticeSnapshot {
  return snap({ turn, active: "p1", phase: "main", pending: null }, false, [{ type: "endTurn" }]);
}

/** Let every promise callback the controller chained run, without moving the fake clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function bodies(fake: FakeHost): PracticeRequestBody[] {
  return fake.requests.map((request) => request.body);
}

/** Start the controller and answer `start` with `snapshot`. */
async function startWith(fake: FakeHost, controller: PracticeController, snapshot: PracticeSnapshot): Promise<void> {
  const started = controller.start(CONFIG);
  await flush();
  expect(fake.requests.at(-1)?.body).toEqual({ type: "start", config: CONFIG });
  fake.respond({ type: "started", snapshot, defs: {}, aiSeat: "p2" });
  await started;
  await flush();
}

/** Nothing is sent before `ms`, and exactly one `aiStep` is sent at `ms`. */
async function expectAiStepAfter(fake: FakeHost, ms: number): Promise<void> {
  const before = fake.requests.length;
  expect(fake.open(), "no request is in flight while the gap runs").toHaveLength(0);
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(fake.requests.length, `nothing is sent ${String(ms - 1)} ms into a ${String(ms)} ms gap`).toBe(before);
  await vi.advanceTimersByTimeAsync(1);
  expect(fake.requests.length, `one request is sent at ${String(ms)} ms`).toBe(before + 1);
  expect(fake.requests.at(-1)?.body).toEqual({ type: "aiStep" });
}

function controllerFor(fake: FakeHost): PracticeController {
  return createPracticeController({ host: fake.host, pacing: PACING, timers: TIMERS });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------------------------

describe("B36 the controller's lifecycle", () => {
  it("B36 starts idle with nothing known", () => {
    const controller = controllerFor(fakeHost());
    expect(controller.getState()).toEqual({
      phase: "idle",
      config: null,
      aiSeat: null,
      defs: null,
      snapshot: null,
      thinking: false,
      failure: null,
    });
  });

  it("B36 is `starting` while `start` is in flight, then `playing` with the config, the AI's seat, defs and the snapshot", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    const snapshot = humanTurn(1);

    const started = controller.start(CONFIG);
    await flush();
    expect(controller.getState().phase).toBe("starting");
    expect(bodies(fake)).toEqual([{ type: "start", config: CONFIG }]);

    fake.respond({ type: "started", snapshot, defs: {}, aiSeat: "p2" });
    await started;
    await flush();
    const state = controller.getState();
    expect(state.phase).toBe("playing");
    expect(state.config).toEqual(CONFIG);
    expect(state.aiSeat).toBe("p2");
    expect(state.defs).toEqual({});
    expect(state.snapshot).toEqual(snapshot);
    expect(state.thinking).toBe(false);
    expect(state.failure).toBeNull();
  });

  it("B36 a start the core refuses leaves the controller `failed` with the core's message", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);

    const started = Promise.resolve(controller.start(CONFIG)).catch(() => undefined);
    await flush();
    fake.respond({ type: "failed", message: "deck 1 holds 3 cards" });
    await started;
    await flush();

    const state = controller.getState();
    expect(state.phase).toBe("failed");
    expect(state.failure).toContain("deck 1 holds 3 cards");
    expect(state.thinking).toBe(false);

    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 4);
    expect(fake.requests).toHaveLength(1);
  });

  it("B36 subscribers hear every change until they unsubscribe", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    const heard = vi.fn();
    const stop = controller.subscribe(heard);

    await startWith(fake, controller, humanTurn(1));
    expect(heard).toHaveBeenCalled();

    stop();
    const calls = heard.mock.calls.length;
    controller.act({ type: "endTurn" });
    await flush();
    fake.respond({ type: "snapshot", snapshot: humanTurn(1) });
    await flush();
    expect(heard).toHaveBeenCalledTimes(calls);
  });

  it("B36 a snapshot with a result puts the controller `over`, not thinking, and stops the loop", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, humanTurn(1));

    controller.act({ type: "concede" });
    await flush();
    fake.respond({
      type: "snapshot",
      snapshot: snap({ turn: 1, active: "p1", phase: "over", result: { winner: "p2", reason: "concede" } }, false),
    });
    await flush();

    const state = controller.getState();
    expect(state.phase).toBe("over");
    expect(state.thinking).toBe(false);
    const sent = fake.requests.length;
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 4);
    expect(fake.requests).toHaveLength(sent);
  });

  it("B36 dispose cancels the AI step a gap was waiting to send", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    expect(controller.getState().thinking).toBe(true);

    controller.dispose();
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 4);
    expect(bodies(fake)).toEqual([{ type: "start", config: CONFIG }]);
  });
});

// ---------------------------------------------------------------------------------------------
// the pacing loop
// ---------------------------------------------------------------------------------------------

describe("B36 the pacing loop", () => {
  it("B36 sends no aiStep while the snapshot says the AI owes nothing", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, humanTurn(1));

    expect(controller.getState().thinking).toBe(false);
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 10);
    expect(bodies(fake)).toEqual([{ type: "start", config: CONFIG }]);
  });

  it("B36 thinking goes on with an aiToAct snapshot, stays on across steps, and goes off with the first aiToAct false", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    expect(controller.getState().thinking).toBe(true);

    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    expect(fake.requests.at(-1)?.body).toEqual({ type: "aiStep" });
    expect(controller.getState().thinking).toBe(true);

    fake.respond({ type: "snapshot", snapshot: aiTurn(2) });
    await flush();
    expect(controller.getState().thinking).toBe(true);

    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    fake.respond({ type: "snapshot", snapshot: humanTurn(3) });
    await flush();
    expect(controller.getState().thinking).toBe(false);
    expect(controller.getState().snapshot).toEqual(humanTurn(3));
  });

  it("B36 waits actionGapMs between two AI steps of the same turn", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    // The very first step of the game: whichever gap it takes is not what this test is about.
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    expect(fake.requests.at(-1)?.body).toEqual({ type: "aiStep" });

    fake.respond({ type: "snapshot", snapshot: aiTurn(2) });
    await flush();
    await expectAiStepAfter(fake, PACING.actionGapMs);
  });

  it("B36 waits firstActionMs before the AI's first step of a new turn, then actionGapMs", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    fake.respond({ type: "snapshot", snapshot: humanTurn(3) });
    await flush();

    controller.act({ type: "endTurn" });
    await flush();
    expect(fake.requests.at(-1)?.body).toEqual({ type: "act", action: { type: "endTurn" } });
    fake.respond({ type: "snapshot", snapshot: aiTurn(4) });
    await flush();
    expect(controller.getState().thinking).toBe(true);
    await expectAiStepAfter(fake, PACING.firstActionMs);

    fake.respond({ type: "snapshot", snapshot: aiTurn(4) });
    await flush();
    await expectAiStepAfter(fake, PACING.actionGapMs);
  });

  it("B36 waits promptAnswerMs when the view shows a prompt pending for the AI", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    fake.respond({ type: "snapshot", snapshot: aiTurn(2) });
    await flush();
    await vi.advanceTimersByTimeAsync(PACING.actionGapMs);

    // Same turn, and the AI's own prompt is open: `pending.forYou === false && pendingFor === aiSeat`.
    expect(waitingPending).toEqual({ forYou: false, pendingFor: "p2" });
    fake.respond({ type: "snapshot", snapshot: snap({ turn: 2, active: "p2", phase: "main", pending: waitingPending }, true) });
    await flush();
    await expectAiStepAfter(fake, PACING.promptAnswerMs);
  });

  it("B36 keeps one request in flight: a human act waits behind the AI's step and goes out when it is answered", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    expect(fake.open().map((held) => held.body)).toEqual([{ type: "aiStep" }]);

    controller.act({ type: "concede" });
    await flush();
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    expect(fake.open().map((held) => held.body), "the act is queued, not sent").toEqual([{ type: "aiStep" }]);

    fake.respond({ type: "snapshot", snapshot: humanTurn(3) });
    await flush();
    expect(fake.open().map((held) => held.body)).toEqual([{ type: "act", action: { type: "concede" } }]);
    expect(fake.maxInFlight()).toBe(1);
  });

  it("B36 two human acts go out one at a time, in order", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, humanTurn(1));

    controller.act({ type: "switchPosition", instanceId: "u1" });
    controller.act({ type: "endTurn" });
    await flush();
    expect(fake.open().map((held) => held.body)).toEqual([
      { type: "act", action: { type: "switchPosition", instanceId: "u1" } },
    ]);

    fake.respond({ type: "snapshot", snapshot: humanTurn(1) });
    await flush();
    expect(fake.open().map((held) => held.body)).toEqual([{ type: "act", action: { type: "endTurn" } }]);
    expect(fake.maxInFlight()).toBe(1);
  });

  it("B36 a refused act's snapshot, error and all, is what the controller holds", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, humanTurn(1));

    controller.act({ type: "play", instanceId: "c9" });
    await flush();
    const refused: PracticeSnapshot = { ...humanTurn(1), error: "that card is not in your hand" };
    fake.respond({ type: "snapshot", snapshot: refused });
    await flush();

    expect(controller.getState().snapshot).toEqual(refused);
    expect(controller.getState().phase).toBe("playing");
  });
});

// ---------------------------------------------------------------------------------------------
// the board gate
// ---------------------------------------------------------------------------------------------

describe("the AI's next step waits for the board to catch up", () => {
  it("no step is sent while the board is busy, and the gap is timed from the moment it idles", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    expect(fake.requests.at(-1)?.body).toEqual({ type: "aiStep" });

    // The step's answer arrives while its events are still animating.
    controller.setBoardBusy(true);
    fake.respond({ type: "snapshot", snapshot: aiTurn(2) });
    await flush();
    const sent = fake.requests.length;
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 10);
    expect(fake.requests, "nothing is sent while the board animates").toHaveLength(sent);
    expect(controller.getState().thinking, "the AI still owes a step").toBe(true);

    controller.setBoardBusy(false);
    await expectAiStepAfter(fake, PACING.actionGapMs);
  });

  it("a board that starts animating mid-gap cancels the waiting step and re-plans it from the full gap", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    fake.respond({ type: "snapshot", snapshot: aiTurn(2) });
    await flush();

    const sent = fake.requests.length;
    await vi.advanceTimersByTimeAsync(PACING.actionGapMs - 10);
    controller.setBoardBusy(true);
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 4);
    expect(fake.requests).toHaveLength(sent);

    controller.setBoardBusy(false);
    await expectAiStepAfter(fake, PACING.actionGapMs);
  });

  it("the gate holds no human action back, and a repeated report changes nothing", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, humanTurn(1));

    controller.setBoardBusy(true);
    controller.setBoardBusy(true);
    controller.act({ type: "endTurn" });
    await flush();
    expect(fake.open().map((held) => held.body)).toEqual([{ type: "act", action: { type: "endTurn" } }]);

    fake.respond({ type: "snapshot", snapshot: aiTurn(2) });
    await flush();
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 4);
    expect(fake.open(), "the AI waits for the board").toHaveLength(0);

    controller.setBoardBusy(false);
    controller.setBoardBusy(false);
    await expectAiStepAfter(fake, PACING.firstActionMs);
    expect(fake.maxInFlight()).toBe(1);
  });
});

describe("any named hold keeps the AI's next step back (a voice line as well as the board)", () => {
  it("a voice hold alone blocks the step, and releasing it plans the step from the full gap", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    controller.setHold("voice", true);
    fake.respond({ type: "snapshot", snapshot: aiTurn(2) });
    await flush();
    const sent = fake.requests.length;
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 10);
    expect(fake.requests, "nothing is sent while a line plays").toHaveLength(sent);

    controller.setHold("voice", false);
    await expectAiStepAfter(fake, PACING.actionGapMs);
  });

  it("the step waits until every reason is released, and setBoardBusy is the board's hold", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, aiTurn(2));
    await vi.advanceTimersByTimeAsync(LONGEST_GAP);
    controller.setBoardBusy(true);
    controller.setHold("voice", true);
    fake.respond({ type: "snapshot", snapshot: aiTurn(2) });
    await flush();
    const sent = fake.requests.length;

    controller.setHold("board", false);
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 4);
    expect(fake.requests, "the voice line still holds it").toHaveLength(sent);

    controller.setBoardBusy(true);
    controller.setHold("voice", false);
    await vi.advanceTimersByTimeAsync(LONGEST_GAP * 4);
    expect(fake.requests, "setBoardBusy(true) is the board's hold").toHaveLength(sent);

    controller.setBoardBusy(false);
    await expectAiStepAfter(fake, PACING.actionGapMs);
  });
});

// ---------------------------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------------------------

describe("B36 debug() rides the same queue", () => {
  const DEBUG: PracticeDebug = {
    seed: "ctl-seed",
    decks: [[], []],
    handicaps: {},
    log: [],
    state: { turn: 1 },
    hash: "abcd1234",
    difficulty: "medium",
    humanSeat: "p1",
  };

  it("B36 debug() waits behind an in-flight request, then resolves with the core's debug", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, humanTurn(1));

    controller.act({ type: "endTurn" });
    const debugged = controller.debug();
    await flush();
    expect(fake.open().map((held) => held.body)).toEqual([{ type: "act", action: { type: "endTurn" } }]);

    fake.respond({ type: "snapshot", snapshot: humanTurn(1) });
    await flush();
    expect(fake.open().map((held) => held.body)).toEqual([{ type: "debug" }]);
    fake.respond({ type: "debug", debug: DEBUG });
    await expect(debugged).resolves.toEqual(DEBUG);
    expect(fake.maxInFlight()).toBe(1);
  });

  it("B36 debug() rejects when the core answers `failed`", async () => {
    const fake = fakeHost();
    const controller = controllerFor(fake);
    await startWith(fake, controller, humanTurn(1));

    const debugged = controller.debug();
    const settled = debugged.then(
      () => "resolved",
      () => "rejected",
    );
    await flush();
    fake.respond({ type: "failed", message: "debug is a dev-build channel" });
    await expect(settled).resolves.toBe("rejected");
  });
});
