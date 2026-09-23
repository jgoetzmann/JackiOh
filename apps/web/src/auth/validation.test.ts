// Sign-up and reset validation (docs/polish/5-sign-in.md, B24). Pure functions: a problem is a
// sentence to show, and null means the value may be sent. The bounds come from config, where they
// mirror the auth provider's own limits (AUTH_PASSWORD_MIN_LENGTH, AUTH_PASSWORD_MAX_LENGTH).

import { describe, expect, it } from "vitest";

import { AUTH_PASSWORD_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH } from "../../../server/src/config.ts";
import {
  confirmProblem,
  emailProblem,
  newPasswordProblem,
  passwordBytes,
  normalizeEmail,
  requiredProblem,
} from "./validation.ts";

function expectProblem(problem: string | null): void {
  expect(problem).not.toBeNull();
  expect(typeof problem).toBe("string");
  expect((problem ?? "").length).toBeGreaterThan(0);
}

describe("normalizeEmail", () => {
  it("B24 trims surrounding whitespace", () => {
    expect(normalizeEmail("  player@example.com  ")).toBe("player@example.com");
    expect(normalizeEmail("\tplayer@example.com\n")).toBe("player@example.com");
  });

  it("B24 trims only: it keeps case and inner characters", () => {
    expect(normalizeEmail(" Player@Example.COM ")).toBe("Player@Example.COM");
    expect(normalizeEmail("a.b+tag@example.co.uk")).toBe("a.b+tag@example.co.uk");
  });
});

describe("emailProblem", () => {
  it.each([
    ["player@example.com"],
    ["a@b.co"],
    ["a.b+tag@sub.example.co.uk"],
    ["  player@example.com  "],
  ] as const)("B24 accepts %j", (email) => {
    expect(emailProblem(email)).toBeNull();
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["no @", "player.example.com"],
    ["nothing before the @", "@example.com"],
    ["nothing after the @", "player@"],
    ["no dot in the domain", "player@example"],
    ["a dot with nothing after it", "player@example."],
    ["a domain that starts with the dot", "player@.com"],
    ["two @", "a@b@example.com"],
    ["a space inside", "pla yer@example.com"],
  ] as const)("B24 refuses %s", (_name, email) => {
    expectProblem(emailProblem(email));
  });
});

describe("newPasswordProblem", () => {
  it("B24 accepts the minimum and the maximum length", () => {
    expect(newPasswordProblem("x".repeat(AUTH_PASSWORD_MIN_LENGTH))).toBeNull();
    expect(newPasswordProblem("x".repeat(AUTH_PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it("B24 refuses one character under the minimum", () => {
    expectProblem(newPasswordProblem("x".repeat(AUTH_PASSWORD_MIN_LENGTH - 1)));
  });

  it("B24 refuses one character over the maximum", () => {
    expectProblem(newPasswordProblem("x".repeat(AUTH_PASSWORD_MAX_LENGTH + 1)));
  });

  it("B24 refuses an empty password", () => {
    expectProblem(newPasswordProblem(""));
  });

  it("B24 counts the upper limit in bytes, as the provider does: 40 Cyrillic letters are 80 bytes", () => {
    const cyrillic = "ж".repeat(40);
    expect(cyrillic.length).toBeLessThan(AUTH_PASSWORD_MAX_LENGTH);
    expect(passwordBytes(cyrillic)).toBeGreaterThan(AUTH_PASSWORD_MAX_LENGTH);
    const problem = newPasswordProblem(cyrillic);
    expectProblem(problem);
    // A limit in bytes is not a number of characters, so the sentence promises none.
    expect(problem).not.toMatch(/at most \d+ characters/);
    // 25 Chinese characters are 75 bytes.
    expectProblem(newPasswordProblem("字".repeat(25)));
    expect(newPasswordProblem("字".repeat(24))).toBeNull();
  });
});

describe("confirmProblem", () => {
  it("B24 accepts a matching confirmation", () => {
    const password = "x".repeat(AUTH_PASSWORD_MIN_LENGTH);
    expect(confirmProblem(password, password)).toBeNull();
  });

  it("B24 refuses a confirmation that differs", () => {
    const password = "x".repeat(AUTH_PASSWORD_MIN_LENGTH);
    expectProblem(confirmProblem(password, `${password}y`));
    expectProblem(confirmProblem(password, password.toUpperCase()));
  });

  it("B24 refuses an empty confirmation", () => {
    expectProblem(confirmProblem("x".repeat(AUTH_PASSWORD_MIN_LENGTH), ""));
  });
});

describe("requiredProblem", () => {
  it("B24 sign-in only requires a value", () => {
    expect(requiredProblem("x", "Email")).toBeNull();
    // Sign-in does not judge format: a short password or an odd address is the provider's to refuse.
    expect(requiredProblem("not-an-email", "Email")).toBeNull();
  });

  it("B24 refuses an empty value", () => {
    expectProblem(requiredProblem("", "Email"));
    expectProblem(requiredProblem("", "Password"));
  });
});
