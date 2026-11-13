import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { groupCycles } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { dashboardData, resolveRange } from "@/lib/services/dashboard";
import { BarChart, HBars, LineChart } from "@/components/charts";
import { Badge, Card, Empty, FilterBar, FilterField, Money, PageHeader, Stat, TableWrap, one } from "@/components/ui";
import { fmtDate, label, ugx } from "@/lib/format";
import { getSettings } from "@/lib/core";

export const metadata = { title: "Dashboard" };

export default async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage();
  const sp = await searchParams;
  const range = await resolveRange(ctx.org, { range: one(sp.range), from: one(sp.from), to: one(sp.to), cycle: one(sp.cycle) });
  const [d, cycles] = await Promise.all([dashboardData(ctx.orgId, range), db.select().from(groupCycles).where(eq(groupCycles.orgId, ctx.orgId))]);
  const pend = d.pending;
  const empty = d.members.total === 0;
  const s = getSettings(ctx.org);
  return (
    <>
      <PageHeader title="Dashboard" sub={<>Showing <b>{range.label}</b> ({fmtDate(range.from)} to {fmtDate(range.to)}). Cash and portfolio balances are as at today.</>} />
      <FilterBar action="/dashboard">
        <FilterField label="Period" name="range">
          <select id="range" name="range" defaultValue={range.key === "cycle" ? "this_month" : range.key} className="input">
            <option value="this_month">This month</option><option value="last_30">Last 30 days</option><option value="fy">Current financial year</option><option value="last_fy">Last financial year</option><option value="all">All time</option><option value="custom">Custom range</option>
          </select>
        </FilterField>
        <FilterField label="From (custom)" name="from"><input id="from" type="date" name="from" defaultValue={sp.from as string} className="input" /></FilterField>
        <FilterField label="To (custom)" name="to"><input id="to" type="date" name="to" defaultValue={sp.to as string} className="input" /></FilterField>
        <FilterField label="Savings cycle" name="cycle">
          <select id="cycle" name="cycle" defaultValue={range.cycleId ?? ""} className="input"><option value="">None</option>{cycles.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}</select>
        </FilterField>
      </FilterBar>

      {!s.makerChecker && <p className="mb-4 text-sm bg-warn/10 text-warn border border-warn/30 rounded-lg px-3 py-2">Maker-checker approvals are switched off for this organisation. Turn them on in <Link className="underline" href="/settings">Settings</Link> once you have a second officer, to prevent one person approving their own transactions.</p>}
      {(pend.withdrawals + pend.applications + pend.flags + pend.payments > 0) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          <Link href="/savings/withdrawals" className="card card-pad hover:bg-surface-2"><p className="text-xs text-muted">Withdrawals awaiting approval</p><p className="text-lg font-semibold">{pend.withdrawals}</p></Link>
          <Link href="/loans/applications" className="card card-pad hover:bg-surface-2"><p className="text-xs text-muted">Loan applications in queue</p><p className="text-lg font-semibold">{pend.applications}</p></Link>
          <Link href="/payments" className="card card-pad hover:bg-surface-2"><p className="text-xs text-muted">Mobile money awaiting confirmation</p><p className="text-lg font-semibold">{pend.payments}</p></Link>
          <Link href="/audit" className="card card-pad hover:bg-surface-2"><p className="text-xs text-muted">Open suspicious-activity flags</p><p className={`text-lg font-semibold ${pend.flags ? "text-warn" : ""}`}>{pend.flags}</p></Link>
        </div>
      )}

      {empty ? (
        <Card><Empty title="No members yet" action={<Link className="btn btn-primary" href="/members">Register your first member</Link>}>Register members, open savings accounts and record deposits. Every figure on this dashboard is calculated from your records.</Empty></Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Total members" value={d.members.total.toLocaleString()} sub={`${d.members.active} active - ${d.members.new} joined in period`} />
            <Stat label="Total member savings" value={ugx(d.savingsTotal)} sub={`${ugx(d.contributions)} deposited in period`} />
            <Stat label="Outstanding loans (principal)" value={ugx(d.loans.outstanding)} sub={`${d.loans.count} active loans`} />
            <Stat label="Available cash & mobile money" value={ugx(d.cashTotal)} sub="Cash, bank, MTN and Airtel" />
            <Stat label="Disbursed in period" value={ugx(d.loans.disbursed)} />
            <Stat label="Repayments in period" value={ugx(d.loans.repayments)} sub={d.collection.rate === null ? "No installments fell due" : `Collection rate ${d.collection.rate.toFixed(1)}% of ${ugx(d.collection.due)} due`} tone={d.collection.rate !== null && d.collection.rate < 80 ? "warn" : undefined} />
            <Stat label="Overdue loans" value={`${d.loans.overdueCount} (${ugx(d.loans.overdueAmount)})`} tone={d.loans.overdueCount ? "danger" : "ok"} sub={`Portfolio at risk ${d.loans.parPct.toFixed(1)}% - NPL ${d.loans.nplPct.toFixed(1)}%`} />
            <Stat label="Income less expenditure" value={ugx(d.income - d.expense)} tone={d.income - d.expense < 0 ? "danger" : "ok"} sub={`Income ${ugx(d.income)} - Expenses ${ugx(d.expense)}`} />
          </div>
          <div className="grid lg:grid-cols-2 gap-4 mt-4">
            <Card title="Savings flows (last 12 months)"><BarChart title="Deposits and withdrawals by month" data={d.trend} series={[{ key: "deposits", label: "Deposits", color: "var(--brand)" }, { key: "withdrawals", label: "Withdrawals", color: "#d4880f" }]} /></Card>
            <Card title="Lending flows (last 12 months)"><BarChart title="Disbursements and repayments by month" data={d.trend} series={[{ key: "disbursed", label: "Disbursed", color: "#2e6bd6" }, { key: "repayments", label: "Repaid", color: "var(--brand)" }]} /></Card>
            <Card title="Income and expenditure (last 12 months)"><BarChart title="Income and expenditure by month" data={d.ie} series={[{ key: "income", label: "Income", color: "var(--brand)" }, { key: "expense", label: "Expenditure", color: "#c0392b" }]} /></Card>
            <Card title="Membership growth"><LineChart title="Cumulative members by month" data={d.members.growth} fmt={(n) => String(Math.round(n))} /></Card>
            <Card title="Loan portfolio health (principal by days overdue)"><HBars data={d.loans.buckets} colors={["var(--brand)", "#d4a30f", "#d4880f", "#c8571f", "#b42318"]} /></Card>
            <Card title="Savings by product"><HBars data={d.byProduct.map((p) => ({ label: `${p.label} (${p.count})`, value: p.value }))} /></Card>
          </div>
          <div className="grid lg:grid-cols-3 gap-4 mt-4">
            <Card title="Cash positions" className="lg:col-span-1">
              <ul className="space-y-2">{d.cash.map((c) => <li key={c.code} className="flex justify-between text-sm"><span>{c.name}</span><Money v={c.balance} className={c.balance < 0 ? "text-danger" : ""} /></li>)}</ul>
              <p className="hint mt-3">From the general ledger, not a stored figure.</p>
            </Card>
            <Card title="Recent transactions" className="lg:col-span-2" pad={false} actions={<Link className="btn btn-sm" href="/transactions">View all</Link>}>
              <TableWrap>
                <thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Member</th><th className="r">Amount</th><th>Status</th></tr></thead>
                <tbody>{d.recent.map((t) => <tr key={t.id}><td>{fmtDate(t.txn_date)}</td><td className="num">{t.reference}</td><td>{label(t.type)}</td><td>{t.member ?? "-"}</td><td className="r num">{ugx(t.amount)}</td><td><Badge value={t.status} /></td></tr>)}</tbody>
              </TableWrap>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
