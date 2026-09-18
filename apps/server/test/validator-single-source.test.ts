/**
 * BUILD M6-T3's grep test, verbatim: "one module imported by both `apps/web` and `apps/server`;
 * `apps/web` and `apps/server` both import from `@jackioh/validator` (grep test)". SPEC §9.4 is the
 * rule it stands for — "one validator module shared by client and server, at save and again at
 * queue" — and §9.3 is why it matters: the client's verdict is UX and the server's is law, so the
 * two must be the same code. A deck the builder accepts and the save refuses is a bug the player
 * cannot act on, and the reverse is a hole in the only authority there is.
 *
 * WHY IT LIVES IN THE SERVER SUITE, AND ONLY HERE.
 * The acceptance item is a claim about *two* apps at once, so it has to be asserted from one file
 * that can see both trees; split in half it stops being the claim. Of the two candidates the server
 * is the right host: §9.3 makes the server the authority, so this is the side that is harmed when
 * the other drifts, and the rest of M6-T3's acceptance already lives in this suite
 * (`test/api/catalog.test.ts` drives the adapter, `test/api/loadouts.test.ts` drives the save path).
 * `apps/web` keeps the mirror-image half of the same idea in
 * `apps/web/src/game/deckbuilder/messages.test.ts` — "no L1–L6 sentence is written anywhere in the
 * client" — and this file re-runs that scan over BOTH apps, so a copy in the client fails in two
 * suites rather than none if that file is ever moved.
 *
 * WHAT IT ASSERTS, AND WHY NOT JUST THE STRING.
 * Grepping for "@jackioh/validator" somewhere in a tree proves nothing: the string appears in a
 * dozen comments in both apps, and a second implementation would most likely arrive *next to* an
 * import that stayed. So the assertions are the ones a second implementation would break:
 *
 *   1. Each app declares the package as a dependency (it cannot be imported otherwise).
 *   2. Each app's production source really imports it — an `import ... from "@jackioh/validator"`
 *      statement, with comments and test files excluded, so a mention cannot stand in for a use.
 *   3. No app source declares its own `validateLoadout`.
 *   4. No app source declares its own `DECK_SIZE`, `MAX_COPIES` or `LOADOUT_DECKS` (BUILD §2: the
 *      deck constants live in the engine's config and nothing restates them; re-exporting them is
 *      not restating them).
 *   5. No app source carries a second copy of an L1–L6 sentence. The fragments are extracted from
 *      `packages/validator/src/index.ts` at test time, so rewording a message there moves the scan
 *      with it and nobody has to edit this file.
 *
 * Nothing here imports `@jackioh/validator` itself. This file reads source; it must keep working
 * when the thing it is checking has been broken.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const VALIDATOR = join(ROOT, "packages/validator/src/index.ts");
const PACKAGE = "@jackioh/validator";

/** The two apps BUILD M6-T3 names, and nothing else. */
const APPS = [
  { name: "apps/web", src: join(ROOT, "apps/web/src"), manifest: join(ROOT, "apps/web/package.json") },
  { name: "apps/server", src: join(ROOT, "apps/server/src"), manifest: join(ROOT, "apps/server/package.json") },
] as const;

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

/** Every `.ts`/`.tsx` file under `root` that is not itself a test. */
function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/u.test(entry)) continue;
      // Production code only: a test double is a double on purpose, and a test that names the
      // package in prose is not a second implementation of anything.
      if (/\.test\.tsx?$/u.test(entry)) continue;
      found.push(path);
    }
  };
  walk(root);
  return found;
}

/**
 * True when `source` contains a real `import`/`export ... from "@jackioh/validator"` statement.
 *
 * Anchored to the start of a line so a mention inside a comment — of which both apps have several,
 * this file included — cannot pass for a use. Spans newlines, because the deckbuilder's import is
 * a multi-line `import { ... }`.
 */
function importsValidator(source: string): boolean {
  return new RegExp(
    String.raw`(?:^|\n)[ \t]*(?:import|export)\b[^;]*?from\s*["']${PACKAGE}["']`,
    "u",
  ).test(source);
}

/** A local declaration of a name the shared module owns, ignoring `import`/`export ... from`. */
function declares(source: string, name: string): boolean {
  return new RegExp(String.raw`\b(?:function|const|let|var|class)\s+${name}\b`, "u").test(source);
}

/**
 * The literal chunks of every message `validateLoadout` builds: each template literal, split on
 * its `${…}` holes, keeping the pieces that are prose rather than punctuation. Same extraction as
 * `apps/web/src/game/deckbuilder/messages.test.ts`, on purpose — the two halves of §9.4's "one
 * module" should go red for the same reason.
 *
 * Three words and not that file's two, because this side also scans `apps/server/src`, where
 * `api/e2e-store.ts` describes the `(profile_id, card_id)` unique index as refusing "a card id that
 * appears in two decks". That is documentation of migration 0003, not a copy of L4's sentence, and
 * a two-word fragment cannot tell the difference. Twelve of the fourteen fragments survive the
 * filter, covering all six rules.
 */
