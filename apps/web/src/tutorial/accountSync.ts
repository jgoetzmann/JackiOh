// Tutorial progress kept on the account as well as on the device (SPEC §9.10, R320, R321).
//
// The device's copy (`progress.ts`, R294) is the one the page renders, and it stays authoritative
// for the session: nothing here ever waits on the network before the path, a lesson or its result
// can show, and no failure reaches the UI. For an ACTIVE account (a pending one has only the code
// screen, §9.4, and the routes answer it 403), this module keeps the account's copy level with it:
//
//   1. On load, it reads the account's copy (`GET /api/tutorial`) and merges it into the device
//      (`adoptTutorialProgress`): the union of completed lessons, and the newer Hide/Show choice.
//      If the device then holds something the account lacks — lessons won while signed out, a
//      newer choice — it sends its progress up (`PUT /api/tutorial`), which the server merges too.
//   2. After that, every change on the device (a lesson won, Hide or Show, another tab's change)
//      is sent up if the account lacks it, and the server's answer is merged back in.
//
// Both merges are unions, so neither side ever steps backwards (R321): a completed lesson never
// becomes uncompleted, and an older choice never undoes a newer one. A request that fails, or
// never answers, is dropped: the device keeps what it has, and the next load catches the account
// up. At most one request is in flight; changes made meanwhile are sent together once it answers.
//
// Signed out, there is no account to sync, so nothing is sent at all (R294 still holds for every
// visitor without an active account).

import { useEffect, useRef } from "react";

import { getTutorialProgress, putTutorialProgress, type TutorialAccountProgress } from "../net/api.ts";
import type { Account } from "../net/gate.ts";
import {
  accountLacks,
  adoptTutorialProgress,
  readTutorialProgress,
  subscribeTutorialProgress,
  type TutorialProgressLike,
} from "./progress.ts";

/** The two requests, injectable so the route's tests never touch the network. */
export type TutorialAccountApi = {
  load(token: string): Promise<TutorialAccountProgress>;
  save(token: string, progress: TutorialAccountProgress): Promise<TutorialAccountProgress>;
};

export const tutorialAccountApi: TutorialAccountApi = {
  load: getTutorialProgress,
  save: putTutorialProgress,
};

export type TutorialAccountSync = {
  /** Stop listening; an answer still in flight is ignored. */
  stop(): void;
  /** Resolves once no request is in flight or owed (tests; nothing in the app waits on it). */
  settled(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The server's answer, read as untrusted input: a list of strings and a well-formed choice, or it
 * is not an answer at all (thrown, and dropped like a network failure).
 */
function accountCopy(raw: unknown): TutorialProgressLike {
  if (!isRecord(raw) || !Array.isArray(raw.completed)) throw new Error("not a tutorial progress answer");
  const completed = (raw.completed as unknown[]).filter((id): id is string => typeof id === "string");
  const choice = raw.hiddenChoice;
  if (choice === null || choice === undefined) return { completed, hiddenChoice: null };
  if (!isRecord(choice) || typeof choice.hidden !== "boolean" || typeof choice.at !== "number") {
    throw new Error("not a tutorial progress answer");
  }
  return { completed, hiddenChoice: { hidden: choice.hidden, at: choice.at } };
}

/**
 * Starts syncing this device's tutorial progress with the account `token()` names. `token` is read
 * at each request, so a renewed session's token is the one used.
 */
export function startTutorialAccountSync(options: {
  token: () => string;
  api: TutorialAccountApi;
}): TutorialAccountSync {
  let stopped = false;
  /** The account's copy as last read or answered; null until the first answer. */
  let known: TutorialProgressLike | null = null;
  let running: Promise<void> | null = null;
  let owed = false;

  const take = (answer: unknown): void => {
    const copy = accountCopy(answer);
    if (stopped) return;
    known = copy;
    adoptTutorialProgress(copy);
  };

  /** One PUT, if the device holds something the account (as far as this page knows) lacks. */
  const sendIfLacking = async (): Promise<void> => {
    const device = readTutorialProgress();
    if (known === null ? device.completed.length === 0 && device.hiddenChoice === null : !accountLacks(known, device)) {
      return;
    }
    take(
      await options.api.save(options.token(), {
        completed: [...device.completed],
        hiddenChoice: device.hiddenChoice === null ? null : { ...device.hiddenChoice },
      }),
    );
  };

  /** Runs `first`, then sends again for as long as a change arrived meanwhile. Never rejects. */
  const run = (first: () => Promise<void>): void => {
    running = (async () => {
      try {
        await first();
      } catch {
        // R321: offline, a server error or an answer that is not one. The device keeps what it
        // has, and the account catches up on the next load.
      }
      while (owed && !stopped) {
        owed = false;
        try {
          await sendIfLacking();
        } catch {
          // As above.
        }
      }
    })().finally(() => {
      running = null;
    });
  };

  const onDeviceChange = (): void => {
    if (stopped) return;
    if (running !== null) {
      owed = true;
      return;
    }
    run(sendIfLacking);
  };

  const unsubscribe = subscribeTutorialProgress(onDeviceChange);

  // The first load: read, merge in, and send up what the account lacks.
  run(async () => {
    take(await options.api.load(options.token()));
    if (!stopped) await sendIfLacking();
  });

  return {
    stop: () => {
      stopped = true;
      owed = false;
      unsubscribe();
    },
    settled: async () => {
      while (running !== null) await running;
    },
  };
}

/**
 * R321 for a page: syncs while `account` is an active signed-in account, and does nothing (sends
 * nothing) otherwise. Restarts when the account changes to another profile; a renewed token for the
 * same profile is simply used for the next request.
 */
export function useTutorialAccountSync(account: Account, api: TutorialAccountApi = tutorialAccountApi): void {
  const active = account.kind === "ready" && account.me.profile.status === "active";
  const profileId = active ? account.me.profile.id : null;
  const token = useRef<string>("");
  token.current = active ? account.token : "";
  const requests = useRef(api);
  requests.current = api;

  useEffect(() => {
    if (profileId === null) return;
    const sync = startTutorialAccountSync({
      token: () => token.current,
      api: {
        load: (bearer) => requests.current.load(bearer),
        save: (bearer, progress) => requests.current.save(bearer, progress),
      },
    });
    return () => {
      sync.stop();
    };
  }, [profileId]);
}
