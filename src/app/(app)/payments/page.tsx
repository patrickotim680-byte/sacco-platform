import Link from "next/link";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { loans, members, paymentIntegrations, paymentRequests, savingsAccounts } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ActionForm, ConfirmAction, Field, Grid, Modal, ModalForm, Select } from "@/components/forms";
import { Badge, Card, Empty, PageHeader, Stat, TableWrap } from "@/components/ui";
import { cancelPaymentAction, confirmPaymentAction, refreshPaymentAction, requestCollectionAction, testConnectionAction } from "@/app/actions/finance";
import { saveIntegrationAction } from "@/app/actions/admin";
import { providerEnv } from "@/lib/services/payments";
import { fmtDateTime, formatUgPhone, label, ugx } from "@/lib/format";

export const metadata = { title: "Payments" };

export default async function Payments() {
  const ctx = await requirePage("payments.view");
  const manage = can(ctx.role, "payments.manage");
  const [integ, reqs, mems, accs, lns, stats] = await Promise.all([
    db.select().from(paymentIntegrations).where(eq(paymentIntegrations.orgId, ctx.orgId)).orderBy(paymentIntegrations.displayName),
    db.select({ r: paymentRequests, m: members.fullName }).from(paymentRequests).leftJoin(members, eq(members.id, paymentRequests.memberId)).where(eq(paymentRequests.orgId, ctx.orgId)).orderBy(desc(paymentRequests.createdAt)).limit(40),
    manage ? db.select({ id: members.id, no: members.memberNo, name: members.fullName }).from(members).where(and(eq(members.orgId, ctx.orgId), eq(members.status, "active"))).orderBy(members.memberNo).limit(600) : [],
    manage ? db.select({ id: savingsAccounts.id, no: savingsAccounts.accountNo, mid: savingsAccounts.memberId }).from(savingsAccounts).where(and(eq(savingsAccounts.orgId, ctx.orgId), eq(savingsAccounts.status, "active"))).limit(1500) : [],
    manage ? db.select({ id: loans.id, no: loans.loanNo, mid: loans.memberId }).from(loans).where(and(eq(loans.orgId, ctx.orgId), eq(loans.status, "active"))) : [],
    db.execute(sql`select
      count(*) filter (where t.channel in ('mtn_momo','airtel_money') and t.status='completed') mm_total,
      count(*) filter (where t.channel in ('mtn_momo','airtel_money') and t.status='completed' and not exists (select 1 from payment_requests p where p.transaction_id = t.id)) mm_manual,
      coalesce(sum(t.amount) filter (where t.channel in ('mtn_momo','airtel_money') and t.status='completed' and t.type in ('deposit','loan_repayment')),0) mm_in
      from transactions t where t.org_id=${ctx.orgId}`),
  ]);
  const st = stats.rows[0] as { mm_total: string; mm_manual: string; mm_in: string };
  const awaiting = reqs.filter((x) => ["awaiting_confirmation", "pending_provider"].includes(x.r.status));
  return (
    <>
      <PageHeader title="Payments & mobile money" sub="MTN Mobile Money and Airtel Money collections, bank transfers, cash and manually verified payments. Nothing is marked paid until it is confirmed." actions={manage && (
        <ModalForm trigger="Request mobile money payment" title="Request a mobile money collection" action={requestCollectionAction} submit="Create request">
          <Grid><Select label="Provider" name="provider" required options={[{ value: "mtn_momo", label: "MTN Mobile Money" }, { value: "airtel_money", label: "Airtel Money" }]} /><Select label="Purpose" name="purpose" required options={[{ value: "deposit", label: "Savings deposit" }, { value: "loan_repayment", label: "Loan repayment" }]} />
            <Select label="Member" name="memberId" required options={mems.map((m) => ({ value: m.id, label: `${m.no} - ${m.name}` }))} /><Field label="Mobile number to charge" name="msisdn" required inputMode="tel" placeholder="0772 123 456" />
            <Select label="Savings account (deposits)" name="accountId" options={accs.map((a) => ({ value: a.id, label: a.no }))} /><Select label="Loan (repayments)" name="loanId" options={lns.map((l) => ({ value: l.id, label: l.no }))} /><Field label="Amount (UGX)" name="amount" required inputMode="numeric" /></Grid>
          <p className="hint">If the provider API is not configured, the request is recorded as awaiting confirmation and an officer confirms it with the provider transaction ID after checking the statement.</p>
        </ModalForm>)} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4"><Stat label="Mobile money payments posted" value={Number(st.mm_total)} sub={`${ugx(st.mm_in)} received`} /><Stat label="Recorded manually (no provider request)" value={Number(st.mm_manual)} /><Stat label="Awaiting confirmation" value={awaiting.length} tone={awaiting.length ? "warn" : "ok"} /><Stat label="Confirmed requests" value={reqs.filter((x) => x.r.status === "confirmed").length} /></div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-4">{integ.map((i) => {
        const p = i.provider === "mtn_momo" || i.provider === "airtel_money" ? providerEnv(i.provider) : null;
        return (
          <Card key={i.id} title={i.displayName} actions={<Badge value={p ? (p.configured ? `API credentials set (${p.env})` : "API not configured") : "Always available"} tone={p ? (p.configured ? "badge-info" : "badge-warn") : "badge-ok"} />}>
            <p className="text-sm text-muted">{p ? (p.configured ? "Credentials found in the server environment. Run Test connection before enabling live collections. Provider flows have not been verified in production by this platform." : `Manual confirmation only. Set ${p.missing.join(", ")} to enable API collections.`) : "Recorded manually with a reference, and reconciled against statements."}</p>
            <dl className="text-sm mt-2"><div className="flex justify-between"><dt className="text-muted">Mode</dt><dd>{label(i.mode)}</dd></div>{i.accountNumber && <div className="flex justify-between"><dt className="text-muted">Collection number</dt><dd className="num">{i.accountNumber}</dd></div>}{i.lastTestedAt && <div><dt className="text-muted">Last test {fmtDateTime(i.lastTestedAt)}</dt><dd className="text-xs">{i.lastTestResult}</dd></div>}</dl>
            {manage && p && <div className="flex gap-2 mt-3">
              <ModalForm small variant="default" trigger="Settings" title={`${i.displayName} settings`} action={saveIntegrationAction}><input type="hidden" name="id" value={i.id} /><Select label="Mode" name="mode" required defaultValue={i.mode} options={[{ value: "manual_only", label: "Manual only (no API calls)" }, { value: "sandbox", label: "Sandbox / test" }, { value: "production", label: "Production" }]} /><Field label="Collection / merchant number" name="accountNumber" defaultValue={i.accountNumber} /><label className="flex gap-2 text-sm items-center"><input type="checkbox" name="enabled" defaultChecked={i.enabled} /> Channel enabled</label><p className="hint">API secrets are never stored in the database; they are read from server environment variables.</p></ModalForm>
              <ActionForm action={testConnectionAction} submit="Test connection" inline reset={false}><input type="hidden" name="provider" value={i.provider} /></ActionForm>
            </div>}
          </Card>
        );
      })}</div>
      <Card title="Payment requests" pad={false}>
        {reqs.length === 0 ? <Empty title="No payment requests yet" /> : <TableWrap><thead><tr><th>Created</th><th>Reference</th><th>Provider</th><th>Member</th><th>Purpose</th><th>Number</th><th className="r">Amount</th><th>Status</th><th>Provider ref</th><th /></tr></thead>
          <tbody>{reqs.map(({ r, m }) => <tr key={r.id}><td>{fmtDateTime(r.createdAt)}</td><td className="num text-xs">{r.reference}</td><td>{label(r.provider)}</td><td>{m}</td><td>{label(r.purpose)}</td><td className="num">{formatUgPhone(r.msisdn)}</td><td className="r num">{ugx(r.amount)}</td><td><Badge value={r.status} /><p className="text-xs text-muted max-w-48">{r.providerStatusRaw}</p></td><td className="num text-xs">{r.providerRef ?? "-"}</td>
            <td className="r">{manage && ["awaiting_confirmation", "pending_provider"].includes(r.status) && <div className="flex gap-1.5 justify-end">
              <ModalForm small trigger="Confirm" title="Confirm payment received" action={confirmPaymentAction} submit="Confirm and post"><input type="hidden" name="id" value={r.id} /><p className="text-sm text-muted">Confirm only after verifying {ugx(r.amount)} from {formatUgPhone(r.msisdn)} on the {label(r.provider)} statement or SMS receipt. This posts the transaction to the ledger.</p><Field label="Provider transaction ID" name="providerTxnId" required hint="Must be unique; duplicates are rejected" /></ModalForm>
              {r.status === "pending_provider" && <ActionForm action={refreshPaymentAction} submit="Check status" inline reset={false}><input type="hidden" name="id" value={r.id} /></ActionForm>}
              {r.status === "awaiting_confirmation" && <ConfirmAction action={cancelPaymentAction} fields={{ id: r.id }} label="Cancel" danger message="Cancel this request. No money is posted." />}
            </div>}</td></tr>)}</tbody></TableWrap>}
      </Card>
      <p className="text-sm text-muted mt-3">Manual deposits and repayments can still be recorded from <Link className="text-brand underline" href="/savings">Savings</Link> and <Link className="text-brand underline" href="/loans">Loans</Link> using the channel and provider reference.</p>
    </>
  );
}
void Modal; void inArray;
