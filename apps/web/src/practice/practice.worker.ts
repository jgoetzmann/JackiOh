// The practice worker's entry (SPEC §9.9, R187). It owns the one practice `GameState` and answers
// each request with `core.handle`, which never throws. `host.ts` spawns it as a module worker.
//
// `self` is typed with a local minimal interface rather than the `WebWorker` lib, which would clash
// with the `DOM` lib the rest of `apps/web` compiles against.

import { createPracticeCore } from "./core.ts";
import type { PracticeRequest, PracticeResponse } from "./protocol.ts";

type PracticeWorkerScope = {
  onmessage: ((event: MessageEvent<PracticeRequest>) => void) | null;
  postMessage(message: PracticeResponse): void;
};

const scope = self as unknown as PracticeWorkerScope;

const core = createPracticeCore({
  now: () => performance.now(),
  dev: import.meta.env.MODE !== "production",
});

scope.onmessage = (event) => {
  scope.postMessage(core.handle(event.data));
};
