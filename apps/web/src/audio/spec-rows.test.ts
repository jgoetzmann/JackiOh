// Polish task 2 (docs/polish/2-sound.md), behaviour B40: the SPEC rows this task adds, and the
// rulings index that points at their proofs.
//
//   B40  SPEC §11 carries R203 and R204, `packages/engine/test/rulings.test.ts` indexes both in
//        order and proves them in `apps/web/src/audio/cues.test.ts` (and, for R203,
//        `director.test.ts`), and `pnpm rulings:coverage` exits 0.
//
// The index test and the coverage script are the real gate; this file pins that task 2's rows are
// wired into them, so a merge that drops a row or re-points a proof fails here by name. It also
// checks the design's placement of the new §10.11 Audio section.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const SPEC_PATH = join(REPO, "SPEC.md");
const INDEX_DIR = join(REPO, "packages/engine/test");
const INDEX_PATH = join(INDEX_DIR, "rulings.test.ts");
const COVERAGE_SCRIPT = join(REPO, "packages/engine/scripts/rulings-coverage.ts");
const TSX_CLI = join(REPO, "node_modules/tsx/dist/cli.mjs");
const COVERAGE_TIMEOUT_MS = 60_000;

const read = (path: string): string => readFileSync(path, "utf8");

/** §11's rows, in document order: the only lines that start `| R<n> |`. */
function specRows(): number[] {
  return [...read(SPEC_PATH).matchAll(/^\| R(\d+) \|/gm)].map((match) => Number(match[1]));
}

/** The constant names an index row hands `provenIn`, e.g. ["WEB_AUDIO_CUES_TEST"]. */
function indexProofs(index: string, row: number): string[] | null {
  const found = new RegExp(`\\bit\\(\\s*"R${String(row)}\\b[^"]*",\\s*\\(\\)\\s*=>\\s*\\{\\s*provenIn\\(${String(row)},([^)]*)\\)`).exec(index);
  if (found === null) return null;
  return (found[1] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
}

/** Where a path constant in the index points, resolved the way `rulings.test.ts` resolves it. */
function indexConstant(index: string, name: string): string | null {
  const found = new RegExp(`\\bconst ${name} = "([^"]+)"`).exec(index);
  return found === null ? null : resolve(INDEX_DIR, found[1] ?? "");
}

function hasTestNamed(file: string, row: number): boolean {
  return new RegExp(`\\bit\\(\\s*"R${String(row)}\\b`).test(read(file));
}

describe("B40 SPEC §11 rows R203 and R204", () => {
  it("B40 SPEC §11 carries R203 and R204, in numeric position", () => {
    const rows = specRows();

    expect(rows).toContain(203);
    expect(rows).toContain(204);
    expect(rows.indexOf(203)).toBeLessThan(rows.indexOf(204));
    expect(rows, "§11 rows must stay in ascending order").toEqual([...rows].sort((a, b) => a - b));
  });

  it("B40 rulings.test.ts indexes R203 and R204 in order, proved in cues.test.ts and, for R203, director.test.ts", () => {
    const index = read(INDEX_PATH);
    const r203 = indexProofs(index, 203);
    const r204 = indexProofs(index, 204);

    expect(r203?.map((name) => indexConstant(index, name))).toEqual([join(here, "cues.test.ts"), join(here, "director.test.ts")]);
    expect(r204?.map((name) => indexConstant(index, name))).toEqual([join(here, "cues.test.ts")]);
    expect(index.indexOf('it("R203')).toBeLessThan(index.indexOf('it("R204'));
  });

  it("B40 each proof file carries a test named after its row", () => {
    expect(hasTestNamed(join(here, "cues.test.ts"), 203)).toBe(true);
    expect(hasTestNamed(join(here, "cues.test.ts"), 204)).toBe(true);
    expect(hasTestNamed(join(here, "director.test.ts"), 203)).toBe(true);
  });

  it(
    "B40 pnpm rulings:coverage exits 0",
    () => {
      const result = spawnSync(process.execPath, [TSX_CLI, COVERAGE_SCRIPT], {
        cwd: REPO,
        encoding: "utf8",
        timeout: COVERAGE_TIMEOUT_MS,
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
    COVERAGE_TIMEOUT_MS,
  );
});

describe("SPEC §10.11 Audio (docs/polish/2-sound.md, SPEC changes)", () => {
  it("sits after §10.10 Client rendering and before §11", () => {
    const spec = read(SPEC_PATH);
    const rendering = spec.search(/^### 10\.10 /m);
    const audio = spec.search(/^### 10\.11 Audio$/m);
    const rulings = spec.search(/^## 11\. /m);

    expect(rendering).toBeGreaterThan(-1);
    expect(audio).toBeGreaterThan(rendering);
    expect(rulings).toBeGreaterThan(audio);
  });
});
