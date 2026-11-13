import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { announcements, contributionSchedules, groupMeetings, groupMembers, groups, loanApplications, loanProducts, loans, loanSchedule, members, notificationPrefs, notifications, savingsAccounts, savingsProducts, transactions, withdrawalRequests } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { ActionForm, Field, Grid, ModalForm, OptimisticRead, Select } from "@/components/forms";
import { Badge, Card, Empty, KV, Stat, TableWrap, one } from "@/components/ui";
import { portalApplyAction, portalPrefsAction, portalProfileAction, portalWithdrawAction } from "@/app/actions/portal";
import { markReadAction } from "@/app/actions/admin";
import { loanBalances } from "@/lib/services/loans";
import { todayEAT } from "@/lib/finance";
import { fmtDate, fmtDateTime, formatUgPhone, label, ugx } from "@/lib/format";

export const metadata = { title: "My account" };

export default async function Portal({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("portal.use");
  if (!ctx.memberId) redirect("/forbidden");
  const tab = one((await searchParams).tab) ?? "home";
  const today = todayEAT();
  const [m] = await db.select().from(members).where(and(eq(members.id, ctx.memberId), eq(members.orgId, ctx.orgId)));
  const accounts = await db.select({ a: savingsAccounts, p: savingsProducts.name }).from(savingsAccounts).innerJoin(savingsProducts, eq(savingsProducts.id, savingsAccounts.productId)).where(and(eq(savingsAccounts.memberId, m.id), eq(savingsAccounts.orgId, ctx.orgId)));
  const myLoans = await db.select().from(loans).where(and(eq(loans.memberId, m.id), eq(loans.orgId, ctx.orgId))).orderBy(desc(loans.disbursedAt));
  const total = accounts.reduce((s, a) => s + Number(a.a.balance), 0);
  const stmt = (f: string) => `/api/export/member_statement?memberId=${m.id}&range=all&format=${f}`;
  let body;
  if (tab === "savings") {
    const tx = await db.select().from(transactions).where(and(eq(transactions.memberId, m.id), eq(transactions.orgId, ctx.orgId))).orderBy(desc(transactions.createdAt)).limit(40);
    const wr = await db.select().from(withdrawalRequests).where(and(eq(withdrawalRequests.memberId, m.id), eq(withdrawalRequests.orgId, ctx.orgId))).orderBy(desc(withdrawalRequests.createdAt)).limit(10);
    body = (
      <div className="space-y-4">
        {accounts.map(({ a, p }) => <Card key={a.id}><div className="flex justify-between items-start gap-2"><div><p className="font-semibold">{p}</p><p className="text-xs text-muted num">{a.accountNo}</p></div><p className="text-lg font-semibold num">{ugx(a.balance)}</p></div>
          {a.status === "active" && m.status === "active" && <div className="mt-3"><ModalForm small variant="default" trigger="Request withdrawal" title={`Withdraw from ${a.accountNo}`} action={portalWithdrawAction} submit="Send request"><input type="hidden" name="accountId" value={a.id} /><Grid><Field label="Amount (UGX)" name="amount" required inputMode="numeric" /><Select label="Pay me via" name="channel" required defaultValue="mtn_momo" options={[{ value: "mtn_momo", label: "MTN Mobile Money" }, { value: "airtel_money", label: "Airtel Money" }, { value: "cash", label: "Cash at office" }, { value: "bank", label: "Bank" }]} /></Grid><Field label="Reason" name="reason" /><p className="hint">Available balance is {ugx(a.balance)}. An officer must approve before payout.</p></ModalForm></div>}</Card>)}
        <div className="flex gap-2"><a className="btn" href={stmt("pdf")}>Download statement (PDF)</a><a className="btn" href={stmt("csv")}>CSV</a></div>
        {wr.length > 0 && <Card title="My withdrawal requests" pad={false}><TableWrap><thead><tr><th>Date</th><th className="r">Amount</th><th>Status</th></tr></thead><tbody>{wr.map((r) => <tr key={r.id}><td>{fmtDate(r.createdAt.toISOString())}</td><td className="r num">{ugx(r.amount)}</td><td><Badge value={r.status} /></td></tr>)}</tbody></TableWrap></Card>}
        <Card title="Recent transactions" pad={false}>{tx.length === 0 ? <Empty title="No transactions yet" /> : <TableWrap><thead><tr><th>Date</th><th>Type</th><th className="r">Amount</th></tr></thead><tbody>{tx.map((t) => <tr key={t.id}><td>{fmtDate(t.txnDate)}</td><td>{label(t.type)}{t.status === "reversed" && " (reversed)"}<p className="text-xs text-muted num">{t.reference}</p></td><td className="r num">{ugx(t.amount)}</td></tr>)}</tbody></TableWrap>}</Card>
      </div>
    );
  } else if (tab === "loans") {
    const apps = await db.select({ a: loanApplications, p: loanProducts.name }).from(loanApplications).innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId)).where(and(eq(loanApplications.memberId, m.id), eq(loanApplications.orgId, ctx.orgId))).orderBy(desc(loanApplications.createdAt)).limit(10);
    const prods = await db.select().from(loanProducts).where(and(eq(loanProducts.orgId, ctx.orgId), eq(loanProducts.active, true)));
    const others = await db.select({ id: members.id, no: members.memberNo, name: members.fullName }).from(members).where(and(eq(members.orgId, ctx.orgId), eq(members.status, "active"))).orderBy(members.memberNo).limit(500);
    const details = await Promise.all(myLoans.filter((l) => l.status === "active").map(async (l) => ({ l, b: await loanBalances(l.id) })));
    body = (
      <div className="space-y-4">
        <ModalForm trigger="Apply for a loan" title="Loan application" action={portalApplyAction} submit="Submit application">
          <Select label="Loan product" name="productId" required options={prods.map((p) => ({ value: p.id, label: `${p.name} - ${Number(p.interestRate)}% ${p.interestMethod}, up to ${ugx(p.maxAmount)}` }))} />
          <Grid><Field label="Amount (UGX)" name="amount" required inputMode="numeric" /><Field label="Term (months)" name="termMonths" required inputMode="numeric" /></Grid>
          <Field label="Purpose" name="purpose" /><Grid><Select label="Guarantor (a member)" name="g1" options={others.filter((o) => o.id !== m.id).map((o) => ({ value: o.id, label: `${o.no} - ${o.name}` }))} /><Field label="Amount guaranteed (UGX)" name="ga1" inputMode="numeric" /></Grid>
          <p className="hint">Your eligibility is checked against your savings, membership age and any arrears.</p>
        </ModalForm>
        {details.map(({ l, b }) => <Card key={l.id} title={`Loan ${l.loanNo}`} actions={<Badge value={b.daysOverdue ? "overdue" : "active"} />}>
          <dl><KV k="Balance (principal + interest + penalties)">{ugx(b.total)}</KV><KV k="Overdue">{ugx(b.overdueAmount)}</KV><KV k="Rate">{Number(l.interestRate)}% {l.interestMethod}</KV></dl>
          <p className="lbl mt-3">Upcoming installments</p>
          <TableWrap><thead><tr><th>Due</th><th className="r">Amount due</th></tr></thead><tbody>{b.rows.filter((r) => r.principalDue + r.interestDue + r.penaltyAccrued > r.principalPaid + r.interestPaid + r.penaltyPaid).slice(0, 4).map((r) => <tr key={r.id}><td>{fmtDate(r.dueDate)} {r.dueDate < today && <Badge value="overdue" />}</td><td className="r num">{ugx(r.principalDue + r.interestDue + r.penaltyAccrued - r.principalPaid - r.interestPaid - r.penaltyPaid)}</td></tr>)}</tbody></TableWrap>
          <p className="hint mt-2">Pay via MTN/Airtel Mobile Money or at the office quoting loan {l.loanNo}; your officer posts and confirms the payment.</p>
        </Card>)}
        {details.length === 0 && myLoans.length === 0 && <Card><Empty title="No loans yet" /></Card>}
        <Card title="My applications" pad={false}>{apps.length === 0 ? <Empty title="No applications" /> : <TableWrap><thead><tr><th>No.</th><th>Product</th><th className="r">Amount</th><th>Status</th></tr></thead><tbody>{apps.map(({ a, p }) => <tr key={a.id}><td className="num">{a.applicationNo}</td><td>{p}</td><td className="r num">{ugx(a.amount)}</td><td><Badge value={a.status} />{a.reviewNote && <p className="text-xs text-muted">{a.reviewNote}</p>}</td></tr>)}</tbody></TableWrap>}</Card>
      </div>
    );
  } else if (tab === "alerts") {
    const nots = await db.select().from(notifications).where(and(eq(notifications.memberId, m.id), eq(notifications.orgId, ctx.orgId), eq(notifications.channel, "in_app"))).orderBy(desc(notifications.createdAt)).limit(30);
    body = <Card title="Notifications" pad={false}>{nots.length === 0 ? <Empty title="You are all caught up" /> : <ul>{nots.map((n) => <li key={n.id} className="px-4 py-3 border-b border-line last:border-0 flex justify-between gap-3"><div><p className="font-medium text-sm">{n.title}</p><p className="text-sm text-muted">{n.body}</p><p className="text-xs text-muted mt-1">{fmtDateTime(n.createdAt)}</p></div><OptimisticRead id={n.id} read={!!n.readAt} action={markReadAction} /></li>)}</ul>}</Card>;
  } else if (tab === "profile") {
    const [pref] = await db.select().from(notificationPrefs).where(eq(notificationPrefs.memberId, m.id));
    const p = pref ?? { sms: true, email: false, whatsapp: false };
    body = (
      <div className="space-y-4">
        <Card title="My details"><ActionForm action={portalProfileAction} submit="Update details"><p className="text-sm text-muted">Name, national ID and membership number can only be changed by the office.</p>
          <Grid><Field label="Phone" name="phone" required defaultValue={m.phone} inputMode="tel" /><Field label="Email" name="email" type="email" defaultValue={m.email} /><Field label="Address" name="address" defaultValue={m.address} /></Grid>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Next of kin</p><Grid cols={3}><Field label="Name" name="nokName" defaultValue={m.nokName} /><Field label="Phone" name="nokPhone" defaultValue={m.nokPhone} /><Field label="Relationship" name="nokRelationship" defaultValue={m.nokRelationship} /></Grid></ActionForm></Card>
        <Card title="Notification preferences"><ActionForm action={portalPrefsAction} submit="Save preferences">{(["sms", "email", "whatsapp"] as const).map((c) => <label key={c} className="flex gap-2 items-center text-sm"><input type="checkbox" name={c} defaultChecked={p[c]} /> {label(c)}</label>)}</ActionForm></Card>
      </div>
    );
  } else {
    const ann = await db.select().from(announcements).where(eq(announcements.orgId, ctx.orgId)).orderBy(desc(announcements.createdAt)).limit(3);
    const gids = (await db.select({ g: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.memberId, m.id))).map((x) => x.g);
    const meets = gids.length ? await db.select({ mt: groupMeetings, g: groups.name }).from(groupMeetings).innerJoin(groups, eq(groups.id, groupMeetings.groupId)).where(and(inArray(groupMeetings.groupId, gids), gte(groupMeetings.meetingDate, today), eq(groupMeetings.status, "scheduled"))).orderBy(groupMeetings.meetingDate).limit(3) : [];
    const [sch] = await db.select().from(contributionSchedules).where(and(eq(contributionSchedules.memberId, m.id), eq(contributionSchedules.active, true))).limit(1);
    const nextLoan = (await Promise.all(myLoans.filter((l) => l.status === "active").map((l) => loanBalances(l.id)))).flatMap((b) => b.rows.filter((r) => r.principalDue + r.interestDue > r.principalPaid + r.interestPaid)).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    const [unread] = await db.select({ n: sql<number>`count(*)` }).from(notifications).where(and(eq(notifications.memberId, m.id), eq(notifications.channel, "in_app"), sql`${notifications.readAt} is null`));
    body = (
      <div className="space-y-4">
        <div><p className="text-sm text-muted">Welcome back</p><h1 className="text-xl font-semibold">{m.fullName}</h1><p className="text-sm text-muted num">{m.memberNo} - {formatUgPhone(m.phone)}</p></div>
        {m.status !== "active" && <p className="text-sm bg-danger/10 text-danger rounded-lg px-3 py-2">Your membership is {m.status}. Contact the office.</p>}
        <div className="grid grid-cols-2 gap-3"><Stat label="Total savings" value={ugx(total)} /><Stat label="Loan balance" value={ugx(myLoans.filter((l) => l.status === "active").reduce((s, l) => s + Number(l.principal) - Number(l.principalPaid), 0))} sub="principal" /></div>
        <Card title="Upcoming deadlines">
          <ul className="text-sm space-y-2">{sch && <li className="flex justify-between"><span>Contribution {ugx(sch.amount)}</span><span className={sch.nextDue < today ? "text-danger font-medium" : ""}>{fmtDate(sch.nextDue)}{sch.nextDue < today && " (overdue)"}</span></li>}
            {nextLoan && <li className="flex justify-between"><span>Loan installment {ugx(nextLoan.principalDue + nextLoan.interestDue - nextLoan.principalPaid - nextLoan.interestPaid)}</span><span className={nextLoan.dueDate < today ? "text-danger font-medium" : ""}>{fmtDate(nextLoan.dueDate)}</span></li>}
            {meets.map(({ mt, g }) => <li key={mt.id} className="flex justify-between"><span>Meeting: {g}</span><span>{fmtDate(mt.meetingDate)}</span></li>)}
            {!sch && !nextLoan && meets.length === 0 && <li className="text-muted">Nothing due.</li>}</ul>
        </Card>
        <Card title="Announcements">{ann.length === 0 ? <p className="text-sm text-muted">None</p> : <ul className="space-y-3 text-sm">{ann.map((a) => <li key={a.id}><p className="font-medium">{a.title}</p><p className="text-muted">{a.body}</p></li>)}</ul>}</Card>
        <p className="text-sm"><Link className="text-brand underline" href="/portal?tab=alerts">{Number(unread.n)} unread notification(s)</Link></p>
      </div>
    );
  }
  return body;
}
