import Link from "next/link";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { loans, members } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ActionForm } from "@/components/forms";
import { Badge, Card, Empty, FilterBar, FilterField, PageHeader, Pagination, Stat, TableWrap, one, pageParam } from "@/components/ui";
import { runContributionAlertsAction } from "@/app/actions/finance";
import { fmtDate, ugx } from "@/lib/format";
import { todayEAT } from "@/lib/finance";

export const metadata = { title: "Loans" };
const PAGE = 25;

export default async function LoansPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("loans.view");
  const sp = await searchParams;
  const status = one(sp.status), overdue = one(sp.overdue), q = one(sp.q)?.trim(), page = pageParam(sp.page);
  const today = todayEAT();
  const od = sql`(select min(s.due_date) from loan_schedule s where s.loan_id = ${loans.id} and s.status in ('pending','partial') and s.due_date < ${today}::date and s.principal_paid + s.interest_paid < s.principal_due + s.interest_due)`;
  const where = and(eq(loans.orgId, ctx.orgId), status ? eq(loans.status, status) : undefined, overdue ? sql`${od} is not null and ${loans.status} = 'active'` : undefined, q ? or(ilike(members.fullName, `%${q}%`), ilike(loans.loanNo, `%${q}%`), ilike(members.memberNo, `%${q}%`)) : undefined);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(loans).innerJoin(members, eq(members.id, loans.memberId)).where(where);
  const rows = await db.select({
    l: loans, m: members.fullName, mid: members.id,
    firstOverdue: sql<string | null>`${od}`,
    penalty: sql<string>`coalesce((select sum(penalty_accrued - penalty_paid) from loan_schedule s where s.loan_id = ${loans.id}),0)`,
    interest: sql<string>`coalesce((select sum(interest_due - interest_paid) from loan_schedule s where s.loan_id = ${loans.id} and s.status <> 'superseded'),0)`,
  }).from(loans).innerJoin(members, eq(members.id, loans.memberId)).where(where).orderBy(desc(loans.loanNo)).limit(PAGE).offset((page - 1) * PAGE);
  const [sum] = await db.select({ out: sql<string>`coalesce(sum(principal - principal_paid) filter (where status='active'),0)`, disbursed: sql<string>`coalesce(sum(principal),0)`, active: sql<number>`count(*) filter (where status='active')`, closed: sql<number>`count(*) filter (where status='closed')` }).from(loans).where(eq(loans.orgId, ctx.orgId));
  return (
    <>
      <PageHeader title="Loans" sub="Portfolio of disbursed loans with live balances calculated from repayment schedules." actions={<>
        {can(ctx.role, "loans.review") && <Link className="btn btn-primary" href="/loans/applications">Applications and new loan</Link>}
        {can(ctx.role, "notifications.send") && <ActionForm action={runContributionAlertsAction} submit="Run overdue check and penalties" inline reset={false}><span /></ActionForm>}
      </>} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="Principal outstanding" value={ugx(sum.out)} /><Stat label="Total ever disbursed" value={ugx(sum.disbursed)} /><Stat label="Active loans" value={Number(sum.active)} /><Stat label="Closed loans" value={Number(sum.closed)} />
      </div>
      <FilterBar action="/loans">
        <FilterField label="Search" name="q"><input id="q" name="q" defaultValue={q} className="input" placeholder="Loan no, member name or number" /></FilterField>
        <FilterField label="Status" name="status"><select id="status" name="status" defaultValue={status ?? ""} className="input"><option value="">All</option><option value="active">Active</option><option value="closed">Closed</option><option value="restructured">Restructured</option></select></FilterField>
        <FilterField label="Arrears" name="overdue"><select id="overdue" name="overdue" defaultValue={overdue ?? ""} className="input"><option value="">All loans</option><option value="1">Overdue only</option></select></FilterField>
      </FilterBar>
      <Card pad={false}>
        {rows.length === 0 ? <Empty title="No loans found">Approved applications become loans when they are disbursed.</Empty> : (
          <TableWrap><thead><tr><th>Loan</th><th>Member</th><th>Disbursed</th><th className="r">Principal</th><th className="r">Principal o/s</th><th className="r">Interest o/s</th><th className="r">Penalty o/s</th><th>Arrears</th><th>Status</th></tr></thead>
            <tbody>{rows.map(({ l, m, mid, firstOverdue, penalty, interest }) => {
              const days = firstOverdue ? Math.round((new Date(today).getTime() - new Date(firstOverdue).getTime()) / 864e5) : 0;
              return <tr key={l.id}><td><Link className="text-brand font-medium hover:underline" href={`/loans/${l.id}`}>{l.loanNo}</Link></td><td><Link className="hover:underline" href={`/members/${mid}`}>{m}</Link></td><td>{fmtDate(l.disbursedAt)}</td><td className="r num">{ugx(l.principal)}</td><td className="r num">{l.status === "active" ? ugx(Number(l.principal) - Number(l.principalPaid)) : "-"}</td><td className="r num">{l.status === "active" ? ugx(interest) : "-"}</td><td className="r num">{Number(penalty) && l.status === "active" ? ugx(penalty) : "-"}</td>
                <td>{l.status === "active" && days > 0 ? <Badge value={`${days} days`} tone={days > 90 ? "badge-danger" : "badge-warn"} /> : "-"}</td><td><Badge value={l.status} /></td></tr>;
            })}</tbody></TableWrap>
        )}
        <Pagination page={page} pages={Math.ceil(Number(n) / PAGE)} total={Number(n)} params={{ q, status, overdue }} base="/loans" />
      </Card>
    </>
  );
}
