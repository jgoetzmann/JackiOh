/**
 * B14's redemption race against the in-memory fixture (`src/api/e2e-store.ts`). Hermetic, so it
 * runs in `pnpm test` with the rest of the server suite; `redeem-race.postgres.spec.ts` runs the
 * very same assertions against a real Postgres under `pnpm test:db`.
 *
 * `createInMemoryRedeem` is also what `test/fakes/store.ts` redeems through, so this is the race
 * every server test's store would otherwise lose.
 */

import { memoryHarness } from "./harness";
import { runRedeemRaceContract } from "./redeem-race";

runRedeemRaceContract(async () => memoryHarness());
