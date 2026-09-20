/**
 * The pool's `error` event, which crashed the running server.
 *
 * `pg` emits `error` on the Pool when the *server* closes a pooled client that was sitting idle.
 * Supabase's Supavisor does that on its own idle timeout, so it is routine rather than
 * exceptional. Node re-throws an 'error' event that has no listener, so a Pool built without one
 * takes the process down. Measured against the Supabase session pooler before this was fixed:
 *
 *   Error: Connection terminated unexpectedly
 *       at Connection.<anonymous> (.../pg/lib/client.js:204:73)
 *   Emitted 'error' event on Client instance at: ...
 *   Node.js v26.8.1                              <- process exit 1, mid-session
 *
 * `pg` is mocked because the real failure needs a pooler that closes an idle connection, which is
 * a network and a clock away; what this file pins is our half of the contract -- that a listener
 * is attached at all, and that firing it neither throws nor is swallowed silently.
 */

import { describe, expect, it, vi } from "vitest";

const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
}));

vi.mock("pg", () => {
  class FakePool {
    on(event: string, fn: (...args: unknown[]) => void): this {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return this;
    }
    async end(): Promise<void> {}
  }
  return { Pool: FakePool, default: { Pool: FakePool } };
});

const { createPostgresStore } = await import("../../src/db/store");

const CONNECTION = "postgresql://postgres:secret@db.example.supabase.co:5432/postgres";

describe("the Postgres pool's error event", () => {
  it("attaches a listener, so Node cannot re-throw it and kill the server", () => {
    listeners.clear();
    createPostgresStore({ connectionString: CONNECTION });
    expect(listeners.get("error") ?? []).toHaveLength(1);
  });

  it("reports the error to onError instead of throwing", () => {
    listeners.clear();
    const seen: string[] = [];
    createPostgresStore({
      connectionString: CONNECTION,
      onError: (error) => seen.push(error.message),
    });

    const fire = (listeners.get("error") ?? [])[0];
    expect(fire).toBeDefined();
    // The exact error the session pooler produced.
    expect(() => fire?.(new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(seen).toEqual(["Connection terminated unexpectedly"]);
  });

  /** `onError` is optional: the listener exists for the process's sake, not the caller's. */
  it("survives an error when no onError was supplied", () => {
    listeners.clear();
    createPostgresStore({ connectionString: CONNECTION });
    const fire = (listeners.get("error") ?? [])[0];
    expect(() => fire?.(new Error("Connection terminated unexpectedly"))).not.toThrow();
  });
});
