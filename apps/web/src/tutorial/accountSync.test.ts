// The tutorial's progress kept on the account as well as the device (tutorial/accountSync.ts): R321.
//
// The account is a fake `TutorialAccountApi` that merges as the server does (a union of lessons and
// the strictly newer choice, R320), so these tests read what the device and the account hold after
// each step. The device is the real progress store over jsdom's localStorage.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TutorialAccountProgress } from "../net/api.ts";
import type { Account } from "../net/gate.ts";
import {
  startTutorialAccountSync,
  tutorialAccountApi,
  useTutorialAccountSync,
  type TutorialAccountApi,
  type TutorialAccountSync,
} from "./accountSync.ts";
import { TUTORIAL_PROGRESS_KEY } from "./config.ts";
import { TUTORIAL_LESSONS, type TutorialLesson } from "./lessons.ts";
import {
  __resetTutorialProgressForTests,
  isTutorialHidden,
  markLessonComplete,
  readTutorialProgress,
  setTutorialHidden,
} from "./progress.ts";

function lesson(number: number): TutorialLesson {
  const found = TUTORIAL_LESSONS.find((candidate) => candidate.number === number);
  if (found === undefined) throw new Error(`no lesson ${String(number)}`);
  return found;
}

const [ONE, TWO, THREE] = [lesson(1).id, lesson(2).id, lesson(3).id];

/** The account, merging as `PUT /api/tutorial` does (R320). */
type FakeAccount = TutorialAccountApi & {
  stored: TutorialAccountProgress;
  loads: string[];
  saves: { token: string; body: TutorialAccountProgress }[];
  /** Makes every request fail at the network until set back to false. */
  offline: boolean;
};

function fakeAccount(initial: Partial<TutorialAccountProgress> = {}): FakeAccount {
  const account: FakeAccount = {
    stored: { completed: [...(initial.completed ?? [])].sort(), hiddenChoice: initial.hiddenChoice ?? null },
    loads: [],
    saves: [],
    offline: false,
    load: vi.fn(async (token: string) => {
      account.loads.push(token);
      if (account.offline) throw new TypeError("Failed to fetch");
      return structuredClone(account.stored);
    }),
    save: vi.fn(async (token: string, body: TutorialAccountProgress) => {
      account.saves.push({ token, body: structuredClone(body) });
      if (account.offline) throw new TypeError("Failed to fetch");
      const stored = account.stored;
      const incoming = body.hiddenChoice;
      account.stored = {
        completed: [...new Set([...stored.completed, ...body.completed])].sort(),
        hiddenChoice:
          incoming !== null && (stored.hiddenChoice === null || incoming.at > stored.hiddenChoice.at)
            ? incoming
            : stored.hiddenChoice,
      };
      return structuredClone(account.stored);
    }),
  };
  return account;
}

const running: TutorialAccountSync[] = [];

function start(account: FakeAccount, token = "tok-1"): TutorialAccountSync {
  const sync = startTutorialAccountSync({ token: () => token, api: account });
  running.push(sync);
  return sync;
}

