import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// The engine and the card scripts must be pure (SPEC §9.3, CLAUDE.md rule 4):
// every random draw goes through `rng` in state and time only arrives as action data.
const PURE_PACKAGES = ["packages/engine/**/*.ts", "packages/cards/**/*.ts"];
const PURE_SOURCES = ["packages/engine/src/**/*.ts", "packages/cards/src/**/*.ts"];

const RNG_MESSAGE = "Use the seeded rng in state (engine/src/rng.ts), never Math.random.";
const CLOCK_MESSAGE = "The engine never reads the clock; timestamps arrive as action data.";
const IO_MESSAGE = "packages/engine and packages/cards are pure: no I/O, timers or async.";

export default defineConfig(
  {
    // Lint fixtures break the purity rules on purpose; test/lint-ban.test.ts lints them explicitly.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/test/fixtures/lint/**",
      // Agent worktrees are whole checkouts of this same repo (see scripts/worktree.sh). Linting
      // them lints every file twice and reports another agent's in-progress work as this tree's.
      ".claude/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: PURE_PACKAGES,
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: RNG_MESSAGE },
        { object: "Date", property: "now", message: CLOCK_MESSAGE },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date']", message: CLOCK_MESSAGE },
        { selector: "CallExpression[callee.name='Date']", message: CLOCK_MESSAGE },
      ],
    },
  },
  {
    files: PURE_SOURCES,
    rules: {
      "no-restricted-globals": [
        "error",
        ...["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "fetch", "performance", "process", "crypto"].map(
          (name) => ({ name, message: IO_MESSAGE }),
        ),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*", "fs", "fs/*", "path", "os", "child_process", "http", "https", "net"], message: IO_MESSAGE },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date']", message: CLOCK_MESSAGE },
        { selector: "CallExpression[callee.name='Date']", message: CLOCK_MESSAGE },
        { selector: ":function[async=true]", message: IO_MESSAGE },
        { selector: "NewExpression[callee.name='Promise']", message: IO_MESSAGE },
      ],
    },
  },
  {
    // Plain `.mjs` scripts are Node tools, not library code: they legitimately use `console`, the
    // web globals Node exposes, and the process APIs the purity rules above ban in engine sources.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
);
