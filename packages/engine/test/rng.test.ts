import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRng } from "../src/rng";

const childScript = fileURLToPath(new URL("./fixtures/rng-child.ts", import.meta.url));

function childDraws(seed: string, cursor: number, count: number): { draws: number[]; cursor: number } {
  const out = execFileSync(process.execPath, [childScript, seed, String(cursor), String(count)], {
    encoding: "utf8",
  });
  return JSON.parse(out) as { draws: number[]; cursor: number };
}

describe("seeded rng (M1-T2)", () => {
  it("is deterministic for a seed and advances its cursor", () => {
    const a = createRng("seed-a");
    const b = createRng("seed-a");
    expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
    expect(a.cursor).toBe(3);
  });

  it("different seeds give different sequences", () => {
    expect(createRng("seed-a").next()).not.toBe(createRng("seed-b").next());
  });

  it("resumes from a serialized cursor in another process", () => {
    const local = createRng("match-7");
    const first = [local.next(), local.next()];
    const resumed = createRng("match-7", local.cursor);
    const rest = [resumed.next(), resumed.next()];

    const child = childDraws("match-7", 0, 4);
    expect(child.draws).toEqual([...first, ...rest]);
    expect(child.cursor).toBe(4);

    const childResumed = childDraws("match-7", 2, 2);
    expect(childResumed.draws).toEqual(rest);
  });

  it("int stays in range and pick handles an empty list", () => {
    const rng = createRng("ints");
    for (let i = 0; i < 200; i += 1) {
      const n = rng.int(5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
    }
    expect(rng.int(0)).toBe(0);
    expect(rng.pick([])).toBeUndefined();
    expect(rng.pick(["only"])).toBe("only");
  });

  it("shuffle keeps every element and depends only on seed and cursor", () => {
    const list = [1, 2, 3, 4, 5, 6, 7, 8];
    const once = createRng("shuf").shuffle(list);
    const again = createRng("shuf").shuffle(list);
    expect(once).toEqual(again);
    expect([...once].sort((a, b) => a - b)).toEqual(list);
    expect(once).not.toEqual(list);
  });

  it("coin and chance sit near their probabilities", () => {
    const rng = createRng("coins");
    let heads = 0;
    for (let i = 0; i < 2000; i += 1) if (rng.coin()) heads += 1;
    expect(heads).toBeGreaterThan(900);
    expect(heads).toBeLessThan(1100);

    const rng2 = createRng("chance");
    let hits = 0;
    for (let i = 0; i < 2000; i += 1) if (rng2.chance(0.3)) hits += 1;
    expect(hits).toBeGreaterThan(500);
    expect(hits).toBeLessThan(700);
    expect(createRng("never").chance(0)).toBe(false);
    expect(createRng("always").chance(1)).toBe(true);
  });

  it("lucky 1 rolls twice and keeps the better result; lucky 0 rolls once", () => {
    const rng = createRng("lucky");
    let calls = 0;
    const roll = (): number => {
      calls += 1;
      return calls === 1 ? 3 : 9;
    };
    const better = (a: number, b: number): number => Math.max(a, b);

    expect(rng.lucky(1, roll, better)).toBe(9);
    expect(calls).toBe(2);

    calls = 0;
    expect(rng.lucky(0, roll, better)).toBe(3);
    expect(calls).toBe(1);

    calls = 0;
    rng.lucky(3, roll, better);
    expect(calls).toBe(4);
  });
});
