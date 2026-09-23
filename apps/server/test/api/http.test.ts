/**
 * SPEC §11 R173 — the request body limit, enforced in `readBody` (`src/api/http.ts`), which every
 * route's body goes through.
 *
 * Proved on the two routes that take card lists, where it matters: the validator reports one issue
 * per bad card id, so an unbounded list came back many times larger than it went out. The number
 * under test is the server's own `floodLimits.requestBodyBytes`, never restated, and it is counted
 * in bytes actually read: not UTF-16 code units, and not whatever Content-Length claims.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { floodLimits } from "../../src/api/deps";
import { createDeckRoutes } from "../../src/api/decks";
import { createRouter, type Router } from "../../src/api/http";
import { createLoadoutRoutes } from "../../src/api/loadouts";
import { createTestDeps, readJson, type TestDeps } from "../fakes/deps";

const LIMIT = floodLimits.requestBodyBytes;

type ErrorBody = { error: { code: string; message: string } };

let deps: TestDeps;
let router: Router;
let token: string;
/** Every call either validator gets, so a refusal can be shown to come before it. */
let validated: number;

beforeEach(() => {
  validated = 0;
  const counting = (): [] => {
    validated += 1;
    return [];
  };
  deps = createTestDeps({ validateDeck: counting, validateLoadout: counting });
  router = createRouter([...createDeckRoutes(), ...createLoadoutRoutes()], deps);
  deps.store.seedProfile({ id: "me", userId: "user-me", status: "active" });
  token = deps.auth.addUser({ userId: "user-me", email: "me@example.test" });
});

const bytesOf = (text: string): number => new TextEncoder().encode(text).byteLength;

/** A raw body, sent with no Content-Length unless `headers` declares one. */
function send(
  method: string,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return router(
    new Request(`https://server.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      body,
    }),
  );
}

/** A legal library-deck save whose JSON is exactly `bytes` long, padded with `fill`. */
function deckSaveOf(bytes: number, fill = "x"): string {
  const draft = { catalogVersion: deps.catalog.version, name: "Padded", cards: [] };
  const base = JSON.stringify({ ...draft, pad: "" });
  const room = bytes - bytesOf(base);
  const pad = fill.repeat(Math.floor(room / bytesOf(fill))) + "x".repeat(room % bytesOf(fill));
  const body = JSON.stringify({ ...draft, pad });
  expect(bytesOf(body)).toBe(bytes);
  return body;
}

async function expectTooLarge(response: Response): Promise<void> {
  expect(response.status).toBe(413);
  const body = await readJson<ErrorBody>(response);
  expect(body.error.code).toBe("payload_too_large");
  expect(body.error.message).toContain(String(LIMIT));
}

describe("R173 — the request body limit", () => {
  it("R173 refuses a body over the limit with 413 on a deck save and a loadout save, before the validator or the store", async () => {
    const junk = Array.from({ length: LIMIT / 8 }, (_, i) => `junk-${String(i)}`);
    const version = deps.catalog.version;
    for (const [method, path, body] of [
      ["POST", "/api/decks", JSON.stringify({ catalogVersion: version, name: "Big", cards: junk })],
      ["PUT", "/api/loadout", JSON.stringify({ catalogVersion: version, decks: [junk, [], []] })],
    ] as const) {
      // PREMISE: over the limit, and sent with no Content-Length, so only the bytes read catch it.
      expect(bytesOf(body)).toBeGreaterThan(LIMIT);
      await expectTooLarge(await send(method, path, body));
    }
    expect(validated).toBe(0);
    expect(deps.store.tables.decks).toEqual([]);
    expect(deps.store.tables.loadouts).toEqual([]);
  });

  it("R173 reads a body of exactly the limit, and counts it in bytes, not UTF-16 code units", async () => {
    const atLimit = await send("POST", "/api/decks", deckSaveOf(LIMIT, "é"));
    expect(atLimit.status).toBe(200);
    expect(validated).toBe(1);
    expect(deps.store.tables.decks).toHaveLength(1);

    // Two bytes per "é" but one code unit: a `.length` check would let this through.
    const overByOne = deckSaveOf(LIMIT + 1, "é");
    expect(overByOne.length).toBeLessThan(LIMIT);
    await expectTooLarge(await send("POST", "/api/decks", overByOne));
    expect(validated).toBe(1);
  });

  it("R173 is not bypassed by a lying Content-Length, and refuses a declared oversize without reading it", async () => {
    const over = deckSaveOf(LIMIT + 1);
    await expectTooLarge(await send("POST", "/api/decks", over, { "content-length": "2" }));

    const small = deckSaveOf(LIMIT - 1);
    const declared = { "content-length": String(LIMIT + 1) };
    await expectTooLarge(await send("POST", "/api/decks", small, declared));

    expect(validated).toBe(0);
    expect(deps.store.tables.decks).toEqual([]);
  });
});
