import path from "path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "@/db";
import { SETUP_SQL } from "@/db/setup-sql";

/**
 * Idempotent start-up routine used by instrumentation.ts and scripts/seed.ts:
 *  1. create tables from SQL migrations if the schema is missing
 *  2. (re)apply integrity triggers
 *  3. seed the labelled demo organisation when the database has no organisations (disable with SEED_DEMO=false)
 */
export async function bootstrap() {
  const t = await db.execute(sql`select to_regclass('public.organisations') as t`);
  if (!t.rows[0].t) await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  await pool.query(SETUP_SQL);
  if (process.env.SEED_DEMO !== "false") {
    const c = await db.execute(sql`select count(*)::int as n from organisations`);
    if (Number(c.rows[0].n) === 0) {
      const { seedDemo } = await import("@/db/seed");
      await seedDemo();
    }
  }
}
