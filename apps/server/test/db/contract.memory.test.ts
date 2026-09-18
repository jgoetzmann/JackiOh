/**
 * The store contract against the in-memory fixture (`src/api/e2e-store.ts`). Hermetic, so it runs
 * in `pnpm test` with the rest of the server suite; `contract.postgres.spec.ts` runs the very same
 * assertions against a real Postgres under `pnpm test:db`.
 *
 * A failure here means the FIXTURE broke the contract. A failure only in the Postgres run means the
 * real store did. Both together are the thing that was missing: proof that the two agree.
 */

import { runStoreContract } from "./contract";
import { memoryHarness } from "./harness";

runStoreContract(async () => memoryHarness());
