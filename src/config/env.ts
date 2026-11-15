import { z } from "zod";

/**
 * Environment validation.
 *
 * - `publicEnv` holds `NEXT_PUBLIC_*` values. They are inlined at build time,
 *   so each one must be referenced statically (`process.env.NEXT_PUBLIC_X`).
 * - `getServerEnv()` holds secrets and must only be called from server code.
 *   It is validated once at boot in `src/instrumentation.ts`.
 *
 * Integrations that are not built yet (database, auth, storage, AI) are
 * optional here; tighten them to required as each module is implemented.
 */

const supportedCurrencies = ["IRR", "USD", "EUR", "AED"] as const;

const publicSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
  NEXT_PUBLIC_DEFAULT_CURRENCY: z.enum(supportedCurrencies).default("IRR"),
});

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .url()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "Must be a PostgreSQL connection URL")
    .optional(),
  /** Owner role used only by the migration runner (scripts/db-migrate.ts). Never the app's own URL in production. */
  MIGRATION_DATABASE_URL: z
    .url()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), "Must be a PostgreSQL connection URL")
    .optional(),
  /** Least-privilege role the app connects as; migrations grant it access via fc_app_grant(). */
  DB_APP_ROLE: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, "Must be a lowercase PostgreSQL role name")
    .optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).optional(),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters").optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
}

function parse<T extends z.ZodType>(schema: T, input: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid ${label} environment variables:\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export const publicEnv: PublicEnv = parse(
  publicSchema,
  {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL || undefined,
    NEXT_PUBLIC_DEFAULT_CURRENCY: process.env.NEXT_PUBLIC_DEFAULT_CURRENCY || undefined,
  },
  "public",
);

let cachedServerEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("getServerEnv() must not be called in the browser");
  }
  cachedServerEnv ??= parse(
    serverSchema,
    Object.fromEntries(
      Object.entries(process.env).map(([key, value]) => [key, value === "" ? undefined : value]),
    ),
    "server",
  );
  return cachedServerEnv;
}
