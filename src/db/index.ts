import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

/**
 * Supabase requires TLS. node-postgres treats `sslmode=require` in the URL as full certificate verification,
 * and Supabase's pooler certificate is not in Node's default trust store, so the `sslmode` parameter is
 * removed from the URL and TLS is configured here instead:
 *  - DATABASE_SSL_CA (PEM text) set      -> verify the server against that CA (recommended; download it from Supabase > Database settings)
 *  - Supabase host, no CA provided       -> encrypted connection without certificate verification
 *  - local/other hosts                   -> no TLS, unless DATABASE_SSL=true
 */
function poolConfig(): PoolConfig {
  const u = new URL(databaseUrl!);
  u.searchParams.delete("sslmode");
  const isSupabase = /\.supabase\.(com|co)$/.test(u.hostname);
  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  const ssl = ca ? { ca, rejectUnauthorized: true } : isSupabase || process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined;
  // Serverless functions each hold their own pool, so keep it small and let the Supabase pooler multiplex.
  const max = Number(process.env.DB_POOL_MAX ?? (process.env.VERCEL ? 3 : 10));
  return { connectionString: u.toString(), ssl, max, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000 };
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool(poolConfig());

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
