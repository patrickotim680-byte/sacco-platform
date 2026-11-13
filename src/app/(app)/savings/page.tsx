import Link from "next/link";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { members, savingsAccounts, savingsProducts, contributionSchedules } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ActionForm, Field, Grid, ModalForm, Select } from "@/components/forms";
import { MoneyFields } from "@/components/fields";
import { Badge, Card, Empty, FilterBar, FilterField, PageHeader, Pagination, Stat, Tabs, TableWrap, one, pageParam } from "@/components/ui";
import { depositAction, postInterestAction, saveSavingsProductAction } from "@/app/actions/finance";
import { fmtDate, ugx } from "@/lib/format";
import { addMonths, todayEAT } from "@/lib/finance";
import type { ReactNode } from "react";

export const metadata = { title: "Savings" };
const PAGE = 25;

function ProductForm({ p }: { p?: typeof savingsProducts.$inferSelect }) {
  return (
    <>
      {p && <input type="hidden" name="id" value={p.id} />}
      <Field label="Product name" name="name" required defaultValue={p?.name} />
      <Grid>
        <Select label="Category" name="category" required defaultValue={p?.category ?? "voluntary"} options={[{ value: "mandatory", label: "Mandatory" }, { value: "voluntary", label: "Voluntary" }]} />
        <Select label="Plan type" name="planType" required defaultValue={p?.planType ?? "flexible"} options={[{ value: "flexible", label: "Flexible (withdraw anytime)" }, { value: "fixed", label: "Fixed (locked)" }]} />
        <Select label="Contribution schedule" name="frequency" required defaultValue={p?.frequency ?? "monthly"} options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "custom", label: "Custom" }]} />
        <Field label="Minimum contribution (UGX)" name="minContribution" required defaultValue={p ? Number(p.minContribution) : 10000} inputMode="numeric" />
        <Field label="Interest rate (% per annum)" name="interestRate" required defaultValue={p ? Number(p.interestRate) : 0} inputMode="decimal" />
        <Field label="Lock period (months, fixed plans)" name="lockMonths" defaultValue={p?.lockMonths ?? 0} inputMode="numeric" />
      </Grid>
      {p && <label className="flex gap-2 items-center text-sm"><input type="checkbox" name="active" defaultChecked={p.active} /> Product is open for new accounts</label>}
    </>
  );
}

