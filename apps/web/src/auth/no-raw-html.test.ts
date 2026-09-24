// B36 (docs/polish/5-sign-in.md): no source file under apps/web/src renders raw HTML. Every string
// the client shows (a server sentence, a provider error, an emailed link's parameters) goes through
// React's text escaping, so a crafted `error_description` or code can never become markup.
//
// The sources are read with Vite's `import.meta.glob(..., { query: "?raw" })`, because the web
// tsconfig has no Node types and `node:fs` is not available here. The two patterns are built from
// pieces so this file does not match itself.

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** React's escape hatch for raw markup, by name. */
const RAW_PROP = new RegExp(["dangerously", "Set", "Inner", "HTML"].join(""));

/** An assignment (or `+=`) to innerHTML, but not a read or a comparison. */
const ASSIGNS_INNER = new RegExp(`\\b${["inner", "HTML"].join("")}\\s*\\+?=(?!=)`);

/** This file names both patterns in pieces; leave it out rather than trusting the pieces. */
const SELF = /no-raw-html\.test\.ts$/;

function scanned(): [string, string][] {
  return Object.entries(SOURCES).filter(([path]) => !SELF.test(path));
}

describe("B36 no raw HTML", () => {
  it("B36 the scan covers apps/web/src, the new auth screens included", () => {
    const paths = Object.keys(SOURCES);
    for (const expected of [
      "main.tsx",
      "routes/login.tsx",
      "routes/landing.tsx",
      "routes/reset-password.tsx",
      "routes/invite.tsx",
      "CodeField.tsx",
      "redirect.ts",
      "net/auth.ts",
    ]) {
      expect(
        paths.some((path) => path.endsWith(`/${expected}`) || path === `./${expected}`),
        `${expected} is scanned`,
      ).toBe(true);
    }
    for (const source of Object.values(SOURCES)) expect(typeof source).toBe("string");
  });

  it("B36 the patterns catch what they are meant to catch", () => {
    const prop = ["dangerously", "SetInnerHTML"].join("");
    const inner = ["inner", "HTML"].join("");
    expect(RAW_PROP.test(`<div ${prop}={{ __html: x }} />`)).toBe(true);
    expect(ASSIGNS_INNER.test(`node.${inner} = text;`)).toBe(true);
    expect(ASSIGNS_INNER.test(`node.${inner}+=text;`)).toBe(true);
    // Reading it (as a test might) is not rendering it.
    expect(ASSIGNS_INNER.test(`expect(node.${inner}).not.toContain("x");`)).toBe(false);
    expect(ASSIGNS_INNER.test(`if (node.${inner} === "") {}`)).toBe(false);
  });

  it("B36 no file uses React's raw-markup prop", () => {
    const offenders = scanned()
      .filter(([, source]) => RAW_PROP.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("B36 no file assigns innerHTML", () => {
    const offenders = scanned()
      .filter(([, source]) => ASSIGNS_INNER.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
