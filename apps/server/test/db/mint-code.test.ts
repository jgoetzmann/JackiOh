/**
 * `src/db/mint-code.ts`'s argument parsing, and the one property that makes the script worth
 * having: a code it mints hashes to what `redeemCode` will look up.
 *
 * The hash is the whole risk here. Nothing reports a pepper that is merely *different* from the
 * server's — the insert succeeds, the code prints, and it is simply never redeemable. So the
 * second `describe` mints through a fake store with the same `${CODE_PEPPER}:code` derivation
 * `src/index.ts` and `src/db/mint-code.ts` both use, then redeems the printed plaintext.
 */

import { describe, expect, it } from "vitest";

import { mintInviteCode } from "../../src/api/codes";
import { createHashes, systemIds } from "../../src/api/crypto";
import { systemTimers } from "../../src/api/ports";
import { parseMintArgs } from "../../src/db/mint-code";
import { createMemoryStore } from "../fakes/store";

describe("parseMintArgs", () => {
  it("defaults to one use and no expiry (R161)", () => {
    expect(parseMintArgs([])).toEqual({});
  });

  it("reads --max-uses and --expires-in-days", () => {
    expect(parseMintArgs(["--max-uses=5"])).toEqual({ maxUses: 5 });
    expect(parseMintArgs(["--expires-in-days=30"])).toEqual({ expiresInDays: 30 });
    expect(parseMintArgs(["--max-uses=2", "--expires-in-days=7"])).toEqual({
      maxUses: 2,
      expiresInDays: 7,
    });
  });

  it("refuses an unknown option rather than silently minting a default code", () => {
    expect(() => parseMintArgs(["--label=bring-up"])).toThrow(/Unrecognised option --label/);
    expect(() => parseMintArgs(["--max-uses"])).toThrow(/Unrecognised argument/);
    expect(() => parseMintArgs(["5"])).toThrow(/Unrecognised argument/);
  });

  /** A zero or negative `max_uses` violates `invite_codes_max_uses_positive` (migration 0001). */
  it("refuses a non-positive or fractional count", () => {
    expect(() => parseMintArgs(["--max-uses=0"])).toThrow(/positive integer/);
    expect(() => parseMintArgs(["--max-uses=-1"])).toThrow(/positive integer/);
    expect(() => parseMintArgs(["--max-uses=1.5"])).toThrow(/positive integer/);
    expect(() => parseMintArgs(["--expires-in-days=x"])).toThrow(/positive integer/);
  });
});

describe("the pepper derivation the script shares with src/index.ts", () => {
  const CODE_PEPPER = "a-pepper-of-at-least-thirty-two-characters";

  /** Exactly what `src/db/mint-code.ts` and `src/index.ts` both build. */
  function mintDeps() {
    return {
      store: createMemoryStore(),
      ids: systemIds,
      hashes: createHashes({ code: `${CODE_PEPPER}:code`, ip: `${CODE_PEPPER}:ip` }),
      timers: systemTimers,
    };
  }

  it("stores a hash that the same pepper finds again by the printed plaintext", async () => {
    const deps = mintDeps();
    const minted = await mintInviteCode(deps, { maxUses: 2 });

    const found = await deps.store.codes.findByHash(deps.hashes.code(minted.formatted));
    expect(found?.id).toBe(minted.id);
    expect(found?.maxUses).toBe(2);
  });

  /** The failure this script's `loadEnv()` call exists to prevent. */
  it("stores a hash a different pepper cannot find", async () => {
    const deps = mintDeps();
    const minted = await mintInviteCode(deps);

    const other = createHashes({ code: "a-different-pepper-of-thirty-two-plus", ip: "x" });
    expect(await deps.store.codes.findByHash(other.code(minted.formatted))).toBeNull();
  });

  /** The two domains must not collide (§9.4, §9.8). */
  it("derives an ip hash that differs from the code hash for the same input", () => {
    const { hashes } = mintDeps();
    const sample = "ABCD-EFGH-JKLM-NPQR";
    expect(hashes.ip(sample)).not.toBe(hashes.code(sample));
  });
});
