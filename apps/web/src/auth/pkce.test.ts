// PKCE for the emailed links (auth/pkce.ts, R323): the verifier, its challenge, and where it is kept.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PKCE_METHOD,
  PKCE_STORAGE_KEY,
  challengeFor,
  challengeForRequest,
  forgetVerifier,
  newVerifier,
  storedVerifiers,
} from "./pkce.ts";

/** RFC 7636 appendix B: this verifier's S256 challenge. */
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("R323 the verifier and its challenge", () => {
  it("R323 a verifier is 43 to 128 unreserved characters, and a fresh one each time", () => {
    const first = newVerifier();
    const second = newVerifier();
    for (const verifier of [first, second]) {
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]+$/u);
    }
    expect(first).not.toBe(second);
  });

  it("R323 the challenge is base64url(SHA-256(verifier)), RFC 7636's own example", async () => {
    expect(await challengeFor(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("R323 a request's challenge is sent as s256, and its verifier is kept on the device", async () => {
    const challenge = await challengeForRequest("recovery");
    expect(challenge.code_challenge_method).toBe(PKCE_METHOD);
    expect(PKCE_METHOD).toBe("s256");
    const [held] = storedVerifiers();
    expect(held?.flow).toBe("recovery");
    expect(await challengeFor(held?.verifier ?? "")).toBe(challenge.code_challenge);
    // The verifier is in localStorage (a link is usually opened in a new tab); the challenge is not.
    const raw = window.localStorage.getItem(PKCE_STORAGE_KEY) ?? "";
    expect(raw).toContain(held?.verifier ?? "missing");
    expect(raw).not.toContain(challenge.code_challenge);
  });

  it("R323 a resend reuses the sign-up's verifier, so the first email's link still works; a new sign-up does not", async () => {
    const first = await challengeForRequest("signup");
    const resent = await challengeForRequest("signup", { reuse: true });
    expect(resent.code_challenge).toBe(first.code_challenge);
    const again = await challengeForRequest("signup");
    expect(again.code_challenge).not.toBe(first.code_challenge);
  });

  it("R323 the verifiers come back newest first, one per kind of link, and a used one is forgotten", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await challengeForRequest("signup");
    vi.setSystemTime(2_000);
    await challengeForRequest("recovery");
    expect(storedVerifiers().map((entry) => entry.flow)).toEqual(["recovery", "signup"]);
    vi.setSystemTime(3_000);
    await challengeForRequest("signup");
    expect(storedVerifiers().map((entry) => entry.flow)).toEqual(["signup", "recovery"]);

    forgetVerifier("signup");
    expect(storedVerifiers().map((entry) => entry.flow)).toEqual(["recovery"]);
    forgetVerifier("recovery");
    expect(storedVerifiers()).toEqual([]);
    expect(window.localStorage.getItem(PKCE_STORAGE_KEY)).toBeNull();
  });

  it("R323 a stored value that is not ours reads as no verifier, and blocked storage never throws", async () => {
    for (const raw of ["not json", "null", "[]", JSON.stringify({ v: 2, signup: { verifier: RFC_VERIFIER } }), JSON.stringify({ v: 1, signup: { verifier: "short" } })]) {
      window.localStorage.setItem(PKCE_STORAGE_KEY, raw);
      expect(storedVerifiers(), raw).toEqual([]);
    }
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const challenge = await challengeForRequest("signup");
    expect(challenge.code_challenge_method).toBe("s256");
    expect(storedVerifiers()).toEqual([]);
  });
});
