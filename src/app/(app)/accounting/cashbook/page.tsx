import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { glAccounts, transactions } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Field, Grid, ModalForm, Select, ConfirmAction } from "@/components/forms";
import { CHANNEL_OPTIONS } from "@/components/fields";
import { Badge, Card, Empty, PageHeader, Pagination, Stat, TableWrap, pageParam } from "@/components/ui";
import { cashbookAction, reverseTxnAction } from "@/app/actions/finance";
import { todayEAT } from "@/lib/finance";
import { fmtDate, label, ugx } from "@/lib/format";

export const metadata = { title: "Cashbook" };
const PAGE = 30;

export default async function Cashbook({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("accounting.view");
  const page = pageParam((await searchParams).page);
  const accs = await db.select().from(glAccounts).where(and(eq(glAccounts.orgId, ctx.orgId), inArray(glAccounts.type, ["income", "expense"]), eq(glAccounts.active, true))).orderBy(glAccounts.code);
  const cash = (await db.execute(sql`select a.code, a.name, coalesce(sum(l.debit - l.credit),0) bal from gl_accounts a left join journal_lines l on l.account_id=a.id where a.org_id=${ctx.orgId} and a.is_cash group by a.code, a.name order by a.code`)).rows as { code: string; name: string; bal: string }[];
  const where = and(eq(transactions.orgId, ctx.orgId), inArray(transactions.type, ["income", "expense"]));
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(transactions).where(where);
  const rows = await db.select().from(transactions).where(where).orderBy(desc(transactions.txnDate), desc(transactions.createdAt)).limit(PAGE).offset((page - 1) * PAGE);
  const post = can(ctx.role, "accounting.post");
  const form = (kind: "income" | "expense") => (
    <ModalForm trigger={kind === "income" ? "Record income" : "Record expense"} title={kind === "income" ? "Record income received" : "Record expenditure"} action={cashbookAction} variant={kind === "income" ? "primary" : "default"}>
      <input type="hidden" name="kind" value={kind} />
      <Grid><Select label="Ledger account" name="glCode" required options={accs.filter((a) => a.type === kind).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }))} /><Field label="Amount (UGX)" name="amount" required inputMode="numeric" /><Select label="Paid via / received into" name="channel" required defaultValue="cash" options={CHANNEL_OPTIONS.filter((c) => c.value !== "manual")} /><Field label="Date" name="date" type="date" defaultValue={todayEAT()} /></Grid>
      <Field label="Description" name="description" required />{kind === "expense" && <Field label="Payee" name="payee" />}
    </ModalForm>
  );
  return (
    <>
      <PageHeader title="Cashbook" sub="Income and expenditure that is not a member savings or loan transaction. Balances are taken from the ledger." actions={post && <>{form("income")}{form("expense")}</>} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">{cash.map((c) => <Stat key={c.code} label={c.name} value={ugx(c.bal)} tone={Number(c.bal) < 0 ? "danger" : undefined} />)}</div>
      <Card pad={false} title="Income and expenditure entries">
        {rows.length === 0 ? <Empty title="No entries yet" /> : <TableWrap><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Description</th><th>Channel</th><th className="r">Amount</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((t) => <tr key={t.id}><td>{fmtDate(t.txnDate)}</td><td className="num text-xs">{t.reference}</td><td>{label(t.type)}</td><td>{t.description}</td><td>{label(t.channel)}</td><td className="r num">{ugx(t.amount)}</td><td><Badge value={t.status} /></td>
            <td className="r">{can(ctx.role, "accounting.reverse") && t.status === "completed" && <ConfirmAction action={reverseTxnAction} fields={{ id: t.id }} label="Reverse" danger message="Posts an equal and opposite entry. The original remains visible." reason />}</td></tr>)}</tbody></TableWrap>}
        <Pagination page={page} pages={Math.ceil(Number(n) / PAGE)} total={Number(n)} params={{}} base="/accounting/cashbook" />
      </Card>
    </>
  );
}
