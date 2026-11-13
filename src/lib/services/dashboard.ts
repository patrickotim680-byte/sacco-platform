import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { groupCycles } from "@/db/schema";
import type { Org } from "@/lib/core";
import { addDays, addMonths, daysBetween, parBucket, todayEAT } from "@/lib/finance";

export type Range = { from: string; to: string; label: string; key: string; cycleId?: string };
export type RangeParams = { range?: string; from?: string; to?: string; cycle?: string };

function fyBounds(startMonth: number, ref: string) {
  const [y, m] = ref.split("-").map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const from = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  const to = addDays(addMonths(from, 12), -1);
  return { from, to };
}

export async function resolveRange(org: Pick<Org, "id" | "financialYearStartMonth">, p: RangeParams): Promise<Range> {
  const today = todayEAT();
  const key = p.range ?? "this_month";
  if (p.cycle) {
    const [c] = await db.select().from(groupCycles).where(and(eq(groupCycles.id, p.cycle), eq(groupCycles.orgId, org.id)));
    if (c) return { from: c.startDate, to: c.endDate < today ? c.endDate : today, label: `Savings cycle: ${c.name}`, key: "cycle", cycleId: c.id };
  }
  const month = today.slice(0, 7) + "-01";
  switch (key) {
    case "last_30": return { from: addDays(today, -30), to: today, label: "Last 30 days", key };
    case "fy": { const f = fyBounds(org.financialYearStartMonth, today); return { from: f.from, to: today < f.to ? today : f.to, label: `Financial year ${f.from.slice(0, 4)}/${f.to.slice(2, 4)}`, key }; }
    case "last_fy": { const f = fyBounds(org.financialYearStartMonth, addMonths(today, -12)); return { from: f.from, to: f.to, label: `Last financial year ${f.from.slice(0, 4)}/${f.to.slice(2, 4)}`, key }; }
    case "all": return { from: "2000-01-01", to: today, label: "All time", key };
    case "custom":
      if (p.from && p.to && p.from <= p.to) return { from: p.from, to: p.to, label: `${p.from} to ${p.to}`, key };
      return { from: month, to: today, label: "This month", key: "this_month" };
    default: return { from: month, to: today, label: "This month", key: "this_month" };
  }
}

const rows = async <T,>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];
const N = (v: unknown) => Number(v ?? 0);

