/**
 * The store contract against a real Postgres (`src/db/store.ts`). Deliberately `.spec.ts`, not
 * `.test.ts`: `apps/server/vitest.config.ts` includes only files named `*.test.ts` under `test/`,
 * so `pnpm test` stays hermetic and fast and never needs Docker. Run this with `pnpm test:db`.
 */

import { runStoreContract } from "./contract";
import { postgresHarness } from "./harness";

runStoreContract(postgresHarness);
