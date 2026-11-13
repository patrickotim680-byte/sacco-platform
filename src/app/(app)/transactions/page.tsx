import Link from "next/link";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { members, transactions } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ConfirmAction } from "@/components/forms";
import { Badge, Card, Empty, FilterBar, FilterField, PageHeader, Pagination, TableWrap, one, pageParam } from "@/components/ui";
import { reverseTxnAction } from "@/app/actions/finance";
import { fmtDate, label, ugx } from "@/lib/format";

export const metadata = { title: "Transactions" };
const PAGE = 30;
const TYPES = ["deposit", "withdrawal", "interest", "loan_disbursement", "loan_repayment", "income", "expense", "reversal"];

export default async function Transactions({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("savings.view");
  const sp = await searchParams;
  const type = one(sp.type), status = one(sp.status), channel = one(sp.channel), member = one(sp.member), q = one(sp.q)?.trim(), from = one(sp.from), to = one(sp.to), page = pageParam(sp.page);
  const where = and(eq(transactions.orgId, ctx.orgId), type ? eq(transactions.type, type) : undefined, status ? eq(transactions.status, status) : undefined, channel ? eq(transactions.channel, channel) : undefined,
    member ? eq(transactions.memberId, member) : undefined, from ? gte(transactions.txnDate, from) : undefined, to ? lte(transactions.txnDate, to) : undefined,
    q ? or(ilike(transactions.reference, `%${q}%`), ilike(transactions.externalRef, `%${q}%`), ilike(members.fullName, `%${q}%`)) : undefined);
  const [{ n, total }] = await db.select({ n: sql<number>`count(*)`, total: sql<string>`coalesce(sum(${transactions.amount}),0)` }).from(transactions).leftJoin(members, eq(members.id, transactions.memberId)).where(where);
  const rows = await db.select({ t: transactions, m: members.fullName, mid: members.id }).from(transactions).leftJoin(members, eq(members.id, transactions.memberId)).where(where).orderBy(desc(transactions.createdAt)).limit(PAGE).offset((page - 1) * PAGE);
  const canReverse = can(ctx.role, "accounting.reverse");
  return (
    <>
      <PageHeader title="Transactions" sub="Immutable record of every money movement. Mistakes are corrected with auditable reversals, never by deleting or editing." />
      <FilterBar action="/transactions">
        <FilterField label="Search" name="q"><input id="q" name="q" defaultValue={q} className="input" placeholder="Reference, provider ID or member" /></FilterField>
        <FilterField label="Type" name="type"><select id="type" name="type" defaultValue={type ?? ""} className="input"><option value="">All</option>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></FilterField>
        <FilterField label="Channel" name="channel"><select id="channel" name="channel" defaultValue={channel ?? ""} className="input"><option value="">All</option>{["cash", "mtn_momo", "airtel_money", "bank", "manual"].map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></FilterField>
        <FilterField label="Status" name="status"><select id="status" name="status" defaultValue={status ?? ""} className="input"><option value="">All</option><option value="completed">Completed</option><option value="reversed">Reversed</option></select></FilterField>
        <FilterField label="From" name="from"><input id="from" type="date" name="from" defaultValue={from} className="input" /></FilterField>
        <FilterField label="To" name="to"><input id="to" type="date" name="to" defaultValue={to} className="input" /></FilterField>
        {member && <input type="hidden" name="member" value={member} />}
      </FilterBar>
      <Card pad={false}>
        {rows.length === 0 ? <Empty title="No transactions match these filters" /> : (
          <TableWrap><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Member</th><th>Channel</th><th>Provider ref</th><th className="r">Amount</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map(({ t, m, mid }) => (
              <tr key={t.id}><td>{fmtDate(t.txnDate)}</td><td className="num text-xs">{t.reference}</td><td title={t.description ?? ""}>{label(t.type)}</td><td>{m ? <Link className="text-brand hover:underline" href={`/members/${mid}`}>{m}</Link> : "-"}</td><td>{label(t.channel)}</td><td className="num text-xs">{t.externalRef ?? "-"}</td><td className="r num">{ugx(t.amount)}</td><td><Badge value={t.status} /></td>
                <td className="r">{canReverse && t.status === "completed" && !["reversal", "loan_disbursement"].includes(t.type) && <ConfirmAction action={reverseTxnAction} fields={{ id: t.id }} label="Reverse" danger title={`Reverse ${t.reference}`} message="Posts an equal and opposite ledger entry and restores balances. The original stays visible, marked reversed." reason />}</td></tr>))}</tbody></TableWrap>
        )}
        <Pagination page={page} pages={Math.ceil(Number(n) / PAGE)} total={Number(n)} params={{ q, type, status, channel, member, from, to }} base="/transactions" />
      </Card>
      <p className="text-xs text-muted mt-2">Sum of listed amounts (all pages): {ugx(total)}</p>
    </>
  );
}