function validatorFragments(): string[] {
  const source = readFileSync(VALIDATOR, "utf8");
  const fragments = new Set<string>();
  for (const match of source.matchAll(/`([^`]*)`/gsu)) {
    for (const piece of (match[1] ?? "").split(/\$\{[^}]*\}/u)) {
      const trimmed = piece.trim();
      if (trimmed.length < 9) continue;
      if (trimmed.split(/\s+/u).length < 3) continue;
      if (!/[A-Za-z]\s[A-Za-z]/u.test(trimmed)) continue;
      fragments.add(trimmed);
    }
  }
  return [...fragments].sort();
}

function dependenciesOf(manifest: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return { ...parsed.dependencies, ...parsed.devDependencies };
}

// ---------------------------------------------------------------------------
// BUILD M6-T3: one module, imported by both apps
// ---------------------------------------------------------------------------

describe(`BUILD M6-T3 — ${PACKAGE} is the one implementation of L1–L6 (§9.4)`, () => {
  it("is declared as a dependency by both apps", () => {
    for (const app of APPS) {
      expect(Object.keys(dependenciesOf(app.manifest)), `${app.name}/package.json`).toContain(
        PACKAGE,
      );
    }
  });

  it("is really imported by each app's own source, not merely mentioned in a comment", () => {
    const importers: Record<string, string[]> = {};
    for (const app of APPS) {
      importers[app.name] = sourceFiles(app.src)
        .filter((file) => importsValidator(readFileSync(file, "utf8")))
        .map((file) => relative(ROOT, file));
    }

    for (const app of APPS) {
      expect(
        importers[app.name],
        `${app.name} has no \`from "${PACKAGE}"\` import: either it stopped sharing the module, or it grew a copy of the rules`,
      ).not.toEqual([]);
    }

    // The server's single reach point, as `src/api/loadout-validator.ts` says it is ("the one place
    // `apps/server` reaches `@jackioh/validator`"): every handler goes through the port instead.
    expect(importers["apps/server"]).toEqual(["apps/server/src/api/loadout-validator.ts"]);
  });

  it("would not accept a comment in place of an import, so the scan is not vacuous", () => {
    expect(importsValidator(`import { validateLoadout } from "${PACKAGE}";`)).toBe(true);
    expect(importsValidator(`import {\n  validateLoadout,\n} from "${PACKAGE}";`)).toBe(true);
    expect(importsValidator(`export { LOADOUT_DECKS } from "${PACKAGE}";`)).toBe(true);
    // The shapes both apps' comments actually take today.
    expect(importsValidator(`// both apps import from \`${PACKAGE}\``)).toBe(false);
    expect(importsValidator(`/* see ${PACKAGE} */`)).toBe(false);
    expect(importsValidator(`  // import { x } from "${PACKAGE}";`)).toBe(false);
    // And an import of something else is not an import of this.
    expect(importsValidator(`import { DECK_SIZE } from "@jackioh/engine/config";`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The other half: no second implementation anywhere in either app
// ---------------------------------------------------------------------------

describe("no app re-implements a loadout rule locally (§9.4, BUILD §2)", () => {
  it("no app source declares its own validateLoadout", () => {
    const offences: string[] = [];
    for (const app of APPS) {
      for (const file of sourceFiles(app.src)) {
        if (declares(readFileSync(file, "utf8"), "validateLoadout")) {
          offences.push(relative(ROOT, file));
        }
      }
    }
    expect(
      offences,
      `a second validateLoadout exists:\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no app source declares its own DECK_SIZE, MAX_COPIES or LOADOUT_DECKS", () => {
    // BUILD §2 puts the deck constants in the engine's config and says nothing restates them.
    // `apps/web/src/game/deckbuilder/deckSize.ts` re-exports them from there, which is a pointer
    // and not a copy, so it does not match: only a fresh binding does.
    const offences: string[] = [];
    for (const app of APPS) {
      for (const file of sourceFiles(app.src)) {
        const text = readFileSync(file, "utf8");
        for (const name of ["DECK_SIZE", "MAX_COPIES", "LOADOUT_DECKS"]) {
          if (declares(text, name)) offences.push(`${relative(ROOT, file)} declares ${name}`);
        }
      }
    }
    expect(
      offences,
      `a deck constant has a second value:\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no app source carries a second copy of an L1–L6 sentence", () => {
    const fragments = validatorFragments();
    // At least one per rule with room to spare (12 today), or the scan below looks for nothing.
    expect(fragments.length, `fragments found in ${VALIDATOR}`).toBeGreaterThanOrEqual(10);
    // The control on the extraction itself: these really are the validator's own words.
    expect(readFileSync(VALIDATOR, "utf8")).toContain(fragments[0] ?? "");

    const offences: string[] = [];
    for (const app of APPS) {
      for (const file of sourceFiles(app.src)) {
        const text = readFileSync(file, "utf8");
        for (const fragment of fragments) {
          if (text.includes(fragment)) {
            offences.push(`${relative(ROOT, file)} contains ${JSON.stringify(fragment)}`);
          }
        }
      }
    }
    expect(
      offences,
      `a validator sentence has a second copy in an app:\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });
});
