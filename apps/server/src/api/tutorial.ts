/**
 * Tutorial progress on the account (SPEC §9.10, R320).
 *
 * The device keeps which lessons a player has won, and whether they hid the lesson path, in
 * `localStorage` (R294). An active account keeps the same on the server too, so a player who signs
 * in on another device finds them there, and the client merges the two copies (R321). This file is
 * the account's half: two routes, both `active` (a pending account has the code screen and nothing
 * else, §9.4), both keyed on the profile the verified token names and never on anything in the body.
 *
 *   GET /api/tutorial  -> { progress: { completed, hiddenChoice } }
 *   PUT /api/tutorial  <- { completed: string[], hiddenChoice?: { hidden, at } | null }
 *                      -> { progress } as it stands after the merge
 *
 * A PUT merges and never replaces (R320): the account's lessons become the union of the stored and
 * the sent, so a stale device can never remove a completed lesson, and its Hide/Show choice is
 * replaced only by a strictly newer one. The same body sent twice changes nothing, so a client may
 * retry it freely. The merge is the store's (`app.merge_tutorial_progress`, migration 0011), under a
 * lock on the profile, so two devices writing at once cannot lose each other's lesson.
 *
 * The server does not know the lessons: they are the client's (`apps/web/src/tutorial/lessons.ts`),
 * and a lesson added there needs no change here. So an id is checked for its shape only — a
 * lower-case slug of at most `TUTORIAL_LESSON_ID_MAX_LENGTH` characters — and an account holds at
 * most `TUTORIAL_LESSONS_MAX`. None of this is a rule: a lesson is a practice game and records no
 * result (R187), and nothing the server does reads this row.
 */

import { TUTORIAL_LESSONS_MAX, TUTORIAL_LESSON_ID_MAX_LENGTH } from "../config";
import { callerProfile } from "./collection";
import { ApiError, badRequest, ok, route, type Route } from "./http";
import type { TutorialHiddenChoice, TutorialProgressRow } from "./ports";

/** R320: a lesson id is a lower-case slug (`basics`, `first-steps`). */
const LESSON_ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** What the client reads: `TutorialAccountProgress` in `apps/web/src/net/api.ts`. */
export type TutorialProgressView = {
  completed: string[];
  hiddenChoice: TutorialHiddenChoice | null;
};

function progressView(row: TutorialProgressRow | null): TutorialProgressView {
  if (row === null) return { completed: [], hiddenChoice: null };
  return {
    completed: [...row.completed],
    hiddenChoice: row.hiddenChoice === null ? null : { hidden: row.hiddenChoice.hidden, at: row.hiddenChoice.at },
  };
}

/**
 * R320: `completed` is a list of lesson-id slugs, each at most `TUTORIAL_LESSON_ID_MAX_LENGTH`
 * characters; a repeated id counts once, and at most `TUTORIAL_LESSONS_MAX` distinct ids are taken.
 */
export function readCompleted(body: Readonly<Record<string, unknown>>): string[] {
  const value = body["completed"];
  if (!Array.isArray(value)) throw badRequest('"completed" must be a list of lesson ids');
  const ids = new Set<string>();
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || entry.length > TUTORIAL_LESSON_ID_MAX_LENGTH || !LESSON_ID_SHAPE.test(entry)) {
      throw badRequest(
        `every lesson id must be a lower-case slug of at most ${String(TUTORIAL_LESSON_ID_MAX_LENGTH)} characters`,
      );
    }
    ids.add(entry);
  }
  if (ids.size > TUTORIAL_LESSONS_MAX) {
    throw badRequest(`at most ${String(TUTORIAL_LESSONS_MAX)} lessons can be recorded`);
  }
  return [...ids];
}

/**
 * R320, R321: `hiddenChoice` is absent or null (no choice to propose), or `{ hidden, at }` with `at`
 * a whole number of epoch milliseconds, the choosing device's clock. A time after the server's own
 * is taken as now: a device whose clock runs ahead could otherwise make its choice win over every
 * later one for as long as its clock stays ahead.
 */
export function readHiddenChoice(body: Readonly<Record<string, unknown>>, now: number): TutorialHiddenChoice | null {
  const value = body["hiddenChoice"];
  if (value === undefined || value === null) return null;
  const bad = badRequest('"hiddenChoice" must be null or { hidden: boolean, at: epoch milliseconds }');
  if (typeof value !== "object" || Array.isArray(value)) throw bad;
  const { hidden, at } = value as { hidden?: unknown; at?: unknown };
  if (typeof hidden !== "boolean" || typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) throw bad;
  return { hidden, at: Math.min(at, now) };
}

/** `GET` and `PUT /api/tutorial`. Both `active`, so a pending account gets 403 from each (§9.4). */
export function createTutorialRoutes(): Route[] {
  return [
    route("GET", "/api/tutorial", "active", async (req, deps) => {
      const profile = callerProfile(req);
      return ok({ progress: progressView(await deps.store.tutorial.get(profile.id)) });
    }),

    route("PUT", "/api/tutorial", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const now = deps.timers.now();
      const completed = readCompleted(req.body);
      const hiddenChoice = readHiddenChoice(req.body, now);

      const outcome = await deps.store.tutorial.merge(
        { profileId: profile.id, completed, hiddenChoice, at: now },
        TUTORIAL_LESSONS_MAX,
      );
      if (outcome.kind === "limit") {
        throw new ApiError(
          "conflict",
          `This account already records ${String(TUTORIAL_LESSONS_MAX)} lessons, the most it can hold.`,
          { limit: TUTORIAL_LESSONS_MAX },
        );
      }
      deps.log.info("tutorial.merged", {
        profileId: profile.id,
        sent: completed.length,
        completed: outcome.progress.completed.length,
        choice: hiddenChoice !== null,
      });
      return ok({ progress: progressView(outcome.progress) });
    }),
  ];
}