function activeAccount(status: "active" | "pending" | "banned" = "active", id = "u1"): Account {
  return {
    kind: "ready",
    token: `tok-${id}`,
    me: {
      profile: { id, status, rating: 1000 },
      needsInviteCode: status === "pending",
      emailVerified: true,
      currentMatchId: null,
      email: `${id}@example.com`,
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetTutorialProgressForTests();
});

afterEach(() => {
  for (const sync of running.splice(0)) sync.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  __resetTutorialProgressForTests();
});

describe("R321 the device's copy and the account's are merged, and neither steps backwards", () => {
  it("R321 on load the account's lessons join the device's, and the device's the account lacks go up merged", async () => {
    markLessonComplete(ONE);
    const account = fakeAccount({ completed: [TWO] });

    await start(account).settled();

    expect(account.loads).toEqual(["tok-1"]);
    // The device now holds both, and sent both up: the merged value, not only what it had.
    expect(readTutorialProgress().completed).toEqual([ONE, TWO]);
    expect(account.saves.map((save) => save.body.completed)).toEqual([[ONE, TWO]]);
    expect(account.stored.completed).toEqual([ONE, TWO].sort());
  });

  it("R321 on load nothing is sent when the account already has everything the device has", async () => {
    markLessonComplete(ONE);
    const account = fakeAccount({ completed: [ONE, TWO] });

    await start(account).settled();

    expect(account.saves).toEqual([]);
    expect(readTutorialProgress().completed).toEqual([ONE, TWO]);
  });

  it("R321 an account that lags the device never takes a lesson away, and an unknown id is ignored", async () => {
    for (const id of [ONE, TWO, THREE]) markLessonComplete(id);
    const account = fakeAccount({ completed: [ONE, "a-lesson-this-client-does-not-have"] });

    await start(account).settled();

    expect(readTutorialProgress().completed).toEqual([ONE, TWO, THREE]);
    expect(account.stored.completed).toEqual([ONE, THREE, TWO, "a-lesson-this-client-does-not-have"].sort());
  });

  it("R321 a lesson won afterwards, and a Hide or Show, is written to the account as it happens", async () => {
    const account = fakeAccount();
    const sync = start(account);
    await sync.settled();
    expect(account.saves).toEqual([]);

    markLessonComplete(ONE);
    await sync.settled();
    expect(account.stored.completed).toEqual([ONE]);

    setTutorialHidden(true, 5_000);
    await sync.settled();
    expect(account.stored.hiddenChoice).toEqual({ hidden: true, at: 5_000 });

    setTutorialHidden(false, 9_000);
    await sync.settled();
    expect(account.stored.hiddenChoice).toEqual({ hidden: false, at: 9_000 });
    expect(account.saves).toHaveLength(3);
  });

  it("R321 the newest choice wins: Show here is not undone by an older Hide on the account", async () => {
    setTutorialHidden(false, 20_000);
    const account = fakeAccount({ hiddenChoice: { hidden: true, at: 10_000 } });

    await start(account).settled();

    expect(isTutorialHidden(readTutorialProgress())).toBe(false);
    expect(readTutorialProgress().hiddenChoice).toEqual({ hidden: false, at: 20_000 });
    // The device's newer Show went up, so the next device to load sees it too.
    expect(account.stored.hiddenChoice).toEqual({ hidden: false, at: 20_000 });
  });

  it("R321 the newest choice wins: a Hide made later on another device hides the path here", async () => {
    setTutorialHidden(false, 10_000);
    const account = fakeAccount({ hiddenChoice: { hidden: true, at: 30_000 } });

    await start(account).settled();

    expect(isTutorialHidden(readTutorialProgress())).toBe(true);
    expect(readTutorialProgress().hiddenChoice).toEqual({ hidden: true, at: 30_000 });
    expect(account.saves).toEqual([]);
  });

  it("R321 a choice the server took as made now (the device's clock ran ahead) is not sent again and again", async () => {
    setTutorialHidden(true, 99_000);
    const account = fakeAccount();
    // The server clamps a choice timed after its own clock (R320): it keeps the value, not the time.
    account.save = vi.fn(async (_token: string, body: TutorialAccountProgress) => {
      account.stored = {
        completed: [...body.completed],
        hiddenChoice: body.hiddenChoice === null ? null : { hidden: body.hiddenChoice.hidden, at: 1_000 },
      };
      return structuredClone(account.stored);
    });

    const sync = start(account);
    await sync.settled();
    markLessonComplete(ONE);
    await sync.settled();

    // One write for the load, one for the lesson: the clamped time never counts as "lacking".
    expect(account.save).toHaveBeenCalledTimes(2);
    expect(isTutorialHidden(readTutorialProgress())).toBe(true);
  });
});

describe("R321 the network never blocks the tutorial", () => {
  it("R321 an account that cannot be reached changes nothing on the device and throws nothing; the next load catches up", async () => {
    markLessonComplete(ONE);
    const account = fakeAccount({ completed: [TWO] });
    account.offline = true;

    const sync = start(account);
    await expect(sync.settled()).resolves.toBeUndefined();
    expect(readTutorialProgress().completed).toEqual([ONE]);

    // Still offline: a lesson won now is kept on the device, and the failed write is dropped.
    markLessonComplete(THREE);
    await expect(sync.settled()).resolves.toBeUndefined();
    expect(readTutorialProgress().completed).toEqual([ONE, THREE]);
    expect(account.stored.completed).toEqual([TWO]);
    sync.stop();

    // The next visit, online: both copies end with all three.
    account.offline = false;
    await start(account).settled();
    expect(readTutorialProgress().completed).toEqual([ONE, TWO, THREE]);
    expect(account.stored.completed).toEqual([ONE, TWO, THREE].sort());
  });

  it("R321 an answer that is not tutorial progress is dropped like a failure", async () => {
    markLessonComplete(ONE);
    const account = fakeAccount();
    account.load = vi.fn(async () => ({ completed: "everything" }) as unknown as TutorialAccountProgress);

    await expect(start(account).settled()).resolves.toBeUndefined();
    expect(readTutorialProgress().completed).toEqual([ONE]);
  });

  it("R321 one request at a time: changes made while one is out go up together once it answers", async () => {
    const account = fakeAccount();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = account.load;
    account.load = vi.fn(async (token: string) => {
      await gate;
      return load(token);
    });

    const sync = start(account);
    markLessonComplete(ONE);
    markLessonComplete(TWO);
    expect(account.saves).toEqual([]);
    release();
    await sync.settled();

    expect(account.saves.map((save) => save.body.completed)).toEqual([[ONE, TWO]]);
  });

  it("R321 a stopped sync ignores the answer in flight and sends nothing more", async () => {
    const account = fakeAccount({ completed: [TWO] });
    const sync = start(account);
    sync.stop();
    await sync.settled();
    markLessonComplete(ONE);
    await sync.settled();

    expect(readTutorialProgress().completed).toEqual([ONE]);
    expect(account.saves).toEqual([]);
  });
});

describe("R321 only an active signed-in account is synced", () => {
  it("R321 signed out, pending or banned: nothing is requested, and progress stays on the device", async () => {
    const account = fakeAccount({ completed: [TWO] });
    for (const signedOut of [{ kind: "anonymous" }, { kind: "loading" }, { kind: "error", message: "x" }] as Account[]) {
      const { unmount } = renderHook(() => {
        useTutorialAccountSync(signedOut, account);
      });
      unmount();
    }
    for (const status of ["pending", "banned"] as const) {
      const { unmount } = renderHook(() => {
        useTutorialAccountSync(activeAccount(status), account);
      });
      unmount();
    }
    markLessonComplete(ONE);
    await act(async () => {
      await Promise.resolve();
    });

    expect(account.load).not.toHaveBeenCalled();
    expect(account.save).not.toHaveBeenCalled();
    expect(readTutorialProgress().completed).toEqual([ONE]);
  });

  it("R321 an active account is loaded once with its token, and a sign-out stops the sync", async () => {
    const account = fakeAccount({ completed: [TWO] });
    let current: Account = activeAccount("active");
    const { rerender } = renderHook(() => {
      useTutorialAccountSync(current, account);
    });
    await vi.waitFor(() => {
      expect(readTutorialProgress().completed).toEqual([TWO]);
    });
    expect(account.loads).toEqual(["tok-u1"]);

    current = { kind: "anonymous" };
    rerender();
    markLessonComplete(ONE);
    await act(async () => {
      await Promise.resolve();
    });
    expect(account.save).not.toHaveBeenCalled();
    expect(account.load).toHaveBeenCalledTimes(1);
  });

  it("R321 the requests are GET and PUT /api/tutorial with the bearer token and the device's progress", async () => {
    const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        const body = typeof init.body === "string" ? (JSON.parse(init.body) as TutorialAccountProgress) : null;
        calls.push({ url, method: init.method ?? "GET", auth: headers.get("authorization"), body });
        // The account holds lesson 1; a PUT answers with the merge, as the server does.
        const progress: TutorialAccountProgress =
          body === null
            ? { completed: [ONE], hiddenChoice: null }
            : { completed: [...new Set([ONE, ...body.completed])], hiddenChoice: body.hiddenChoice };
        return new Response(JSON.stringify({ progress }), { status: 200 });
      }),
    );
    setTutorialHidden(true, 7_000);

    await start(fakeAccountFrom(tutorialAccountApi), "tok-real").settled();

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/tutorial",
      "PUT /api/tutorial",
    ]);
    expect(calls.every((call) => call.auth === "Bearer tok-real")).toBe(true);
    expect(calls[1]?.body).toEqual({ completed: [ONE], hiddenChoice: { hidden: true, at: 7_000 } });
  });

  it("R321 nothing on the device is written by a load that brings nothing new", async () => {
    markLessonComplete(ONE);
    const before = window.localStorage.getItem(TUTORIAL_PROGRESS_KEY);
    const snapshot = readTutorialProgress();
    await start(fakeAccount({ completed: [ONE] })).settled();
    expect(readTutorialProgress()).toBe(snapshot);
    expect(window.localStorage.getItem(TUTORIAL_PROGRESS_KEY)).toBe(before);
  });
});

/** The real requests, as a `FakeAccount`-shaped value for `start` (nothing fake about them). */
function fakeAccountFrom(api: TutorialAccountApi): FakeAccount {
  return { ...api, stored: { completed: [], hiddenChoice: null }, loads: [], saves: [], offline: false };
}
