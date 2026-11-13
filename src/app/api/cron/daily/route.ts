import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organisations } from "@/db/schema";
import { accruePenalties, sendRepaymentReminders } from "@/lib/services/loans";
import { runContributionAlerts } from "@/lib/services/savings";
import { dispatchQueued } from "@/lib/services/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Daily automation for every active organisation: penalties, overdue alerts, reminders, delivery. Protect with CRON_SECRET (Vercel Cron sends it as a Bearer token). */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorised", { status: 401 });
  const orgs = await db.select({ id: organisations.id }).from(organisations).where(eq(organisations.status, "active"));
  const results = [];
  for (const o of orgs) {
    try {
      const p = await accruePenalties(o.id);
      const r = await sendRepaymentReminders(o.id);
      const c = await runContributionAlerts(o.id);
      const d = await dispatchQueued(o.id, 500);
      results.push({ org: o.id, penalties: p.charged, reminders: r, contributionAlerts: c, delivery: d });
    } catch (e) { results.push({ org: o.id, error: (e as Error).message }); }
  }
  return Response.json({ ok: true, organisations: results.length, results });
}
