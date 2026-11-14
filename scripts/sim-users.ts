/** Creates one login per role inside the latest simulation organisation (see scripts/simulate.ts). Password: Sim@12345 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { addOrgUser } from "@/lib/services/org";
import { ROLES } from "@/lib/permissions";
import { organisations } from "@/db/schema";
import { eq } from "drizzle-orm";

(async () => {
  const [o] = (await db.execute(sql`select id from organisations where name like 'Simulation SACCO%' order by created_at desc limit 1`)).rows as { id: string }[];
  const [org] = await db.select().from(organisations).where(eq(organisations.id, o.id));
  const [m] = (await db.execute(sql`select id from members where org_id=${o.id} order by member_no limit 1`)).rows as { id: string }[];
  const svc = { orgId: o.id, org, actor: { userId: null, name: "sim" } };
  for (const role of ROLES) {
    const email = `${role}@sim.test`;
    await addOrgUser(svc as never, { fullName: `Sim ${role}`, email, role, password: "Sim@12345", memberId: role === "member" ? m.id : undefined }).catch((e) => console.log(email, "->", (e as Error).message));
    console.log("login:", email);
  }
  await pool.end();
})();
