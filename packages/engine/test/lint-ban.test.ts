import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = (name: string) => `packages/engine/test/fixtures/lint/${name}`;

async function banned(filePaths: string[]): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false });
  const results = await eslint.lintFiles(filePaths);
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? "parse-error"));
}

async function bannedText(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false });
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? "parse-error"));
}

describe("purity lint ban (M1-T2)", () => {
  it("fails a fixture file calling Math.random", async () => {
    expect(await banned([fixture("math-random.ts")])).toEqual(["no-restricted-properties"]);
  });

  it("fails a fixture file calling Date.now", async () => {
    expect(await banned([fixture("date-now.ts")])).toEqual(["no-restricted-properties"]);
  });

  it("fails a fixture file constructing new Date()", async () => {
    expect(await banned([fixture("new-date.ts")])).toEqual(["no-restricted-syntax"]);
  });

  it("applies the same ban under packages/cards", async () => {
    const code = "export const pick = (): number => Math.random();\n";
    expect(await bannedText(code, "packages/cards/src/scripts/000-fixture.ts")).toEqual(["no-restricted-properties"]);
  });

  // CLAUDE.md rule 4 names packages/ai as pure too (SPEC §9.9: "pure and seeded like the engine").
  it("applies the same ban under packages/ai", async () => {
    const code = [
      'import { readFileSync } from "node:fs";',
      "export const pick = (): number => Math.random();",
      "export const now = (): number => Date.now();",
      "export const later = () => setTimeout(() => undefined, 1);",
      "export async function think(): Promise<void> {}",
      "export const read = readFileSync;",
      "",
    ].join("\n");
    expect(await bannedText(code, "packages/ai/src/fixture.ts")).toEqual([
      "no-restricted-imports",
      "no-restricted-properties",
      "no-restricted-properties",
      "no-restricted-globals",
      "no-restricted-syntax",
    ]);
  });

  it("bans I/O, timers and async in engine and card sources", async () => {
    const code = [
      'import { readFileSync } from "node:fs";',
      "export const a = readFileSync;",
      "export const b = () => setTimeout(() => undefined, 1);",
      "export async function c(): Promise<void> {}",
      "",
    ].join("\n");
    expect(await bannedText(code, "packages/engine/src/fixture.ts")).toEqual([
      "no-restricted-imports",
      "no-restricted-globals",
      "no-restricted-syntax",
    ]);
  });

  it("does not ban the clock outside the pure packages", async () => {
    expect(await bannedText("export const now = (): number => Date.now();\n", "apps/server/src/fixture.ts")).toEqual([]);
  });
});
