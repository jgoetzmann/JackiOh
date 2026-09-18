// SERVER-ONLY: this module must never be imported by `apps/web`. It reads secrets — the
// Supabase secret key, the raw Postgres connection string, the invite-code/IP-hash pepper —
// that bypass every RLS policy. SPEC §9.1 makes the server the sole writer of collection,
// loadouts and matches; that guarantee only holds if these values never reach a browser bundle.
// `apps/server` is not yet a workspace package (see config.ts's header), so this file imports
// nothing: it reads only the `Record<string, string | undefined>` handed to it and Node's
// ambient `process` global (typed via the `node` entry in `apps/server/tsconfig.json`).

/** The server's fully validated, typed environment (SPEC §9.1, §9.4, §9.5). */
export type ServerEnv = {
  /** Supabase project URL, e.g. https://<ref>.supabase.co. Server-only by convention (no VITE_ prefix). */
  readonly SUPABASE_URL: string;
  /** Supabase secret key (or legacy service_role JWT). Server-only: bypasses every RLS policy. */
  readonly SUPABASE_SECRET_KEY: string;
  /** Direct Postgres connection string for transactional work (§9.4, §9.5). Server-only. */
  readonly DATABASE_URL: string;
  /** JWKS endpoint used to verify browser Supabase Auth JWTs. Defaults from SUPABASE_URL. */
  readonly SUPABASE_JWKS_URL: string;
  /** Legacy HS256 shared-secret fallback for JWT verification, if configured. Discouraged. */
  readonly SUPABASE_JWT_SECRET: string | undefined;
  /** Server-side pepper for the invite-code / IP-hash HMAC (§9.4). Server-only, secret. */
  readonly CODE_PEPPER: string;
  /** Port the server listens on. */
  readonly PORT: number;
  /** Allowed browser origins for CORS and WebSocket `Origin` checks. */
  readonly PUBLIC_ORIGINS: readonly string[];
  /** Deployment environment. */
  readonly NODE_ENV: "development" | "test" | "production";
  /** BUILD M8's E2E=1 test-server mode (fixture accounts, seeded games). Must be false in prod. */
  readonly E2E: boolean;
  /** Catalog version this server accepts; must match `cards.catalog_version` and the client's (§9.4). */
  readonly CATALOG_VERSION: string;
};

// The client-visible half of the environment contract (`apps/web`, via Vite's `VITE_` prefix
// convention — Vite only exposes prefixed variables to the browser bundle). Listed here for
// documentation only: this module never reads these, and none of them may carry a secret.
// `SUPABASE_SECRET_KEY` in particular must never be given a `VITE_` alias.
export const PUBLIC_ENV_VARS: readonly string[] = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SERVER_HTTP_URL",
  "VITE_SERVER_WS_URL",
  "VITE_CATALOG_VERSION",
];

// The server-only half: every variable `loadEnv` below reads. A lint or test can assert this
// list and `PUBLIC_ENV_VARS` are disjoint and that none of these ever gain a `VITE_` prefix.
export const SERVER_ONLY_ENV_VARS: readonly string[] = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "DATABASE_URL",
  "SUPABASE_JWKS_URL",
  "SUPABASE_JWT_SECRET",
  "CODE_PEPPER",
  "PORT",
  "PUBLIC_ORIGINS",
  "NODE_ENV",
  "E2E",
  "CATALOG_VERSION",
];

const MIN_CODE_PEPPER_LENGTH = 32;
const DEFAULT_PORT = 8787;
const DEFAULT_NODE_ENV = "development";

/** Where every secret in this contract comes from, for error messages only — never logged with a value. */
const SUPABASE_DASHBOARD_HINT =
  "in the Supabase dashboard under Project Settings > API (or > Data API for newer projects)";

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function parsePort(value: string | undefined, problems: string[]): number {
  if (!isNonEmpty(value)) {
    return DEFAULT_PORT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    problems.push(
      "PORT: the TCP port the server listens on. Must be an integer between 1 and 65535 " +
        `(got ${JSON.stringify(value)}). Optional; defaults to ${DEFAULT_PORT} if unset.`,
    );
    return DEFAULT_PORT;
  }
  return parsed;
}

