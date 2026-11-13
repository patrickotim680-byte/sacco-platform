import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { groups, loans, members } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { getReport, REPORT_CATALOG, fmtCell } from "@/lib/services/reports";
import { resolveRange } from "@/lib/services/dashboard";
import { Card, Empty, PageHeader, TableWrap, one } from "@/components/ui";

export const metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("reports.view");
  const sp = await searchParams;
  const key = one(sp.key) ?? "income_statement";
  const def = REPORT_CATALOG.find((r) => r.key === key) ?? REPORT_CATALOG[0];
  const range = await resolveRange(ctx.org, { range: one(sp.range) ?? "fy", from: one(sp.from), to: one(sp.to) });
  const memberId = one(sp.memberId), loanId = one(sp.loanId), groupId = one(sp.groupId);
  const needs = def.needs ?? [];
  const [ms, ls, gs] = await Promise.all([
    needs.includes("member") ? db.select({ id: members.id, no: members.memberNo, name: members.fullName }).from(members).where(eq(members.orgId, ctx.orgId)).orderBy(members.memberNo).limit(500) : [],
    needs.includes("loan") ? db.select({ id: loans.id, no: loans.loanNo, name: loans.loanNo }).from(loans).where(eq(loans.orgId, ctx.orgId)).orderBy(desc(loans.loanNo)).limit(500) : [],
    def.key.startsWith("meeting") ? db.select({ id: groups.id, name: groups.name }).from(groups).where(eq(groups.orgId, ctx.orgId)) : [],
  ]);
  let report = null, error: string | null = null;
  if (!((needs.includes("member") && !memberId) || (needs.includes("loan") && !loanId))) {
    try { report = await getReport(ctx.orgId, def.key, { from: range.from, to: range.to, memberId, loanId, groupId }); } catch (e) { error = (e as Error).message; }
  }
  const qs = new URLSearchParams({ range: range.key, from: range.from, to: range.to, ...(memberId ? { memberId } : {}), ...(loanId ? { loanId } : {}), ...(groupId ? { groupId } : {}) });
  const dl = (f: string) => `/api/export/${def.key}?${qs.toString()}&format=${f}`;
  const groupsList = [...new Set(REPORT_CATALOG.map((r) => r.group))];
  return (
    <>
      <PageHeader title="Reports" sub="Every report is generated live from the ledger and can be downloaded as PDF, Excel or CSV. Downloads are recorded in the audit trail." />
      <div className="grid lg:grid-cols-[260px_1fr] gap-4">
        <nav className="card card-pad h-fit" aria-label="Report list">
          {groupsList.map((g) => (
            <div key={g} className="mb-3 last:mb-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted mb-1">{g}</p>
              {REPORT_CATALOG.filter((r) => r.group === g).map((r) => <Link key={r.key} href={`/reports?key=${r.key}`} className="nav-link py-1.5" aria-current={r.key === def.key ? "page" : undefined}>{r.title}</Link>)}
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          <Card title={def.title} actions={report && <><a className="btn btn-sm btn-primary" href={dl("pdf")}>PDF</a><a className="btn btn-sm" href={dl("xlsx")}>Excel</a><a className="btn btn-sm" href={dl("csv")}>CSV</a></>}>
            <p className="text-sm text-muted mb-3">{def.description}</p>
            <form method="get" action="/reports" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="key" value={def.key} />
              {needs.includes("member") && <div className="min-w-[220px]"><label className="lbl" htmlFor="memberId">Member</label><select id="memberId" name="memberId" defaultValue={memberId ?? ""} className="input" required><option value="">Select member</option>{ms.map((m) => <option key={m.id} value={m.id}>{m.no} - {m.name}</option>)}</select></div>}
              {needs.includes("loan") && <div className="min-w-[180px]"><label className="lbl" htmlFor="loanId">Loan</label><select id="loanId" name="loanId" defaultValue={loanId ?? ""} className="input" required><option value="">Select loan</option>{ls.map((l) => <option key={l.id} value={l.id}>{l.no}</option>)}</select></div>}
              {def.key.startsWith("meeting") && <div className="min-w-[200px]"><label className="lbl" htmlFor="groupId">Group</label><select id="groupId" name="groupId" defaultValue={groupId ?? ""} className="input"><option value="">All groups</option>{gs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></div>}
              <div><label className="lbl" htmlFor="range">Period</label><select id="range" name="range" defaultValue={range.key} className="input"><option value="this_month">This month</option><option value="last_30">Last 30 days</option><option value="fy">Current financial year</option><option value="last_fy">Last financial year</option><option value="all">All time</option><option value="custom">Custom</option></select></div>
              <div><label className="lbl" htmlFor="from">From</label><input id="from" type="date" name="from" defaultValue={range.from} className="input" /></div>
              <div><label className="lbl" htmlFor="to">To</label><input id="to" type="date" name="to" defaultValue={range.to} className="input" /></div>
              <button className="btn btn-primary" type="submit">Generate</button>
            </form>
            <p className="hint mt-2">Period: {range.label}. Choose &quot;Custom&quot; to use the From/To dates.</p>
          </Card>
          {error && <p className="mt-4 text-sm text-danger">{error}</p>}
          {!report && !error && <Card className="mt-4"><Empty title="Select the details above">Choose the {needs.join(" and ")} to generate this report.</Empty></Card>}
          {report && (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-muted">{report.title} - {report.subtitle}</p>
              {report.sections.map((s) => (
                <Card key={s.title} title={s.title} pad={false}>
                  {s.rows.length === 0 ? <Empty title="No records for this period" /> : (
                    <TableWrap>
                      <thead><tr>{s.columns.map((c) => <th key={c.key} className={c.type === "money" || c.type === "number" ? "r" : ""}>{c.label}</th>)}</tr></thead>
                      <tbody>
                        {s.rows.slice(0, 200).map((r, i) => <tr key={i}>{s.columns.map((c) => <td key={c.key} className={c.type === "money" || c.type === "number" ? "r num" : ""}>{fmtCell(r[c.key], c.type)}</td>)}</tr>)}
                        {s.footer && <tr className="font-semibold">{s.columns.map((c) => <td key={c.key} className={c.type === "money" ? "r num" : ""}>{s.footer![c.key] === undefined ? "" : c.type === "money" ? fmtCell(s.footer![c.key], "money") : String(s.footer![c.key])}</td>)}</tr>}
                      </tbody>
                    </TableWrap>
                  )}
                  {s.rows.length > 200 && <p className="px-4 py-2 text-xs text-muted border-t border-line">Showing first 200 of {s.rows.length} rows. Download for the full report.</p>}
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
