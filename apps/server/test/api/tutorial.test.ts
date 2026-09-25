/**
 * Tutorial progress on the account (`src/api/tutorial.ts`, SPEC §9.10, R320).
 *
 * The questions here are the endpoints' own: who may call them (an active account, and only about
 * itself), what a body must look like, what a write does to what is stored (a union, and the newer
 * choice), and that a time from a clock running ahead is taken as now. The merge itself is the
 * store's and is asserted against both stores in `test/db/contract.ts`; the database's half — RLS,
 * the grants and the SQL function — is `test/sql/05_tutorial_progress.sql` and
 * `02_rls_as_client.sql`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createRouter, type Router } from "../../src/api/http";
import { createTutorialRoutes, type TutorialProgressView } from "../../src/api/tutorial";
import { TUTORIAL_LESSONS_MAX, TUTORIAL_LESSON_ID_MAX_LENGTH } from "../../src/config";
import { createTestDeps, jsonRequest, readJson, type TestDeps } from "../fakes/deps";

type ProgressBody = { progress: TutorialProgressView };
type ErrorBody = { error: { code: string; message: string; details?: unknown } };

const PROFILE = "p1";
const OTHER = "p2";

let deps: TestDeps;
let router: Router;
let token: string;
let otherToken: string;

function profileWith(target: TestDeps, id: string, status: "active" | "pending" | "banned"): string {
  const userId = `user-${id}`;
  target.store.seedProfile({ id, userId, status });
  return target.auth.addUser({ userId, email: `${id}@example.test` });
}

function get(bearer = token): Promise<Response> {
  return router(jsonRequest("GET", "/api/tutorial", undefined, { token: bearer }));
}

function put(body: unknown, bearer = token): Promise<Response> {
  return router(jsonRequest("PUT", "/api/tutorial", body, { token: bearer }));
}

async function progressOf(response: Response): Promise<TutorialProgressView> {
  expect(response.status).toBe(200);
  return (await readJson<ProgressBody>(response)).progress;
}

beforeEach(() => {
  deps = createTestDeps();
  router = createRouter(createTutorialRoutes(), deps);
  token = profileWith(deps, PROFILE, "active");
  otherToken = profileWith(deps, OTHER, "active");
});

describe("R320 the routes: an active account, and only about itself", () => {
  it("R320 declares GET and PUT /api/tutorial, both `active`", () => {
    const routes = createTutorialRoutes();
    expect(routes.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /api/tutorial", "PUT /api/tutorial"]);
    expect(routes.every((entry) => entry.auth === "active")).toBe(true);
  });

  it("R320 refuses a caller with no token (401), and a pending or banned account (403), writing nothing", async () => {
    const pending = profileWith(deps, "pending", "pending");
    const banned = profileWith(deps, "banned", "banned");
    const body = { completed: ["basics"] };

    const noToken = await router(jsonRequest("PUT", "/api/tutorial", body));
    expect(noToken.status).toBe(401);
    for (const bearer of [pending, banned]) {
      expect((await get(bearer)).status).toBe(403);
      expect((await put(body, bearer)).status).toBe(403);
    }
    expect(deps.store.tables.tutorial).toEqual([]);
  });

  it("R320 reads an account with no progress yet as none, and writes land on the caller's own row only", async () => {
    expect(await progressOf(await get())).toEqual({ completed: [], hiddenChoice: null });

    // A body naming another profile changes nothing about whose row is written: the profile is the
    // verified token's, never a field of the request.
    await progressOf(await put({ completed: ["basics"], profileId: OTHER }));
    expect(await progressOf(await get())).toEqual({ completed: ["basics"], hiddenChoice: null });
    expect(await progressOf(await get(otherToken))).toEqual({ completed: [], hiddenChoice: null });
    expect(deps.store.tables.tutorial.map((row) => row.profileId)).toEqual([PROFILE]);
  });
});

describe("R320 a write merges into the account and never takes anything away", () => {
  it("R320 unions the lessons: a stale device's write removes none, and the answer is the merged progress", async () => {
    expect((await progressOf(await put({ completed: ["spells", "basics"] }))).completed).toEqual(["basics", "spells"]);
    // A device that has won only lesson 1, or nothing at all.
    expect((await progressOf(await put({ completed: ["basics"] }))).completed).toEqual(["basics", "spells"]);
    expect((await progressOf(await put({ completed: [] }))).completed).toEqual(["basics", "spells"]);
    // Another device's lesson joins them; the same write again is the same answer.
    const merged = await progressOf(await put({ completed: ["traps", "traps"] }));
    expect(merged.completed).toEqual(["basics", "spells", "traps"]);
    expect(await progressOf(await put({ completed: ["traps"] }))).toEqual(merged);
    expect(await progressOf(await get())).toEqual(merged);
  });

  it("R320 keeps the newest Hide/Show choice: Show made later is not undone by an older Hide", async () => {
    const t0 = deps.timers.now() - 60_000;
    const hide = await progressOf(await put({ completed: [], hiddenChoice: { hidden: true, at: t0 } }));
    expect(hide.hiddenChoice).toEqual({ hidden: true, at: t0 });

    const show = await progressOf(await put({ completed: [], hiddenChoice: { hidden: false, at: t0 + 30_000 } }));
    expect(show.hiddenChoice).toEqual({ hidden: false, at: t0 + 30_000 });

    // The first device, still holding its older Hide, writes again.
    const stale = await progressOf(await put({ completed: ["basics"], hiddenChoice: { hidden: true, at: t0 } }));
    expect(stale).toEqual({ completed: ["basics"], hiddenChoice: { hidden: false, at: t0 + 30_000 } });

    // A write with no choice (absent or null) leaves the stored one alone.
    expect((await progressOf(await put({ completed: [] }))).hiddenChoice).toEqual({ hidden: false, at: t0 + 30_000 });
    expect((await progressOf(await put({ completed: [], hiddenChoice: null }))).hiddenChoice).toEqual({
      hidden: false,
      at: t0 + 30_000,
    });
  });

  it("R320 takes a choice timed after the server's clock as made now, so a clock running ahead cannot pin it", async () => {
    const now = deps.timers.now();
    const ahead = await progressOf(await put({ completed: [], hiddenChoice: { hidden: true, at: now + 86_400_000 } }));
    expect(ahead.hiddenChoice).toEqual({ hidden: true, at: now });

    // A minute later, a choice from a device whose clock is right wins over it.
    deps.timers.advance(60_000);
    const later = await progressOf(await put({ completed: [], hiddenChoice: { hidden: false, at: now + 60_000 } }));
    expect(later.hiddenChoice).toEqual({ hidden: false, at: now + 60_000 });
  });
});

describe("R320 the body is checked before anything is stored", () => {
  async function refused(body: unknown): Promise<ErrorBody> {
    const response = await put(body);
    expect(response.status).toBe(400);
    return readJson<ErrorBody>(response);
  }

  it("R320 refuses a body whose lessons are not a list of lower-case slugs", async () => {
    const tooLong = "a".repeat(TUTORIAL_LESSON_ID_MAX_LENGTH + 1);
    for (const completed of [undefined, null, "basics", { basics: true }, [1], [null], [""], ["Basics"], ["a b"], ["-a"], ["a--b"], ["a-"], [tooLong]]) {
      const body = await refused(completed === undefined ? {} : { completed });
      expect(body.error.code).toBe("bad_request");
    }
    // The longest id allowed is fine.
    expect((await progressOf(await put({ completed: ["a".repeat(TUTORIAL_LESSON_ID_MAX_LENGTH)] }))).completed).toHaveLength(1);
  });

  it("R320 refuses more distinct lessons than an account holds, counting a repeat once", async () => {
    const many = Array.from({ length: TUTORIAL_LESSONS_MAX + 1 }, (_, at) => `lesson-${String(at)}`);
    expect((await refused({ completed: many })).error.message).toContain(String(TUTORIAL_LESSONS_MAX));
    const repeated = [...many.slice(0, TUTORIAL_LESSONS_MAX), ...many.slice(0, TUTORIAL_LESSONS_MAX)];
    expect((await progressOf(await put({ completed: repeated }))).completed).toHaveLength(TUTORIAL_LESSONS_MAX);
    expect(deps.store.tables.tutorial).toHaveLength(1);
  });

  it("R320 answers a union past the cap with 409 and writes nothing", async () => {
    const first = Array.from({ length: TUTORIAL_LESSONS_MAX }, (_, at) => `lesson-${String(at)}`);
    await progressOf(await put({ completed: first }));
    const response = await put({ completed: ["one-more"] });
    expect(response.status).toBe(409);
    expect((await readJson<ErrorBody>(response)).error.details).toEqual({ limit: TUTORIAL_LESSONS_MAX });
    expect((await progressOf(await get())).completed).not.toContain("one-more");
  });

  it("R320 refuses a malformed choice", async () => {
    for (const hiddenChoice of [true, "hidden", [], { hidden: "yes", at: 1 }, { hidden: true }, { hidden: true, at: -1 }, { hidden: true, at: 1.5 }, { hidden: true, at: Number.MAX_SAFE_INTEGER + 2 }]) {
      expect((await refused({ completed: [], hiddenChoice })).error.code).toBe("bad_request");
    }
    expect(deps.store.tables.tutorial).toEqual([]);
  });
});