export default async function SavingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("savings.view");
  const sp = await searchParams;
  const tab = one(sp.tab) ?? "accounts", q = one(sp.q)?.trim(), product = one(sp.product), page = pageParam(sp.page);
  const products = await db.select().from(savingsProducts).where(eq(savingsProducts.orgId, ctx.orgId)).orderBy(savingsProducts.createdAt);
  const [tot] = await db.select({ s: sql<string>`coalesce(sum(balance),0)`, n: sql<number>`count(*)` }).from(savingsAccounts).where(and(eq(savingsAccounts.orgId, ctx.orgId), eq(savingsAccounts.status, "active")));
  const [late] = await db.select({ n: sql<number>`count(*)` }).from(contributionSchedules).where(and(eq(contributionSchedules.orgId, ctx.orgId), eq(contributionSchedules.active, true), sql`${contributionSchedules.nextDue} < ${todayEAT()}`));
  let body: ReactNode;
  if (tab === "products") {
    body = (
      <Card pad={false} title="Savings products" actions={can(ctx.role, "savings.products") && <ModalForm trigger="New product" title="New savings product" action={saveSavingsProductAction}><ProductForm /></ModalForm>}>
        <TableWrap><thead><tr><th>Name</th><th>Category</th><th>Type</th><th>Schedule</th><th className="r">Min. contribution</th><th className="r">Interest p.a.</th><th>Status</th><th /></tr></thead>
          <tbody>{products.map((p) => <tr key={p.id}><td className="font-medium">{p.name}</td><td>{p.category}</td><td>{p.planType}{p.lockMonths ? ` (${p.lockMonths} mo)` : ""}</td><td>{p.frequency}</td><td className="r num">{ugx(p.minContribution)}</td><td className="r num">{Number(p.interestRate)}%</td><td><Badge value={p.active ? "active" : "closed"} /></td>
            <td className="r">{can(ctx.role, "savings.products") && <ModalForm small variant="default" trigger="Edit" title={`Edit ${p.name}`} action={saveSavingsProductAction}><ProductForm p={p} /></ModalForm>}</td></tr>)}</tbody></TableWrap>
      </Card>
    );
  } else if (tab === "interest") {
    const lastMonth = addMonths(todayEAT().slice(0, 8) + "01", -1).slice(0, 7);
    body = (
      <Card title="Post savings interest">
        <p className="text-sm text-muted mb-3">Interest is calculated on each account&apos;s current balance at the product&apos;s annual rate for the number of days in the month, then posted to the member account with a balanced journal (Dr Interest on member savings, Cr Member savings). A period can only be posted once per account.</p>
        {can(ctx.role, "savings.interest") ? <ActionForm action={postInterestAction} submit="Post interest for period" inline><Field label="Period (YYYY-MM)" name="period" required defaultValue={lastMonth} pattern="\d{4}-\d{2}" /></ActionForm> : <p className="text-sm text-muted">Your role cannot post interest.</p>}
      </Card>
    );
  } else {
    const where = and(eq(savingsAccounts.orgId, ctx.orgId), product ? eq(savingsAccounts.productId, product) : undefined, q ? or(ilike(members.fullName, `%${q}%`), ilike(members.memberNo, `%${q}%`), ilike(savingsAccounts.accountNo, `%${q}%`)) : undefined);
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(savingsAccounts).innerJoin(members, eq(members.id, savingsAccounts.memberId)).where(where);
    const rows = await db.select({ a: savingsAccounts, m: members.fullName, mid: members.id, p: savingsProducts.name }).from(savingsAccounts).innerJoin(members, eq(members.id, savingsAccounts.memberId)).innerJoin(savingsProducts, eq(savingsProducts.id, savingsAccounts.productId)).where(where).orderBy(desc(savingsAccounts.balance)).limit(PAGE).offset((page - 1) * PAGE);
    body = (
      <>
        <FilterBar action="/savings">
          <input type="hidden" name="tab" value="accounts" />
          <FilterField label="Search" name="q"><input id="q" name="q" defaultValue={q} className="input" placeholder="Member, number or account" /></FilterField>
          <FilterField label="Product" name="product"><select id="product" name="product" defaultValue={product ?? ""} className="input"><option value="">All</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></FilterField>
        </FilterBar>
        <Card pad={false}>
          {rows.length === 0 ? <Empty title="No accounts match" /> : <TableWrap><thead><tr><th>Account</th><th>Member</th><th>Product</th><th>Opened</th><th className="r">Balance</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map(({ a, m, mid, p }) => <tr key={a.id}><td className="num">{a.accountNo}</td><td><Link className="text-brand hover:underline" href={`/members/${mid}`}>{m}</Link></td><td>{p}</td><td>{fmtDate(a.openedAt)}</td><td className="r num">{ugx(a.balance)}</td><td><Badge value={a.status} /></td>
              <td className="r">{can(ctx.role, "savings.deposit") && a.status === "active" && <ModalForm small trigger="Deposit" title={`Deposit - ${m} (${a.accountNo})`} action={depositAction}><input type="hidden" name="accountId" value={a.id} /><MoneyFields /><Field label="Narration" name="description" /></ModalForm>}</td></tr>)}</tbody></TableWrap>}
          <Pagination page={page} pages={Math.ceil(Number(n) / PAGE)} total={Number(n)} params={{ q, product, tab }} base="/savings" />
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Savings" sub="Accounts, products, contribution schedules and interest. Balances change only through posted transactions." />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4"><Stat label="Total savings" value={ugx(tot.s)} /><Stat label="Active accounts" value={Number(tot.n).toLocaleString()} /><Stat label="Contribution schedules overdue" value={Number(late.n)} tone={Number(late.n) ? "warn" : "ok"} sub="Run alerts from Notifications" /></div>
      <Tabs base="/savings" current={tab} tabs={[{ key: "accounts", label: "Accounts" }, { key: "products", label: "Products", count: products.length }, { key: "interest", label: "Interest" }]} />
      {body}
    </>
  );
}
