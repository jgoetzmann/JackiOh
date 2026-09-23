// B37 of docs/polish/3-ai.md: where the practice core runs.
//
// With a `Worker` constructor present, `createPracticeHost()` builds a module worker and talks to
// it by message; jsdom has none, so a spy class stands in for it and plays the worker's side of
// the conversation. Without one (or with `forceInThread`), the host runs the core in this thread,
// and it must answer a request sequence exactly as `createPracticeCore(...).handle` does — the
// same core, the same env, the same answers, only the ids are the host's own.

import { afterEach, describe, expect, it, vi } from "vitest";

import { AI_GATE_BUDGET } from "@jackioh/ai";

import { createPracticeCore } from "./core.ts";
import type { PracticeCoreEnv } from "./core.ts";
import { createPracticeHost } from "./host.ts";
import type {
  PracticeRequest,
  PracticeRequestBody,
  PracticeResponse,
  PracticeStartConfig,
} from "./protocol.ts";

const ENV: PracticeCoreEnv = { now: () => 0, dev: true, budget: AI_GATE_BUDGET };

const CONFIG: PracticeStartConfig = { seed: "host-b37", difficulty: "easy", humanSeat: "p1", deck: { kind: "random" } };

// ---------------------------------------------------------------------------------------------
// the spy Worker
// ---------------------------------------------------------------------------------------------

type Listener = (event: MessageEvent) => void;

class SpyWorker {
  static instances: SpyWorker[] = [];

  onmessage: Listener | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string | URL,
    readonly options?: { type?: string; name?: string },
  ) {
    SpyWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Play the worker's side: post `data` back to the page, however the host listens. */
  emit(data: unknown): void {
    const event = { data } as MessageEvent;
    this.onmessage?.(event);
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
}

/** Let the host's promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function onlyWorker(): SpyWorker {
  expect(SpyWorker.instances).toHaveLength(1);
  const worker = SpyWorker.instances[0];
  if (worker === undefined) throw new Error("no worker was built");
  return worker;
}

afterEach(() => {
  SpyWorker.instances = [];
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// the worker host
// ---------------------------------------------------------------------------------------------

describe("B37 with a Worker constructor, the host is a module worker", () => {
  it("B37 builds exactly one module Worker from practice.worker", () => {
    vi.stubGlobal("Worker", SpyWorker);
    const host = createPracticeHost();

    const worker = onlyWorker();
    expect(String(worker.url)).toMatch(/practice\.worker/);
    expect(worker.options).toMatchObject({ type: "module" });
    host.dispose();
  });

  it("B37 posts each request with an id of its own and resolves it with the worker's answer", async () => {
    vi.stubGlobal("Worker", SpyWorker);
    const host = createPracticeHost();
    const worker = onlyWorker();

    // Whether the host posts the second request at once or only after the first is answered is its
    // own business; either way each goes out as `{ id, ...body }` and gets its own answer back.
    const first = host.request({ type: "start", config: CONFIG });
    const second = host.request({ type: "debug" });
    await flush();
    expect(worker.posted[0]).toEqual({ id: expect.any(Number), type: "start", config: CONFIG });
    const a = worker.posted[0] as PracticeRequest;

    // The worker answers strictly in order, as the core does.
    const failed: PracticeResponse = { id: a.id, type: "failed", message: "deck 2 holds 3 cards" };
    worker.emit(failed);
    await expect(first).resolves.toEqual(failed);

    await flush();
    expect(worker.posted).toHaveLength(2);
    expect(worker.posted[1]).toEqual({ id: expect.any(Number), type: "debug" });
    const b = worker.posted[1] as PracticeRequest;
    expect(b.id).not.toBe(a.id);
    const alsoFailed: PracticeResponse = { id: b.id, type: "failed", message: "no game has started" };
    worker.emit(alsoFailed);
    await expect(second).resolves.toEqual(alsoFailed);
    host.dispose();
  });

  it("B37 dispose terminates the worker", () => {
    vi.stubGlobal("Worker", SpyWorker);
    const host = createPracticeHost();
    const worker = onlyWorker();
    expect(worker.terminated).toBe(false);
    host.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("B37 forceInThread builds no Worker even when one exists", async () => {
    vi.stubGlobal("Worker", SpyWorker);
    const host = createPracticeHost({ forceInThread: true, env: ENV });
    expect(SpyWorker.instances).toHaveLength(0);

    const response = await host.request({ type: "aiStep" });
    expect(response.type).toBe("failed");
    host.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// the in-thread host
// ---------------------------------------------------------------------------------------------

/** A response without its id, which is the only field the host and the direct core may differ in. */
function withoutId(response: PracticeResponse): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...response };
  delete copy.id;
  return copy;
}