export async function dashboardData(orgId: string, r: Range) {
  const today = todayEAT();
  const [mem] = await rows<{ total: string; active: string; newc: string }>(sql`
    select count(*) total, count(*) filter (where status='active') active, count(*) filter (where joined_at between ${r.from} and ${r.to}) newc from members where org_id=${orgId}`);
  const growth = await rows<{ m: string; c: string }>(sql`
    select to_char(d, 'YYYY-MM') m, (select count(*) from members where org_id=${orgId} and joined_at < (d + interval '1 month')::date) c
    from generate_series(date_trunc('month', ${today}::date) - interval '11 months', date_trunc('month', ${today}::date), interval '1 month') d order by 1`);
  const [sv] = await rows<{ s: string }>(sql`select coalesce(sum(balance),0) s from savings_accounts where org_id=${orgId} and status='active'`);
  const flows = await rows<{ type: string; s: string; c: string }>(sql`
    select type, coalesce(sum(amount),0) s, count(*) c from transactions where org_id=${orgId} and status='completed' and txn_date between ${r.from} and ${r.to}
    and type in ('deposit','withdrawal','loan_disbursement','loan_repayment','interest','income','expense') group by type`);
  const f = (t: string) => N(flows.find((x) => x.type === t)?.s);
  const [ln] = await rows<{ out: string; n: string; interest: string; pen: string }>(sql`
    select coalesce(sum(l.principal - l.principal_paid),0) out, count(*) n,
      coalesce((select sum(s.interest_due - s.interest_paid) from loan_schedule s join loans l2 on l2.id=s.loan_id where l2.org_id=${orgId} and l2.status='active' and s.status<>'superseded'),0) interest,
      coalesce((select sum(s.penalty_accrued - s.penalty_paid) from loan_schedule s join loans l2 on l2.id=s.loan_id where l2.org_id=${orgId} and l2.status='active'),0) pen
    from loans l where l.org_id=${orgId} and l.status='active'`);
  const par = await rows<{ out: string; days: string | null }>(sql`
    with od as (
      select s.loan_id, min(s.due_date) first_due, sum(s.principal_due + s.interest_due - s.principal_paid - s.interest_paid) amt from loan_schedule s join loans l on l.id=s.loan_id
      where s.org_id=${orgId} and l.status='active' and s.status in ('pending','partial') and s.due_date < ${today}::date and (s.principal_paid + s.interest_paid < s.principal_due + s.interest_due) group by s.loan_id)
    select (l.principal - l.principal_paid) out, case when od.first_due is null then null else (${today}::date - od.first_due) end days, od.amt
    from loans l left join od on od.loan_id=l.id where l.org_id=${orgId} and l.status='active'`);
  const buckets: Record<string, number> = { Current: 0, "1-30 days": 0, "31-60 days": 0, "61-90 days": 0, "90+ days (NPL)": 0 };
  let overdueCount = 0;
  for (const p of par) { buckets[parBucket(p.days === null ? 0 : N(p.days))] += N(p.out); if (p.days !== null) overdueCount++; }
  const [odAmt] = await rows<{ a: string }>(sql`
    select coalesce(sum(s.principal_due + s.interest_due - s.principal_paid - s.interest_paid),0) a from loan_schedule s join loans l on l.id=s.loan_id
    where s.org_id=${orgId} and l.status='active' and s.status in ('pending','partial') and s.due_date < ${today}::date`);
  const loanTotal = Object.values(buckets).reduce((a, b) => a + b, 0);
  const [coll] = await rows<{ due: string; paid: string }>(sql`
    select coalesce(sum(s.principal_due + s.interest_due),0) due, coalesce(sum(least(s.principal_paid + s.interest_paid, s.principal_due + s.interest_due)),0) paid
    from loan_schedule s join loans l on l.id=s.loan_id where s.org_id=${orgId} and l.status in ('active','closed') and s.due_date between ${r.from} and ${r.to} and s.due_date <= ${today}::date and s.status <> 'superseded'`);
  const cash = await rows<{ code: string; name: string; bal: string }>(sql`
    select a.code, a.name, coalesce(sum(l.debit - l.credit),0) bal from gl_accounts a left join journal_lines l on l.account_id=a.id
    where a.org_id=${orgId} and a.is_cash group by a.code, a.name order by a.code`);
  const gl = await rows<{ type: string; amt: string }>(sql`
    select a.type, coalesce(sum(case when a.type='income' then l.credit - l.debit else l.debit - l.credit end),0) amt
    from journal_lines l join journal_entries e on e.id=l.entry_id join gl_accounts a on a.id=l.account_id
    where l.org_id=${orgId} and a.type in ('income','expense') and e.entry_date between ${r.from} and ${r.to} group by a.type`);
  const income = N(gl.find((x) => x.type === "income")?.amt), expense = N(gl.find((x) => x.type === "expense")?.amt);
  const trend = await rows<{ m: string; deposits: string; withdrawals: string; repayments: string; disbursed: string }>(sql`
    select to_char(d,'YYYY-MM') m,
      coalesce((select sum(amount) from transactions t where t.org_id=${orgId} and t.status='completed' and t.type='deposit' and date_trunc('month', t.txn_date)=d),0) deposits,
      coalesce((select sum(amount) from transactions t where t.org_id=${orgId} and t.status='completed' and t.type='withdrawal' and date_trunc('month', t.txn_date)=d),0) withdrawals,
      coalesce((select sum(amount) from transactions t where t.org_id=${orgId} and t.status='completed' and t.type='loan_repayment' and date_trunc('month', t.txn_date)=d),0) repayments,
      coalesce((select sum(amount) from transactions t where t.org_id=${orgId} and t.status='completed' and t.type='loan_disbursement' and date_trunc('month', t.txn_date)=d),0) disbursed
    from generate_series(date_trunc('month', ${today}::date) - interval '11 months', date_trunc('month', ${today}::date), interval '1 month') d order by 1`);
  const ie = await rows<{ m: string; income: string; expense: string }>(sql`
    select to_char(d,'YYYY-MM') m,
      coalesce((select sum(l.credit - l.debit) from journal_lines l join journal_entries e on e.id=l.entry_id join gl_accounts a on a.id=l.account_id where l.org_id=${orgId} and a.type='income' and date_trunc('month', e.entry_date)=d),0) income,
      coalesce((select sum(l.debit - l.credit) from journal_lines l join journal_entries e on e.id=l.entry_id join gl_accounts a on a.id=l.account_id where l.org_id=${orgId} and a.type='expense' and date_trunc('month', e.entry_date)=d),0) expense
    from generate_series(date_trunc('month', ${today}::date) - interval '11 months', date_trunc('month', ${today}::date), interval '1 month') d order by 1`);
  const byProduct = await rows<{ name: string; s: string; c: string }>(sql`
    select p.name, coalesce(sum(a.balance),0) s, count(*) c from savings_accounts a join savings_products p on p.id=a.product_id where a.org_id=${orgId} and a.status='active' group by p.name order by 2 desc`);
  const recent = await rows<{ id: string; reference: string; type: string; amount: string; channel: string; txn_date: string; status: string; member: string | null }>(sql`
    select t.id, t.reference, t.type, t.amount, t.channel, t.txn_date, t.status, m.full_name member from transactions t left join members m on m.id=t.member_id
    where t.org_id=${orgId} order by t.created_at desc limit 8`);
  const [pend] = await rows<{ w: string; a: string; f: string; p: string }>(sql`
    select (select count(*) from withdrawal_requests where org_id=${orgId} and status='pending') w,
           (select count(*) from loan_applications where org_id=${orgId} and status in ('pending','under_review')) a,
           (select count(*) from fraud_flags where org_id=${orgId} and status='open') f,
           (select count(*) from payment_requests where org_id=${orgId} and status in ('awaiting_confirmation','pending_provider')) p`);
  return {
    members: { total: N(mem.total), active: N(mem.active), new: N(mem.newc), growth: growth.map((g) => ({ label: g.m, value: N(g.c) })) },
    savingsTotal: N(sv.s), contributions: f("deposit"), withdrawals: f("withdrawal"), interestPosted: f("interest"),
    loans: { outstanding: N(ln.out), count: N(ln.n), disbursed: f("loan_disbursement"), repayments: f("loan_repayment"), overdueCount, overdueAmount: N(odAmt.a), interestOutstanding: N(ln.interest), penalties: N(ln.pen),
      buckets: Object.entries(buckets).map(([label, value]) => ({ label, value })), parPct: loanTotal ? ((loanTotal - buckets.Current) / loanTotal) * 100 : 0, nplPct: loanTotal ? (buckets["90+ days (NPL)"] / loanTotal) * 100 : 0 },
    collection: { due: N(coll.due), paid: N(coll.paid), rate: N(coll.due) ? (N(coll.paid) / N(coll.due)) * 100 : null },
    cash: cash.map((c) => ({ code: c.code, name: c.name, balance: N(c.bal) })), cashTotal: cash.reduce((s, c) => s + N(c.bal), 0),
    income, expense,
    trend: trend.map((t) => ({ label: t.m, deposits: N(t.deposits), withdrawals: N(t.withdrawals), repayments: N(t.repayments), disbursed: N(t.disbursed) })),
    ie: ie.map((t) => ({ label: t.m, income: N(t.income), expense: N(t.expense) })),
    byProduct: byProduct.map((p) => ({ label: p.name, value: N(p.s), count: N(p.c) })),
    recent, pending: { withdrawals: N(pend.w), applications: N(pend.a), flags: N(pend.f), payments: N(pend.p) },
    daysInRange: daysBetween(r.from, r.to) + 1,
  };
}
