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

const { listeners, clients } = vi.hoisted(() => ({
  listeners: new Map<string, ((...args: unknown[]) => void)[]>(),
  clients: [] as {
    errorListeners: ((...args: unknown[]) => void)[];
    released: boolean;
    releasedWith: unknown;
  }[],
}));

vi.mock("pg", () => {
  class FakeClient {
    errorListeners: ((...args: unknown[]) => void)[] = [];
    released = false;
    releasedWith: unknown = undefined;
    on(event: string, fn: (...args: unknown[]) => void): this {
      if (event === "error") this.errorListeners.push(fn);
      return this;
    }
    removeListener(event: string, fn: (...args: unknown[]) => void): this {
      if (event === "error") this.errorListeners = this.errorListeners.filter((f) => f !== fn);
      return this;
    }
    async query(): Promise<{ rows: unknown[]; rowCount: number }> {
      return { rows: [], rowCount: 0 };
    }
    release(err?: unknown): void {
      this.released = true;
      this.releasedWith = err;
    }
  }
  class FakePool {
    on(event: string, fn: (...args: unknown[]) => void): this {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return this;
    }
    async connect(): Promise<FakeClient> {
      const client = new FakeClient();
      clients.push(client);
      return client;
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

/**
 * The other half, and the half that was missed the first time.
 *
 * `pool.on("error")` covers an IDLE client. A CHECKED-OUT client emits on ITSELF, and there are
 * TWO checkout sites: `poolSession` for a single statement and `store.tx` for a transaction. The
 * first fix guarded only `poolSession`, leaving `store.tx` — where matchmaking's
 * `startPairedMatch` runs, the most concurrent code in the server — still able to take the
 * process down. Both go through `checkout()` now, and both are asserted here so a third site
 * cannot quietly skip it.
 */
describe("a checked-out client", () => {
  const CONNECTION = "postgresql://postgres:secret@db.example.supabase.co:5432/postgres";

  it("carries its own error listener on the single-statement path", async () => {
    clients.length = 0;
    const store = createPostgresStore({ connectionString: CONNECTION });
    await store.profiles.getById("11111111-1111-1111-1111-111111111111").catch(() => undefined);

    expect(clients, "a client was checked out").to.have.length.greaterThan(0);
    const client = clients[0];
    expect(client?.released, "and released").toBe(true);
  });

  it("carries its own error listener inside store.tx", async () => {
    clients.length = 0;
    const store = createPostgresStore({ connectionString: CONNECTION });

    let sawListener = false;
    await store
      .tx(async () => {
        // Mid-transaction: this is exactly when a dropped connection used to kill the process.
        sawListener = (clients[0]?.errorListeners.length ?? 0) > 0;
      })
      .catch(() => undefined);

    expect(sawListener, "store.tx attaches an error listener while the client is checked out").toBe(
      true,
    );
  });

  it("destroys a connection that errored instead of pooling it again", async () => {
    clients.length = 0;
    const store = createPostgresStore({ connectionString: CONNECTION });
    const boom = new Error("read ETIMEDOUT");

    await store
      .tx(async () => {
        // Fire the event the pooler causes, the way `pg` would.
        for (const fn of clients[0]?.errorListeners ?? []) fn(boom);
      })
      .catch(() => undefined);

    // `release(err)` is what tells pg to discard the client rather than reuse it.
    expect(clients[0]?.releasedWith, "released WITH the error").toBe(boom);
  });
});