/** Answers from the core itself, one request after another, for `bodies`. */
function direct(bodies: readonly PracticeRequestBody[]): PracticeResponse[] {
  const core = createPracticeCore(ENV);
  return bodies.map((body, index) => core.handle({ id: index + 1, ...body } as PracticeRequest));
}

describe("B37 without a Worker, the host answers exactly as the core does", () => {
  it("B37 with no Worker constructor it builds none and answers from this thread", async () => {
    vi.stubGlobal("Worker", undefined);
    const host = createPracticeHost({ env: ENV });
    const response = await host.request({ type: "start", config: CONFIG });
    expect(response.type).toBe("started");
    expect(SpyWorker.instances).toHaveLength(0);
    host.dispose();
  });

  it("B37 a request sequence gets the same answers, in the same order, as createPracticeCore(...).handle", { timeout: 120_000 }, async () => {
    vi.stubGlobal("Worker", undefined);

    // Found once from the core itself: p1's mulligan, kept whole (R9), so the sequence has a real
    // act and a real AI step in it.
    const probe = createPracticeCore(ENV).handle({ id: 1, type: "start", config: CONFIG });
    if (probe.type !== "started") throw new Error(`the core refused to start: ${JSON.stringify(probe)}`);
    const pending = probe.snapshot.view.pending;
    if (pending === null || !pending.forYou) throw new Error("p1 holds the first mulligan (§2.1)");
    const keep = pending.options.map((option) => option.key);

    const bodies: PracticeRequestBody[] = [
      { type: "act", action: { type: "endTurn" } }, // before start: failed
      { type: "start", config: CONFIG },
      { type: "act", action: { type: "endTurn" } }, // refused: the mulligan is open
      { type: "act", action: { type: "mulligan", keep } },
      { type: "aiStep" },
      { type: "aiStep" },
      { type: "debug" },
    ];

    const host = createPracticeHost({ forceInThread: true, env: ENV });
    const order: number[] = [];
    // Sent back to back without waiting: the host answers strictly in order.
    const answers = await Promise.all(
      bodies.map((body, index) =>
        host.request(body).then((response) => {
          order.push(index);
          return response;
        }),
      ),
    );
    host.dispose();

    expect(order).toEqual(bodies.map((_, index) => index));
    const expected = direct(bodies);
    expect(answers.map(withoutId)).toEqual(expected.map(withoutId));
    expect(new Set(answers.map((response) => response.id)).size).toBe(bodies.length);

    // The sequence is the one the comments claim, so the comparison above covers each kind.
    expect(answers.map((response) => response.type)).toEqual([
      "failed",
      "started",
      "snapshot",
      "snapshot",
      "snapshot",
      "snapshot",
      "debug",
    ]);
    const refused = answers[2];
    expect(refused?.type === "snapshot" ? refused.snapshot.error : null).toEqual(expect.any(String));
  });

  it("B37 a non-dev env passes through: debug is refused in-thread exactly as the core refuses it", async () => {
    vi.stubGlobal("Worker", undefined);
    const env: PracticeCoreEnv = { ...ENV, dev: false };
    const bodies: PracticeRequestBody[] = [{ type: "start", config: CONFIG }, { type: "debug" }];

    const host = createPracticeHost({ forceInThread: true, env });
    const answers: PracticeResponse[] = [];
    for (const body of bodies) answers.push(await host.request(body));
    host.dispose();

    const core = createPracticeCore(env);
    const expected = bodies.map((body, index) => core.handle({ id: index + 1, ...body } as PracticeRequest));
    expect(answers.map((response) => response.type)).toEqual(["started", "failed"]);
    expect(answers.map(withoutId)).toEqual(expected.map(withoutId));
  });

  it("B37 a start the core refuses is refused the same way in-thread", async () => {
    vi.stubGlobal("Worker", undefined);
    const bad: PracticeRequestBody = {
      type: "start",
      config: { ...CONFIG, deck: { kind: "saved", index: 1, cards: ["core-001"] } },
    };
    const host = createPracticeHost({ forceInThread: true, env: ENV });
    const response = await host.request(bad);
    host.dispose();

    expect(response.type).toBe("failed");
    const [expected] = direct([bad]);
    if (expected === undefined) throw new Error("the core answered nothing");
    expect(withoutId(response)).toEqual(withoutId(expected));
  });
});
