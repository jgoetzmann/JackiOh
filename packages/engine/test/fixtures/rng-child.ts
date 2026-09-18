// Run by test/rng.test.ts in a separate process: prints `count` draws from (seed, cursor),
// which proves a resumed cursor reproduces the sequence anywhere (BUILD M1-T2).

import { createRng } from "../../src/rng.ts";

const [seed = "", cursorArg = "0", countArg = "1"] = process.argv.slice(2);
const rng = createRng(seed, Number(cursorArg));
const draws = Array.from({ length: Number(countArg) }, () => rng.next());
process.stdout.write(JSON.stringify({ draws, cursor: rng.cursor }));
