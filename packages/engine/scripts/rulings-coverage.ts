// BUILD §5's named check: "rulings.test.ts covers every SPEC §11 row (script `rulings-coverage.ts`
// lists any missing id)".
//
// `rulings.test.ts` already fails when the index and §11 disagree, but a failing assertion prints a
// diff of two long number arrays. This prints the ids themselves, in both directions, so the answer
// to "which row is missing?" does not require reading a 158-element diff.
//
// Both directions matter. A row in §11 with no test is CLAUDE.md rule 3 unmet — a ruling the code
// makes that nothing pins. A test naming a row §11 does not have is worse in a quieter way: it
// looks like coverage, and it is the shape the project has already hit twice, when three card tests
// carried "proposed R82"/"proposed R91" titles for rulings §11 had since assigned to R119, R120 and
// R121, so a grep credited the wrong row.
//
// Run: pnpm exec tsx packages/engine/scripts/rulings-coverage.ts
// Exits 1 if either direction is non-empty, so it can gate CI.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "..", "..", "..");

/** §11's rows are the only lines starting `| R<n> |`. */
function specRows(): number[] {
  const spec = readFileSync(join(repo, "SPEC.md"), "utf8");
  const ids = [...spec.matchAll(/^\| R(\d+) \|/gm)].map((m) => Number(m[1]));
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * The files REVIEW's B4 check greps, and the ones they delegate to. A row may be proved in a card
 * test or in a sibling engine test, so every test file counts — what matters is that some `it` is
 * named for the row.
 */
function testFiles(): string[] {
  const dirs = [
    join(repo, "packages", "engine", "test"),
    join(repo, "packages", "cards", "test"),
  ];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".test.ts")) out.push(join(dir, name));
    }
  }
  return out;
}

/** An `it("R<n> …")` title, which is the form CLAUDE.md rule 3 and REVIEW B4 both ask for. */
function namedRows(files: string[]): Map<number, string[]> {
  const found = new Map<number, string[]>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bit(?:\.\w+)?\(\s*["'`]R(\d+)\b/g)) {
      const id = Number(match[1]);
      const where = found.get(id) ?? [];
      const short = file.slice(repo.length + 1);
      if (!where.includes(short)) where.push(short);
      found.set(id, where);
    }
  }
  return found;
}

/**
 * Every `R<n>` mentioned ANYWHERE in the tracked source — comments, `describe` titles, SQL headings,
 * prose in a test file — not just `it("R<n> …")` titles.
 *
 * This is the direction the script was missing, and it was missed the way these things always are:
 * an agent implemented a decision SPEC does not make, cited "R169" in ten comments and two
 * `describe` titles, correctly left SPEC.md to a human — and this script said "every row is named,
 * and no test names a row that does not exist", because R169 appeared in no `it` title. BUILD §5
 * asks for the opposite of that in as many words: "SPEC.md has a §11 row for every ruling the code
 * makes; no ruling exists only in code comments", and REVIEW B4 grades exactly that MAJOR.
 *
 * A broad `\bR\d+\b` sweep sounds like it would drown in false positives and does not: over every
 * tracked .ts/.tsx/.sql file it finds 169 distinct ids, 168 of them §11 rows. If a genuine false
 * positive ever appears, narrow it here rather than deleting the check.
 */
function citedAnywhere(): Map<number, string[]> {
  const found = new Map<number, string[]>();
  const skip = new Set(["node_modules", "dist", "coverage", ".git", "artifacts"]);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|sql)$/.test(entry.name)) {
        for (const match of readFileSync(full, "utf8").matchAll(/\bR(\d+)\b/g)) {
          const id = Number(match[1]);
          const where = found.get(id) ?? [];
          const short = full.slice(repo.length + 1);
          if (!where.includes(short)) where.push(short);
          found.set(id, where);
        }
      }
    }
  };
  for (const top of ["packages", "apps"]) walk(join(repo, top));
  return found;
}

const rows = specRows();
const named = namedRows(testFiles());
const cited = citedAnywhere();

const missing = rows.filter((id) => !named.has(id));
const unknown = [...named.keys()].filter((id) => !rows.includes(id)).sort((a, b) => a - b);
const uncited = [...cited.keys()].filter((id) => !rows.includes(id)).sort((a, b) => a - b);

console.log(`SPEC §11: ${String(rows.length)} rows, R${String(rows[0])}–R${String(rows[rows.length - 1])}`);
console.log(`named by a test: ${String(rows.length - missing.length)}`);

if (missing.length > 0) {
  console.log(`\nMISSING — a §11 row no test is named for (CLAUDE.md rule 3):`);
  for (const id of missing) console.log(`  R${String(id)}`);
}

if (unknown.length > 0) {
  console.log(`\nUNKNOWN — a test names a row §11 does not have:`);
  for (const id of unknown) console.log(`  R${String(id)}  ${(named.get(id) ?? []).join(", ")}`);
}

if (uncited.length > 0) {
  console.log(`\nONLY IN CODE — an R-id the source cites that §11 does not have (BUILD §5: "no ruling`);
  console.log(`exists only in code comments"). Append the row to SPEC §11, or stop citing the id:`);
  for (const id of uncited) console.log(`  R${String(id)}  ${(cited.get(id) ?? []).join(", ")}`);
}

const clean = missing.length === 0 && unknown.length === 0 && uncited.length === 0;
if (clean) {
  console.log(
    `\nevery row is named, no test names a row that does not exist, and no R-id is cited in code` +
      ` without a §11 row (${String(cited.size)} ids cited across the source).`,
  );
}

process.exit(clean ? 0 : 1);
