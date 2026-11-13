import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { glAccounts, journalEntries, journalLines } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ConfirmAction, Field, Grid, ModalForm, Select } from "@/components/forms";
import { Badge, Card, Empty, PageHeader, Pagination, TableWrap, one, pageParam } from "@/components/ui";
import { journalAction, reverseJournalAction } from "@/app/actions/finance";
import { todayEAT } from "@/lib/finance";
import { fmtDate, label, ugx } from "@/lib/format";

export const metadata = { title: "Journal & ledger" };
const PAGE = 20;

export default async function Journal({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("accounting.view");
  const sp = await searchParams;
  const page = pageParam(sp.page), source = one(sp.source);
  const accs = await db.select().from(glAccounts).where(and(eq(glAccounts.orgId, ctx.orgId), eq(glAccounts.active, true))).orderBy(glAccounts.code);
  const where = and(eq(journalEntries.orgId, ctx.orgId), source ? eq(journalEntries.source, source) : undefined);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(journalEntries).where(where);
  const entries = await db.select().from(journalEntries).where(where).orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNo)).limit(PAGE).offset((page - 1) * PAGE);
  const lines = entries.length ? await db.select({ l: journalLines, code: glAccounts.code, name: glAccounts.name }).from(journalLines).innerJoin(glAccounts, eq(glAccounts.id, journalLines.accountId)).where(inArray(journalLines.entryId, entries.map((e) => e.id))) : [];
  const reversed = entries.length ? await db.select({ id: journalEntries.reversalOfId }).from(journalEntries).where(inArray(journalEntries.reversalOfId, entries.map((e) => e.id))) : [];
  const accOpts = accs.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));
  const post = can(ctx.role, "accounting.post");
  return (
    <>
      <PageHeader title="Journal & general ledger" sub="Posted entries are immutable and always balance (enforced by the database). Corrections are made with reversing entries." actions={post && (
        <ModalForm wide trigger="Manual journal / adjustment" title="Post a manual journal entry" action={journalAction}>
          <Grid><Select label="Type" name="kind" required defaultValue="adjustment" options={[{ value: "adjustment", label: "Adjustment" }, { value: "manual", label: "Manual entry" }]} /><Field label="Date" name="date" type="date" required defaultValue={todayEAT()} /></Grid>
          <Field label="Description" name="description" required />
          <div className="scroll-x"><table className="tbl"><thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>{[1, 2, 3, 4].map((i) => <tr key={i}><td><select name={`acc${i}`} className="input" defaultValue=""><option value="">-</option>{accOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td><td><input name={`dr${i}`} inputMode="numeric" className="input" /></td><td><input name={`cr${i}`} inputMode="numeric" className="input" /></td></tr>)}</tbody></table></div>
          <p className="hint">Total debits must equal total credits. Cash balances move only through the cashbook, deposits, withdrawals and repayments; use this form for accruals, depreciation, reclassifications and corrections.</p>
        </ModalForm>)} />
      <form className="card card-pad mb-4 flex gap-3 items-end no-print" method="get"><div><label className="lbl" htmlFor="source">Source</label><select id="source" name="source" defaultValue={source ?? ""} className="input"><option value="">All</option><option value="system">System (automatic)</option><option value="manual">Manual</option><option value="adjustment">Adjustment</option><option value="reversal">Reversal</option></select></div><button className="btn btn-primary">Filter</button></form>
      {entries.length === 0 ? <Card><Empty title="No journal entries" /></Card> : (
        <div className="space-y-3">{entries.map((e) => {
          const ls = lines.filter((x) => x.l.entryId === e.id);
          const isRev = reversed.some((r) => r.id === e.id);
          return (
            <Card key={e.id} pad={false}>
              <div className="flex flex-wrap justify-between gap-2 px-4 py-2.5 border-b border-line">
                <div><span className="num font-semibold">{e.entryNo}</span> <span className="text-muted">- {fmtDate(e.entryDate)}</span> <Badge value={e.source} tone="badge-info" /> {isRev && <Badge value="reversed" />}<p className="text-sm">{e.description}</p></div>
                {can(ctx.role, "accounting.reverse") && !isRev && !e.reversalOfId && e.sourceType !== "transaction" && <ConfirmAction action={reverseJournalAction} fields={{ id: e.id }} label="Reverse" danger message="Posts an equal and opposite entry." reason />}
              </div>
              <TableWrap><tbody>{ls.map((x) => <tr key={x.l.id}><td className="num w-20">{x.code}</td><td>{x.name}</td><td className="r num w-36">{Number(x.l.debit) ? ugx(x.l.debit, { symbol: false }) : ""}</td><td className="r num w-36">{Number(x.l.credit) ? ugx(x.l.credit, { symbol: false }) : ""}</td></tr>)}</tbody></TableWrap>
            </Card>
          );
        })}</div>
      )}
      <Card pad={false} className="mt-3"><Pagination page={page} pages={Math.ceil(Number(n) / PAGE)} total={Number(n)} params={{ source }} base="/accounting/journal" /></Card>
      <p className="hint mt-2">Source types: {["system", "manual", "adjustment", "reversal"].map(label).join(", ")}.</p>
    </>
  );
}
