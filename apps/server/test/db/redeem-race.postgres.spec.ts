/**
 * B14's redemption race against a real Postgres (`src/db/store.ts`, over
 * `app.redeem_invite_code`'s row locks). Deliberately `.spec.ts`, not `.test.ts`, so `pnpm test`
 * stays hermetic and never needs Docker: run it with `pnpm test:db`.
 */

import { postgresHarness } from "./harness";
import { runRedeemRaceContract } from "./redeem-race";

runRedeemRaceContract(postgresHarness);
