import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { loanProducts, loanRepayments, loans, members, transactions } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ConfirmAction, Field, Grid, ModalForm, Select } from "@/components/forms";
import { CHANNEL_OPTIONS, MoneyFields } from "@/components/fields";
import { Badge, Card, Empty, KV, PageHeader, Stat, TableWrap } from "@/components/ui";
import { repayAction, restructureAction, settleLoanAction } from "@/app/actions/finance";
import { loanBalances } from "@/lib/services/loans";
import { earlySettlement, todayEAT } from "@/lib/finance";
import { fmtDate, label, ugx } from "@/lib/format";

export default async function LoanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePage("loans.view");
  const [row] = await db.select({ l: loans, m: members.fullName, mno: members.memberNo, p: loanProducts.name }).from(loans).innerJoin(members, eq(members.id, loans.memberId)).innerJoin(loanProducts, eq(loanProducts.id, loans.productId)).where(and(eq(loans.id, id), eq(loans.orgId, ctx.orgId)));
  if (!row) notFound();
  const { l } = row;
  const bal = await loanBalances(id);
  const reps = await db.select({ r: loanRepayments, t: transactions.reference, ch: transactions.channel }).from(loanRepayments).innerJoin(transactions, eq(transactions.id, loanRepayments.transactionId)).where(eq(loanRepayments.loanId, id)).orderBy(desc(loanRepayments.paidAt));
  const today = todayEAT();
  const settle = earlySettlement(bal.rows, today);
  const active = l.status === "active";
  const q = `loanId=${l.id}&range=all`;
  return (
    <>
      <PageHeader title={`Loan ${l.loanNo}`} sub={<><Link className="text-brand hover:underline" href={`/members/${l.memberId}`}>{row.m}</Link> ({row.mno}) - {row.p} - <Badge value={l.status} /></>} actions={<>
        <Link className="btn" href={`/api/export/repayment_schedule?${q}&format=pdf`}>Statement (PDF)</Link><Link className="btn" href={`/api/export/repayment_schedule?${q}&format=xlsx`}>Excel</Link>
        {active && can(ctx.role, "loans.repay") && <ModalForm trigger="Record repayment" title={`Repayment - ${l.loanNo}`} action={repayAction}>
          <input type="hidden" name="id" value={l.id} /><p className="text-sm text-muted">Allocated oldest installment first: penalty, then interest, then principal. Amounts above the due installments prepay future installments. Maximum {ugx(bal.total)}.</p><MoneyFields /></ModalForm>}
        {active && can(ctx.role, "loans.repay") && <ModalForm variant="default" trigger="Settle early" title="Early settlement" action={settleLoanAction} submit={`Pay ${ugx(settle.total)} and close`}>
          <input type="hidden" name="id" value={l.id} />
          <dl><KV k="Principal outstanding">{ugx(settle.principal)}</KV><KV k="Interest due to date">{ugx(settle.interest)}</KV><KV k="Penalties">{ugx(settle.penalty)}</KV><KV k="Future interest rebated">{ugx(settle.rebate)}</KV><KV k="Settlement amount"><b>{ugx(settle.total)}</b></KV></dl>
          <Select label="Channel" name="channel" required defaultValue="cash" options={CHANNEL_OPTIONS} /></ModalForm>}
        {active && can(ctx.role, "loans.restructure") && <ModalForm variant="default" trigger="Restructure" title="Restructure loan" action={restructureAction}>
          <input type="hidden" name="id" value={l.id} /><p className="text-sm text-muted">Closes this loan and creates a new one for the outstanding principal ({ugx(bal.outstanding.principal)}) with a fresh schedule. Interest and penalty arrears must be waived (recorded in the audit trail).</p>
          <Grid><Field label="New term (months)" name="term" required inputMode="numeric" defaultValue={l.termMonths} /><Field label="New rate (% p.a., optional)" name="rate" inputMode="decimal" defaultValue={Number(l.interestRate)} /></Grid>
          <label className="flex gap-2 items-center text-sm"><input type="checkbox" name="waive" /> Waive interest and penalty arrears ({ugx(bal.outstanding.penalty)} penalties)</label>
          <Field label="Reason" name="reason" required /></ModalForm>}
      </>} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Stat label="Principal outstanding" value={ugx(active ? bal.outstanding.principal : 0)} sub={`of ${ugx(l.principal)}`} />
        <Stat label="Interest outstanding" value={ugx(active ? bal.outstanding.interest : 0)} /><Stat label="Penalties outstanding" value={ugx(active ? bal.outstanding.penalty : 0)} tone={bal.outstanding.penalty ? "warn" : undefined} />
        <Stat label="Overdue now" value={ugx(active ? bal.overdueAmount : 0)} tone={bal.overdueAmount ? "danger" : "ok"} sub={bal.daysOverdue ? `${bal.daysOverdue} days in arrears` : "Up to date"} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Terms"><dl><KV k="Principal">{ugx(l.principal)}</KV><KV k="Interest">{Number(l.interestRate)}% p.a. {l.interestMethod}</KV><KV k="Term">{l.termMonths} months ({l.frequency})</KV><KV k="Disbursed">{fmtDate(l.disbursedAt)}</KV><KV k="Penalty">{Number(l.penaltyRatePct)}% per 30 days overdue after {l.graceDays} grace days</KV><KV k="Paid to date">{ugx(Number(l.principalPaid) + Number(l.interestPaid) + Number(l.penaltyPaid))}</KV></dl></Card>
        <Card title="Repayment history" className="lg:col-span-2" pad={false}>
          {reps.length === 0 ? <Empty title="No repayments yet" /> : <TableWrap><thead><tr><th>Date</th><th>Reference</th><th>Channel</th><th className="r">Amount</th><th className="r">Principal</th><th className="r">Interest</th><th className="r">Penalty</th></tr></thead>
            <tbody>{reps.map(({ r, t, ch }) => <tr key={r.id} className={r.reversed ? "opacity-50 line-through" : ""}><td>{fmtDate(r.paidAt)}</td><td className="num text-xs">{t}</td><td>{label(ch)}</td><td className="r num">{ugx(r.amount)}</td><td className="r num">{ugx(r.principal)}</td><td className="r num">{ugx(r.interest)}</td><td className="r num">{ugx(r.penalty)}</td></tr>)}</tbody></TableWrap>}
        </Card>
      </div>
      <Card title="Repayment schedule" className="mt-4" pad={false}>
        <TableWrap><thead><tr><th>#</th><th>Due date</th><th className="r">Principal</th><th className="r">Interest</th><th className="r">Penalty</th><th className="r">Total due</th><th className="r">Paid</th><th className="r">Balance</th><th>Status</th></tr></thead>
          <tbody>{bal.rows.map((r) => {
            const due = r.principalDue + r.interestDue + r.penaltyAccrued, paid = r.principalPaid + r.interestPaid + r.penaltyPaid, left = due - paid;
            const overdue = r.dueDate < today && left > 0;
            return <tr key={r.id}><td>{r.installmentNo}</td><td>{fmtDate(r.dueDate)}</td><td className="r num">{ugx(r.principalDue)}</td><td className="r num">{ugx(r.interestDue)}</td><td className="r num">{r.penaltyAccrued ? ugx(r.penaltyAccrued) : "-"}</td><td className="r num">{ugx(due)}</td><td className="r num">{ugx(paid)}</td><td className="r num">{ugx(left)}</td><td>{left <= 0 ? <Badge value="paid" /> : overdue ? <Badge value="overdue" /> : paid > 0 ? <Badge value="partial" /> : <Badge value="pending" />}</td></tr>;
          })}</tbody></TableWrap>
      </Card>
    </>
  );
}
void ConfirmAction;
