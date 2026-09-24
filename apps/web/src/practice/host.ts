// Where the practice core runs: a module Web Worker in a browser, the page's own thread in jsdom.
//
// Either way the page talks to it only through `request`, which assigns the ids and resolves each
// request with its own response, strictly in order. A worker processes its messages one at a time,
// so order comes for free there; the in-thread host chains its answers to get the same guarantee,
// and answers each on a macrotask so a test sees the same asynchrony a worker has.
//
// Only type imports reach `core.ts` from here (they are erased), so the page's bundle never holds
// the engine, the cards or the AI: the worker's bundle does, and the in-thread host loads them with
// a dynamic import when it is first asked.

import type { PracticeCore, PracticeCoreEnv } from "./core.ts";
import type { PracticeRequest, PracticeRequestBody, PracticeResponse } from "./protocol.ts";

export type PracticeHost = {
  /** Requests are answered strictly in order; ids are assigned here. */
  request(body: PracticeRequestBody): Promise<PracticeResponse>;
  dispose(): void;
};

type PracticeHostOptions = { forceInThread?: boolean; env?: Partial<PracticeCoreEnv> };

const CLOSED_MESSAGE = "the practice game was closed";

function failed(id: number, message: string): PracticeResponse {
  return { id, type: "failed", message };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function withId(body: PracticeRequestBody, id: number): PracticeRequest {
  return { ...body, id } as PracticeRequest;
}

/**
 * A module Worker (`new Worker(new URL("./practice.worker.ts", import.meta.url), { type: "module" })`)
 * when `typeof Worker === "function"` and !forceInThread; otherwise the in-thread host, which
 * dynamic-imports ./core.ts and answers each request on a macrotask (setTimeout 0).
 */
export function createPracticeHost(options: PracticeHostOptions = {}): PracticeHost {
  if (typeof Worker === "function" && options.forceInThread !== true) return createWorkerHost();
  return createInThreadHost(options.env ?? {});
}

// ---------------------------------------------------------------------------------------------
// the worker host
// ---------------------------------------------------------------------------------------------

function createWorkerHost(): PracticeHost {
  // Spelled out in full, in one expression: Vite recognises exactly this shape and bundles the
  // worker and everything it imports as a separate chunk.
  const worker = new Worker(new URL("./practice.worker.ts", import.meta.url), { type: "module" });

  let nextId = 1;
  let broken: string | null = null;
  const waiting = new Map<number, (response: PracticeResponse) => void>();

  function failAll(message: string): void {
    const entries = [...waiting.entries()];
    waiting.clear();
    for (const [id, resolve] of entries) resolve(failed(id, message));
  }

  worker.onmessage = (event: MessageEvent<PracticeResponse>) => {
    const response = event.data;
    const resolve = waiting.get(response.id);
    if (resolve === undefined) return;
    waiting.delete(response.id);
    resolve(response);
  };

  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault();
    broken = `the practice worker failed: ${event.message === "" ? "unknown error" : event.message}`;
    failAll(broken);
  };

  worker.onmessageerror = () => {
    broken = "the practice worker sent a message the page could not read";
    failAll(broken);
  };

  return {
    request(body: PracticeRequestBody): Promise<PracticeResponse> {
      const id = nextId;
      nextId += 1;
      if (broken !== null) return Promise.resolve(failed(id, broken));
      return new Promise<PracticeResponse>((resolve) => {
        waiting.set(id, resolve);
        try {
          worker.postMessage(withId(body, id));
        } catch (cause) {
          waiting.delete(id);
          resolve(failed(id, `the practice worker could not be reached: ${messageOf(cause)}`));
        }
      });
    },

    dispose(): void {
      if (broken === CLOSED_MESSAGE) return;
      broken = CLOSED_MESSAGE;
      worker.terminate();
      failAll(CLOSED_MESSAGE);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// the in-thread host (jsdom, and any browser without module workers)
// ---------------------------------------------------------------------------------------------

function macrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createInThreadHost(env: Partial<PracticeCoreEnv>): PracticeHost {
  let nextId = 1;
  let disposed = false;
  let core: Promise<PracticeCore> | null = null;
  /** The previous request's answer; each request waits for it, so answers keep their order. */
  let chain: Promise<unknown> = Promise.resolve();

  function load(): Promise<PracticeCore> {
    if (core === null) {
      core = import("./core.ts").then((mod) =>
        mod.createPracticeCore({
          now: () => performance.now(),
          dev: import.meta.env.MODE !== "production",
          ...env,
        }),
      );
      // A failed import is retried by the next request rather than cached as a failure.
      core.catch(() => {
        core = null;
      });
    }
    return core;
  }

  async function answer(request: PracticeRequest): Promise<PracticeResponse> {
    await macrotask();
    if (disposed) return failed(request.id, CLOSED_MESSAGE);
    try {
      const loaded = await load();
      if (disposed) return failed(request.id, CLOSED_MESSAGE);
      return loaded.handle(request);
    } catch (cause) {
      return failed(request.id, `the practice engine could not be loaded: ${messageOf(cause)}`);
    }
  }

  return {
    request(body: PracticeRequestBody): Promise<PracticeResponse> {
      const request = withId(body, nextId);
      nextId += 1;
      const result = chain.then(() => answer(request));
      chain = result.catch(() => undefined);
      return result;
    },

    dispose(): void {
      disposed = true;
    },
  };
}
