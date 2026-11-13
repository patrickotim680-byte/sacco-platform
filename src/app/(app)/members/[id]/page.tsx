import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { loans, memberDocuments, members, notificationPrefs, orgUsers, savingsAccounts, savingsProducts, transactions } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ConfirmAction, Field, Grid, ModalForm, Select } from "@/components/forms";
import { Badge, Card, Empty, KV, Money, PageHeader, TableWrap } from "@/components/ui";
import { MemberFields, MoneyFields, CHANNEL_OPTIONS } from "@/components/fields";
import { createPortalLoginAction, memberPrefsAction, memberStatusAction, openAccountAction, updateMemberAction } from "@/app/actions/members";
import { depositAction, requestWithdrawalAction, setScheduleAction } from "@/app/actions/finance";
import { fmtDate, formatUgPhone, label, ugx } from "@/lib/format";
import { todayEAT } from "@/lib/finance";

export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePage("members.view");
  const [m] = await db.select().from(members).where(and(eq(members.id, id), eq(members.orgId, ctx.orgId)));
  if (!m) notFound();
  const [accounts, memberLoans, txns, docs, products, prefs, login] = await Promise.all([
    db.select({ a: savingsAccounts, p: savingsProducts.name, plan: savingsProducts.planType }).from(savingsAccounts).innerJoin(savingsProducts, eq(savingsProducts.id, savingsAccounts.productId)).where(eq(savingsAccounts.memberId, id)),
    db.select().from(loans).where(eq(loans.memberId, id)).orderBy(desc(loans.disbursedAt)),
    db.select().from(transactions).where(and(eq(transactions.memberId, id), eq(transactions.orgId, ctx.orgId))).orderBy(desc(transactions.createdAt)).limit(25),
    db.select().from(memberDocuments).where(and(eq(memberDocuments.memberId, id), eq(memberDocuments.orgId, ctx.orgId))).orderBy(desc(memberDocuments.createdAt)),
    db.select().from(savingsProducts).where(and(eq(savingsProducts.orgId, ctx.orgId), eq(savingsProducts.active, true))),
    db.select().from(notificationPrefs).where(eq(notificationPrefs.memberId, id)),
    db.select({ id: orgUsers.id }).from(orgUsers).where(and(eq(orgUsers.memberId, id), eq(orgUsers.orgId, ctx.orgId))),
  ]);
  const total = accounts.reduce((s, a) => s + Number(a.a.balance), 0);
  const loanOut = memberLoans.filter((l) => l.status === "active").reduce((s, l) => s + Number(l.principal) - Number(l.principalPaid), 0);
  const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(transactions).where(eq(transactions.memberId, id));
  const canManage = can(ctx.role, "members.manage");
  const accOptions = accounts.filter((a) => a.a.status === "active").map((a) => ({ value: a.a.id, label: `${a.a.accountNo} - ${a.p} (${ugx(a.a.balance)})` }));
  const pref = prefs[0] ?? { sms: true, email: false, whatsapp: false };
  return (
    <>
      <PageHeader title={m.fullName} sub={<><span className="num">{m.memberNo}</span> - joined {fmtDate(m.joinedAt)} - <Badge value={m.status} /></>} actions={<>
        <Link className="btn" href={`/api/export/member_statement?memberId=${m.id}&format=pdf&range=all`}>Statement (PDF)</Link>
        <Link className="btn" href={`/api/export/member_statement?memberId=${m.id}&format=csv&range=all`}>CSV</Link>
        {canManage && <ModalForm wide trigger="Edit" title="Edit member" action={updateMemberAction} variant="default"><input type="hidden" name="id" value={m.id} /><MemberFields m={m} /></ModalForm>}
        {can(ctx.role, "members.status") && (m.status === "active"
          ? <><ConfirmAction action={memberStatusAction} fields={{ id: m.id, status: "suspended" }} label="Suspend" danger message="Suspended members cannot withdraw or borrow and their contribution alerts stop. This is recorded in the audit trail." reason /></>
          : m.status === "suspended" ? <ConfirmAction action={memberStatusAction} fields={{ id: m.id, status: "active" }} label="Reactivate" variant="primary" message="Restore this member to active status." reason /> : null)}
        {can(ctx.role, "members.status") && m.status !== "exited" && <ConfirmAction action={memberStatusAction} fields={{ id: m.id, status: "exited" }} label="Record exit" danger message="Only possible when the member has no active loans and no savings balance." reason />}
      </>} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <div className="card card-pad"><p className="text-xs text-muted">Total savings</p><p className="text-xl font-semibold num">{ugx(total)}</p></div>
        <div className="card card-pad"><p className="text-xs text-muted">Loan principal outstanding</p><p className="text-xl font-semibold num">{ugx(loanOut)}</p></div>
        <div className="card card-pad"><p className="text-xs text-muted">Savings accounts</p><p className="text-xl font-semibold">{accounts.length}</p></div>
        <div className="card card-pad"><p className="text-xs text-muted">Transactions</p><p className="text-xl font-semibold">{Number(cnt.n)}</p></div>
      </div>
      {m.status === "suspended" && <p className="mb-4 text-sm bg-danger/10 text-danger border border-danger/30 rounded-lg px-3 py-2">Suspended: {m.statusReason}</p>}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card title="Personal details"><dl>
          <KV k="Phone">{formatUgPhone(m.phone)}</KV><KV k="Email">{m.email ?? "-"}</KV><KV k="Gender">{label(m.gender) || "-"}</KV><KV k="Date of birth">{fmtDate(m.dateOfBirth)}</KV>
          <KV k="National ID">{m.nationalId ?? "-"}</KV><KV k="Occupation">{m.occupation ?? "-"}</KV><KV k="District">{m.district ?? "-"}</KV><KV k="Address">{m.address ?? "-"}</KV>
        </dl></Card>
        <Card title="Next of kin"><dl><KV k="Name">{m.nokName ?? "-"}</KV><KV k="Phone">{formatUgPhone(m.nokPhone)}</KV><KV k="Relationship">{m.nokRelationship ?? "-"}</KV></dl>
          <div className="mt-4 flex flex-wrap gap-2">
            {canManage && <ModalForm trigger="Notification preferences" title="Notification preferences" action={memberPrefsAction} variant="default" small>
              <input type="hidden" name="memberId" value={m.id} />
              {(["sms", "email", "whatsapp"] as const).map((c) => <label key={c} className="flex gap-2 items-center text-sm"><input type="checkbox" name={c} defaultChecked={pref[c]} /> {label(c)}</label>)}
            </ModalForm>}
            {can(ctx.role, "users.manage") && login.length === 0 && <ModalForm trigger="Create portal login" title="Member portal login" action={createPortalLoginAction} variant="default" small>
              <input type="hidden" name="memberId" value={m.id} />
              <Field label="Display name" name="fullName" required defaultValue={m.fullName} /><Field label="Login email" name="email" type="email" required defaultValue={m.email} />
              <Field label="Temporary password" name="password" type="text" required hint="Share securely; the member should change it after first login" />
            </ModalForm>}
            {login.length > 0 && <span className="badge badge-ok">Portal login active</span>}
          </div></Card>
        <Card title="Documents">
          {docs.length === 0 ? <p className="text-sm text-muted">No documents uploaded.</p> : <ul className="text-sm space-y-1 mb-3">{docs.map((d) => <li key={d.id} className="flex justify-between gap-2"><a className="text-brand hover:underline truncate" href={`/api/documents/${d.id}`}>{d.fileName}</a><span className="text-muted">{label(d.kind)}</span></li>)}</ul>}
          {canManage && (
            <form action={`/api/members/${m.id}/documents`} method="post" encType="multipart/form-data" className="space-y-2">
              <select name="kind" className="input"><option value="national_id">National ID</option><option value="photo">Photograph</option><option value="loan_form">Application form</option><option value="other">Other</option></select>
              <input type="file" name="file" required accept="image/png,image/jpeg,application/pdf" className="input" />
              <button className="btn btn-sm" type="submit">Upload (PNG, JPG or PDF, max 3 MB)</button>
            </form>
          )}
        </Card>
      </div>
      <Card title="Savings accounts" className="mt-4" pad={false} actions={canManage && products.length > 0 && <ModalForm small trigger="Open account" title="Open savings account" action={openAccountAction} variant="default"><input type="hidden" name="memberId" value={m.id} /><Select label="Savings product" name="productId" required options={products.map((p) => ({ value: p.id, label: `${p.name} (${p.planType}, ${p.interestRate}% p.a.)` }))} /></ModalForm>}>
        {accounts.length === 0 ? <Empty title="No savings accounts">Open an account to start recording deposits.</Empty> : (
          <TableWrap><thead><tr><th>Account</th><th>Product</th><th>Opened</th><th className="r">Balance</th><th>Status</th><th className="r">Actions</th></tr></thead>
            <tbody>{accounts.map(({ a, p, plan }) => (
              <tr key={a.id}><td className="num">{a.accountNo}</td><td>{p}{plan === "fixed" && a.maturityDate ? <span className="text-muted"> (matures {fmtDate(a.maturityDate)})</span> : null}</td><td>{fmtDate(a.openedAt)}</td><td className="r num">{ugx(a.balance)}</td><td><Badge value={a.status} /></td>
                <td className="r"><div className="flex gap-1.5 justify-end flex-wrap">
                  {can(ctx.role, "savings.deposit") && a.status === "active" && <ModalForm small trigger="Deposit" title={`Deposit to ${a.accountNo}`} action={depositAction}><input type="hidden" name="accountId" value={a.id} /><MoneyFields /><Field label="Narration" name="description" /></ModalForm>}
                  {can(ctx.role, "savings.withdraw.request") && a.status === "active" && <ModalForm small variant="default" trigger="Withdraw" title={`Withdrawal request - ${a.accountNo}`} action={requestWithdrawalAction}><input type="hidden" name="accountId" value={a.id} /><MoneyFields withDuplicate={false} withDate={false} withRef={false} /><Field label="Reason" name="reason" /><p className="hint">Withdrawals are approved by a second officer before money is paid out.</p></ModalForm>}
                  {can(ctx.role, "savings.products") && <ModalForm small variant="default" trigger="Schedule" title={`Contribution schedule - ${a.accountNo}`} action={setScheduleAction}><input type="hidden" name="accountId" value={a.id} /><Grid><Field label="Amount per period (UGX)" name="amount" required inputMode="numeric" /><Select label="Frequency" name="frequency" required defaultValue="monthly" options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "custom", label: "Custom interval" }]} /><Field label="Next due" name="nextDue" type="date" defaultValue={todayEAT()} /><Field label="Interval days (custom)" name="intervalDays" inputMode="numeric" /></Grid></ModalForm>}
                </div></td></tr>))}</tbody></TableWrap>
        )}
      </Card>
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card title="Loans" pad={false}>
          {memberLoans.length === 0 ? <Empty title="No loans" /> : <TableWrap><thead><tr><th>Loan</th><th>Disbursed</th><th className="r">Principal</th><th className="r">Outstanding</th><th>Status</th></tr></thead>
            <tbody>{memberLoans.map((l) => <tr key={l.id}><td><Link className="text-brand hover:underline" href={`/loans/${l.id}`}>{l.loanNo}</Link></td><td>{fmtDate(l.disbursedAt)}</td><td className="r num">{ugx(l.principal)}</td><td className="r num">{ugx(Number(l.principal) - Number(l.principalPaid))}</td><td><Badge value={l.status} /></td></tr>)}</tbody></TableWrap>}
        </Card>
        <Card title="Recent transactions" pad={false} actions={<Link className="btn btn-sm" href={`/transactions?member=${m.id}`}>All</Link>}>
          {txns.length === 0 ? <Empty title="No transactions yet" /> : <TableWrap><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th className="r">Amount</th></tr></thead>
            <tbody>{txns.map((t) => <tr key={t.id}><td>{fmtDate(t.txnDate)}</td><td>{label(t.type)} {t.status === "reversed" && <Badge value="reversed" />}</td><td className="num text-xs">{t.reference}</td><td className="r"><Money v={t.amount} /></td></tr>)}</tbody></TableWrap>}
        </Card>
      </div>
    </>
  );
}
void CHANNEL_OPTIONS;
