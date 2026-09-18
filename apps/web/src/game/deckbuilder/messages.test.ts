// SPEC §9.4: "one validator module shared by client and server". This file is the grep that keeps
// it one.
//
// The fragments are not typed out here either — they are extracted from
// `packages/validator/src/index.ts` at test time, by pulling the literal chunks out of its
// template literals. So the test tracks the validator: reword an L-rule message there and this
// test looks for the new wording, without anyone editing this file. If a client source ever
// contains one of those chunks, there are two sources of truth for that sentence and the test
// fails naming both.
//
// BUILD M6-T3's acceptance already asks for a grep test ("`apps/web` and `apps/server` both import
// from `@jackioh/validator`"); this is its mirror image, and both are needed: importing the module
// is worth nothing if the screen also carries its own copy of the words.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(here, "../..");
const VALIDATOR = resolve(here, "../../../../../packages/validator/src/index.ts");

/** This file quotes the fragments in its failure messages, so it is the one file exempt. */
const SELF = resolve(here, "messages.test.ts");

/**
 * The literal chunks of every message the validator builds: each template literal, split on its
 * `${…}` holes, keeping the pieces long enough to be prose rather than punctuation.
 */
function validatorFragments(): string[] {
  const source = readFileSync(VALIDATOR, "utf8");
  const templates = [...source.matchAll(/`([^`]*)`/gs)].map((match) => match[1] ?? "");
  const fragments = new Set<string>();
  for (const template of templates) {
    for (const piece of template.split(/\$\{[^}]*\}/)) {
      const trimmed = piece.trim();
      // Long enough to be a sentence fragment (`but you own`, `appears in`), and two words.
      if (trimmed.length < 9) continue;
      if (!/[A-Za-z]\s[A-Za-z]/.test(trimmed)) continue;
      fragments.add(trimmed);
    }
  }
  return [...fragments].sort();
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.tsx?$/.test(entry)) found.push(path);
    }
  };
  walk(root);
  return found;
}

describe("no L1–L6 sentence is written anywhere in the client", () => {
  const fragments = validatorFragments();

  it("finds the validator's own message fragments to look for", () => {
    // One per rule at least, or the scan below would be looking for nothing.
    expect(fragments.length, `fragments found in ${VALIDATOR}`).toBeGreaterThanOrEqual(12);
  });

  it("finds none of them in any file under apps/web/src", () => {
    const offences: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      if (file === SELF) continue;
      const text = readFileSync(file, "utf8");
      for (const fragment of fragments) {
        if (text.includes(fragment)) {
          offences.push(`${relative(WEB_SRC, file)} contains ${JSON.stringify(fragment)}`);
        }
      }
    }
    expect(
      offences,
      `a validator sentence has a second copy in the client:\n  ${offences.join("\n  ")}`,
    ).toEqual([]);
  });

  it("would catch a copy, so the scan is not vacuous", () => {
    // The scan's own control: the first fragment really is findable in the validator's source.
    const source = readFileSync(VALIDATOR, "utf8");
    expect(source).toContain(fragments[0] ?? "");
  });
});