function parseNodeEnv(
  value: string | undefined,
  problems: string[],
): "development" | "test" | "production" {
  if (!isNonEmpty(value)) {
    return DEFAULT_NODE_ENV;
  }
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  problems.push(
    "NODE_ENV: the deployment environment. Must be one of 'development', 'test' or " +
      `'production' (got ${JSON.stringify(value)}). Optional; defaults to '${DEFAULT_NODE_ENV}'.`,
  );
  return DEFAULT_NODE_ENV;
}

function parseE2E(value: string | undefined, problems: string[]): boolean {
  if (!isNonEmpty(value)) {
    return false;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  problems.push(
    "E2E: BUILD M8's test-server flag (fixture accounts, seeded games). Must be one of " +
      `'1', 'true', '0' or 'false' (got ${JSON.stringify(value)}). Optional; defaults to false. ` +
      "Set by the e2e test runner, never by a production deploy.",
  );
  return false;
}

function parsePublicOrigins(value: string | undefined, problems: string[]): readonly string[] {
  if (!isNonEmpty(value)) {
    problems.push(
      "PUBLIC_ORIGINS: comma-separated browser origins allowed for CORS and the WebSocket " +
        "Origin check (e.g. https://app.example.com,https://staging.example.com). Set by you " +
        "for this deployment; there is no dashboard value to copy.",
    );
    return [];
  }
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Validates and types the process environment (SPEC §9.1, §9.4, §9.5). Pure with respect to
 * `source` so it is testable without mutating `process.env`. On any problem it throws one
 * `Error` whose message lists every problem found — not just the first — one per line, each
 * naming the variable, what it is for, and where to obtain it.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const problems: string[] = [];

  const supabaseUrlRaw = source.SUPABASE_URL;
  let supabaseUrl = "";
  if (!isNonEmpty(supabaseUrlRaw)) {
    problems.push(
      "SUPABASE_URL: the project URL (e.g. https://<ref>.supabase.co), used to reach the " +
        `Data API and to derive the default JWKS URL. Find it ${SUPABASE_DASHBOARD_HINT}.`,
    );
  } else if (parseHttpsUrl(supabaseUrlRaw) === undefined) {
    problems.push(
      "SUPABASE_URL: must be a valid https URL (e.g. https://<ref>.supabase.co) " +
        `(got ${JSON.stringify(supabaseUrlRaw)}). Find it ${SUPABASE_DASHBOARD_HINT}.`,
    );
  } else {
    supabaseUrl = supabaseUrlRaw;
  }

  const secretKeyRaw = source.SUPABASE_SECRET_KEY;
  if (!isNonEmpty(secretKeyRaw)) {
    problems.push(
      "SUPABASE_SECRET_KEY: the secret API key (sb_secret_...), which maps to the Postgres " +
        "service_role and bypasses every RLS policy — SPEC §9.1 relies on this so the server " +
        "is the only writer of collection, loadouts and matches. A legacy service_role JWT is " +
        `accepted as a deprecated fallback. Find it ${SUPABASE_DASHBOARD_HINT}, in the ` +
        "'Secret keys' (or legacy 'service_role') section. Never expose this to a client bundle.",
    );
  }

  const databaseUrlRaw = source.DATABASE_URL;
  if (!isNonEmpty(databaseUrlRaw)) {
    problems.push(
      "DATABASE_URL: a direct Postgres connection string, used for the transactional work " +
        "the Data API cannot express — invite redemption (§9.4), saveLoadout's all-or-nothing " +
        "write (§9.4) and the atomic matchmaking ticket claim (§9.5). Find it " +
        `${SUPABASE_DASHBOARD_HINT}, under Project Settings > Database > Connection string ` +
        "(use the pooled/transaction connection string for a serverless deployment).",
    );
  }

  const jwksUrlRaw = source.SUPABASE_JWKS_URL;
  let supabaseJwksUrl = "";
  if (isNonEmpty(jwksUrlRaw)) {
    if (parseHttpsUrl(jwksUrlRaw) === undefined) {
      problems.push(
        "SUPABASE_JWKS_URL: optional, but if set must be a valid https URL " +
          `(got ${JSON.stringify(jwksUrlRaw)}). Defaults to ` +
          "'${SUPABASE_URL}/auth/v1/.well-known/jwks.json' when unset.",
      );
    } else {
      supabaseJwksUrl = jwksUrlRaw;
    }
  } else if (supabaseUrl !== "") {
    // Asymmetric verification (RS256/ES256) against this JWKS is the supported path for
    // checking a browser's Supabase Auth JWT; only the verified `sub` is trusted as the
    // profile id. A JWKS response must never be cached longer than Supabase's own 10-minute
    // edge cache, or a just-rotated key would still verify old, revoked tokens.
    supabaseJwksUrl = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  }
  // else: SUPABASE_URL itself already failed above; that problem is reported once, not twice.

  const jwtSecretRaw = source.SUPABASE_JWT_SECRET;
  // SUPABASE_JWT_SECRET is optional and its presence enables a legacy HS256 (shared-secret)
  // verification path, which is discouraged in favor of the JWKS/RS256/ES256 path above:
  // a shared secret that leaks lets an attacker mint arbitrary profile ids, whereas the JWKS
  // path only ever needs to trust Supabase's published public keys.
  const supabaseJwtSecret = isNonEmpty(jwtSecretRaw) ? jwtSecretRaw : undefined;

  const codePepperRaw = source.CODE_PEPPER;
  let codePepper = "";
  if (!isNonEmpty(codePepperRaw)) {
    problems.push(
      "CODE_PEPPER: the server-side pepper for the HMAC that turns an invite code into " +
        "invite_codes.code_hash and an IP address into code_attempts.ip_hash (§9.4: codes are " +
        `stored hashed). Must be at least ${MIN_CODE_PEPPER_LENGTH} characters of random data ` +
        "(e.g. `openssl rand -base64 48`). This is not a Supabase dashboard value — generate " +
        "and store it yourself as a deployment secret.",
    );
  } else if (codePepperRaw.length < MIN_CODE_PEPPER_LENGTH) {
    problems.push(
      `CODE_PEPPER: must be at least ${MIN_CODE_PEPPER_LENGTH} characters long so a weak ` +
        `pepper fails at boot, not in production (got a value of length ${codePepperRaw.length}). ` +
        "Generate one with e.g. `openssl rand -base64 48`.",
    );
  } else {
    codePepper = codePepperRaw;
  }

  const port = parsePort(source.PORT, problems);
  const nodeEnv = parseNodeEnv(source.NODE_ENV, problems);
  const e2e = parseE2E(source.E2E, problems);
  const publicOrigins = parsePublicOrigins(source.PUBLIC_ORIGINS, problems);

  if (e2e && nodeEnv === "production") {
    problems.push(
      "E2E: must not be set together with NODE_ENV=production — BUILD M8's fixture " +
        "accounts and seeded games must never be reachable in a production deployment.",
    );
  }

  const catalogVersionRaw = source.CATALOG_VERSION;
  let catalogVersion = "";
  if (!isNonEmpty(catalogVersionRaw)) {
    problems.push(
      "CATALOG_VERSION: the catalog version this server accepts (§9.4: a stale catalog " +
        "version is rejected at save and queue). Must match the catalog_version the seed " +
        "loader stamps on public.cards and the version the client sends. Not a Supabase " +
        "dashboard value — set it to the version of packages/cards/catalog.json this deploy ships.",
    );
  } else {
    catalogVersion = catalogVersionRaw;
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid server environment — ${problems.length} problem(s):\n` +
        problems.map((problem) => `  - ${problem}`).join("\n"),
    );
  }

  return {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SECRET_KEY: secretKeyRaw ?? "",
    DATABASE_URL: databaseUrlRaw ?? "",
    SUPABASE_JWKS_URL: supabaseJwksUrl,
    SUPABASE_JWT_SECRET: supabaseJwtSecret,
    CODE_PEPPER: codePepper,
    PORT: port,
    PUBLIC_ORIGINS: publicOrigins,
    NODE_ENV: nodeEnv,
    E2E: e2e,
    CATALOG_VERSION: catalogVersion,
  };
}

let cachedEnv: ServerEnv | undefined;

/** Memoised accessor for the process's own environment. Reads `process.env` exactly once. */
export function serverEnv(): ServerEnv {
  if (cachedEnv === undefined) {
    cachedEnv = loadEnv(process.env);
  }
  return cachedEnv;
}
