import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { glAccounts, payablesReceivables } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Field, Grid, ModalForm, Select, ConfirmAction } from "@/components/forms";
import { CHANNEL_OPTIONS } from "@/components/fields";
import { Badge, Card, PageHeader, Stat, Tabs, TableWrap, one, Empty } from "@/components/ui";
import { createGlAccountAction, payableAction, settleItemAction } from "@/app/actions/finance";
import { getReport, fmtCell } from "@/lib/services/reports";
import { todayEAT } from "@/lib/finance";
import { fmtDate, label, ugx } from "@/lib/format";
import type { ReactNode } from "react";

export const metadata = { title: "Accounting" };

export default async function Accounting({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("accounting.view");
  const tab = one((await searchParams).tab) ?? "overview";
  const today = todayEAT();
  const post = can(ctx.role, "accounting.post");
  let body: ReactNode;
  if (tab === "accounts") {
    const accs = await db.execute(sql`select a.id, a.code, a.name, a.type, a.is_system, coalesce(sum(l.debit),0) debit, coalesce(sum(l.credit),0) credit from gl_accounts a left join journal_lines l on l.account_id=a.id where a.org_id=${ctx.orgId} group by a.id order by a.code`);
    body = (
      <Card title="Chart of accounts" pad={false} actions={post && <ModalForm small trigger="Add account" title="New ledger account" action={createGlAccountAction}><Grid><Field label="Code (4-6 digits)" name="code" required inputMode="numeric" /><Select label="Type" name="type" required options={["asset", "liability", "equity", "income", "expense"].map((t) => ({ value: t, label: label(t) }))} /></Grid><Field label="Account name" name="name" required /></ModalForm>}>
        <TableWrap><thead><tr><th>Code</th><th>Name</th><th>Type</th><th className="r">Debits</th><th className="r">Credits</th><th className="r">Balance</th></tr></thead>
          <tbody>{(accs.rows as { id: string; code: string; name: string; type: string; debit: string; credit: string }[]).map((a) => { const net = Number(a.debit) - Number(a.credit); const bal = ["asset", "expense"].includes(a.type) ? net : -net; return <tr key={a.id}><td className="num">{a.code}</td><td>{a.name}</td><td>{label(a.type)}</td><td className="r num">{ugx(a.debit, { symbol: false })}</td><td className="r num">{ugx(a.credit, { symbol: false })}</td><td className="r num font-medium">{ugx(bal, { symbol: false })}</td></tr>; })}</tbody></TableWrap>
      </Card>
    );
  } else if (tab === "payables") {
    const items = await db.select().from(payablesReceivables).where(eq(payablesReceivables.orgId, ctx.orgId)).orderBy(payablesReceivables.status, payablesReceivables.dueDate);
    body = (
      <Card title="Accounts payable and receivable" pad={false} actions={post && <ModalForm small trigger="New item" title="New payable / receivable" action={payableAction}><Grid><Select label="Type" name="kind" required options={[{ value: "payable", label: "Payable (we owe)" }, { value: "receivable", label: "Receivable (owed to us)" }]} /><Field label="Party" name="party" required /><Field label="Amount (UGX)" name="amount" required inputMode="numeric" /><Field label="Due date" name="dueDate" type="date" required defaultValue={today} /></Grid><Field label="Description" name="description" /></ModalForm>}>
        {items.length === 0 ? <Empty title="Nothing recorded" /> : <TableWrap><thead><tr><th>Type</th><th>Party</th><th>Description</th><th>Due</th><th className="r">Amount</th><th className="r">Settled</th><th>Status</th><th /></tr></thead>
          <tbody>{items.map((i) => <tr key={i.id}><td>{label(i.kind)}</td><td>{i.party}</td><td className="text-muted">{i.description}</td><td>{fmtDate(i.dueDate)}{i.status === "open" && i.dueDate < today && <Badge value="overdue" />}</td><td className="r num">{ugx(i.amount)}</td><td className="r num">{ugx(i.settled)}</td><td><Badge value={i.status} /></td>
            <td className="r">{post && i.status === "open" && <ModalForm small variant="default" trigger={i.kind === "payable" ? "Pay" : "Receive"} title={`${i.kind === "payable" ? "Pay" : "Receive from"} ${i.party}`} action={settleItemAction}><input type="hidden" name="id" value={i.id} /><p className="text-sm text-muted">Posted through the cashbook so cash and ledger stay in step.</p><Grid><Field label="Amount (UGX)" name="amount" required inputMode="numeric" defaultValue={Number(i.amount) - Number(i.settled)} /><Select label="Channel" name="channel" required defaultValue="cash" options={CHANNEL_OPTIONS} /></Grid></ModalForm>}</td></tr>)}</tbody></TableWrap>}
      </Card>
    );
  } else {
    const [chk] = (await db.execute(sql`select
      (select coalesce(sum(l.credit - l.debit),0) from journal_lines l join gl_accounts a on a.id=l.account_id where l.org_id=${ctx.orgId} and a.code='2000') gl_savings,
      (select coalesce(sum(balance),0) from savings_accounts where org_id=${ctx.orgId}) sub_savings,
      (select coalesce(sum(l.debit - l.credit),0) from journal_lines l join gl_accounts a on a.id=l.account_id where l.org_id=${ctx.orgId} and a.code='1100') gl_loans,
      (select coalesce(sum(principal - principal_paid),0) from loans where org_id=${ctx.orgId} and status='active') sub_loans,
      (select coalesce(sum(l.debit - l.credit),0) from journal_lines l join gl_accounts a on a.id=l.account_id where l.org_id=${ctx.orgId} and a.code='1150') gl_gloans,
      (select coalesce(sum(principal - least(repaid, principal)),0) from group_loans where org_id=${ctx.orgId}) sub_gloans,
      (select coalesce(sum(debit),0) - coalesce(sum(credit),0) from journal_lines where org_id=${ctx.orgId}) imbalance,
      (select count(*) from transactions where org_id=${ctx.orgId} and journal_entry_id is null) unposted,
      (select count(*) from payment_requests where org_id=${ctx.orgId} and status in ('awaiting_confirmation','pending_provider')) unreconciled`)).rows as Record<string, string>[];
    const items = [
      { name: "Member savings: ledger (2000) vs sum of account balances", a: Number(chk.gl_savings), b: Number(chk.sub_savings) },
      { name: "Member loans: ledger (1100) vs outstanding loan principal", a: Number(chk.gl_loans), b: Number(chk.sub_loans) },
      { name: "Group loans: ledger (1150) vs outstanding group loans", a: Number(chk.gl_gloans), b: Number(chk.sub_gloans) },
      { name: "Total debits vs total credits (difference)", a: Number(chk.imbalance), b: 0 },
    ];
    const tb = await getReport(ctx.orgId, "trial_balance", { from: "2000-01-01", to: today });
    const s = tb.sections[0];
    body = (
      <div className="space-y-4">
        <Card title="Reconciliation: sub-ledgers against the general ledger" pad={false}>
          <TableWrap><thead><tr><th>Check</th><th className="r">Ledger</th><th className="r">Sub-ledger</th><th>Result</th></tr></thead><tbody>{items.map((i) => <tr key={i.name}><td>{i.name}</td><td className="r num">{ugx(i.a)}</td><td className="r num">{ugx(i.b)}</td><td>{i.a === i.b ? <Badge value="Reconciled" tone="badge-ok" /> : <Badge value={`Difference ${ugx(i.a - i.b)}`} tone="badge-danger" />}</td></tr>)}
            <tr><td>Transactions without a journal entry</td><td className="r num" colSpan={2}>{chk.unposted}</td><td>{Number(chk.unposted) === 0 ? <Badge value="Reconciled" tone="badge-ok" /> : <Badge value="Investigate" tone="badge-danger" />}</td></tr>
            <tr><td>Mobile money requests awaiting confirmation</td><td className="r num" colSpan={2}>{chk.unreconciled}</td><td>{Number(chk.unreconciled) === 0 ? <Badge value="Clear" tone="badge-ok" /> : <Badge value="Pending" tone="badge-warn" />}</td></tr></tbody></TableWrap>
        </Card>
        <Card title={`Trial balance as at ${fmtDate(today)}`} pad={false}>
          <TableWrap><thead><tr>{s.columns.map((c) => <th key={c.key} className={c.type === "money" ? "r" : ""}>{c.label}</th>)}</tr></thead>
            <tbody>{s.rows.filter((r) => Number(r.debit) || Number(r.credit)).map((r, i) => <tr key={i}>{s.columns.map((c) => <td key={c.key} className={c.type === "money" ? "r num" : ""}>{fmtCell(r[c.key], c.type)}</td>)}</tr>)}
              <tr className="font-semibold">{s.columns.map((c) => <td key={c.key} className={c.type === "money" ? "r num" : ""}>{s.footer?.[c.key] === undefined ? "" : c.type === "money" ? fmtCell(s.footer[c.key], "money") : String(s.footer[c.key])}</td>)}</tr></tbody></TableWrap>
        </Card>
      </div>
    );
  }
  const [c] = await db.select({ n: sql<number>`count(*)` }).from(glAccounts).where(and(eq(glAccounts.orgId, ctx.orgId)));
  return (
    <>
      <PageHeader title="Accounting" sub="Double-entry general ledger. Every financial operation posts a balanced journal; nothing can be edited or deleted, only reversed." />
      <div className="grid grid-cols-2 gap-3 mb-4 lg:grid-cols-4"><Stat label="Ledger accounts" value={Number(c.n)} /></div>
      <Tabs base="/accounting" current={tab} tabs={[{ key: "overview", label: "Reconciliation & trial balance" }, { key: "accounts", label: "Chart of accounts" }, { key: "payables", label: "Payables & receivables" }]} />
      {body}
      <p className="text-sm text-muted mt-4">Financial statements (balance sheet, income statement, cash flow) are in <a className="text-brand underline" href="/reports?key=balance_sheet">Reports</a>.</p>
    </>
  );
}
void ConfirmAction;
