import Link from "next/link";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, fraudFlags } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { ConfirmAction } from "@/components/forms";
import { Badge, Card, Empty, FilterBar, FilterField, PageHeader, Pagination, Tabs, TableWrap, one, pageParam } from "@/components/ui";
import { reviewFlagAction } from "@/app/actions/admin";
import { verifyAuditChain } from "@/lib/core";
import { fmtDateTime, label } from "@/lib/format";
import { can } from "@/lib/permissions";

export const metadata = { title: "Audit & security" };
const PAGE = 40;

export default async function Audit({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("audit.view");
  const sp = await searchParams;
  const tab = one(sp.tab) ?? "flags", q = one(sp.q)?.trim(), page = pageParam(sp.page), verify = one(sp.verify);
  const flags = await db.select().from(fraudFlags).where(eq(fraudFlags.orgId, ctx.orgId)).orderBy(sql`case when ${fraudFlags.status}='open' then 0 else 1 end`, desc(fraudFlags.createdAt)).limit(100);
  const openFlags = flags.filter((f) => f.status === "open").length;
  const chain = verify ? await verifyAuditChain(ctx.orgId) : null;
  let log = null;
  if (tab === "log") {
    const where = and(eq(auditLogs.orgId, ctx.orgId), q ? ilike(auditLogs.action, `%${q}%`) : undefined);
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(auditLogs).where(where);
    const rows = await db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.id)).limit(PAGE).offset((page - 1) * PAGE);
    log = { n: Number(n), rows };
  }
  return (
    <>
      <PageHeader title="Audit & security" sub="Hash-chained audit trail (append-only at database level), suspicious activity flags and integrity verification." actions={can(ctx.role, "reports.view") && <Link className="btn" href="/api/export/audit_log?range=fy&format=csv">Export audit CSV</Link>} />
      <Card title="Audit trail integrity" className="mb-4" actions={<Link className="btn btn-sm" href="/audit?tab=log&verify=1">Verify chain now</Link>}>
        {chain ? (chain.ok ? <p className="text-sm text-ok">Verified: {chain.checked.toLocaleString()} entries form an unbroken hash chain. No entry has been altered or removed.</p> : <p className="text-sm text-danger">Chain broken at entry #{chain.brokenAt}. Investigate immediately and restore from backup.</p>) : <p className="text-sm text-muted">Every action is recorded with the previous entry&apos;s hash. Database triggers block updates and deletes of audit and journal rows. Run a verification to recompute the chain.</p>}
      </Card>
      <Tabs base="/audit" current={tab} tabs={[{ key: "flags", label: "Suspicious activity", count: openFlags }, { key: "log", label: "Audit log" }]} />
      {tab === "flags" ? (
        <Card pad={false}>
          {flags.length === 0 ? <Empty title="No suspicious activity flags">Large transactions, duplicate overrides, rapid withdrawals and blocked self-approvals are flagged automatically.</Empty> : <TableWrap><thead><tr><th>When</th><th>Type</th><th>Severity</th><th>Detail</th><th>Status</th><th /></tr></thead>
            <tbody>{flags.map((f) => <tr key={f.id}><td className="whitespace-nowrap">{fmtDateTime(f.createdAt)}</td><td>{label(f.kind)}</td><td><Badge value={f.severity} /></td><td className="max-w-md">{f.detail}</td><td><Badge value={f.status} /></td>
              <td className="r">{f.status === "open" && <div className="flex gap-1.5"><ConfirmAction action={reviewFlagAction} fields={{ id: f.id, status: "reviewed" }} label="Mark reviewed" message="Record that you investigated this flag." /><ConfirmAction action={reviewFlagAction} fields={{ id: f.id, status: "dismissed" }} label="Dismiss" message="Dismiss as a false positive." /></div>}</td></tr>)}</tbody></TableWrap>}
        </Card>
      ) : log && (
        <>
          <FilterBar action="/audit"><input type="hidden" name="tab" value="log" /><FilterField label="Action contains" name="q"><input id="q" name="q" defaultValue={q} className="input" placeholder="e.g. loan, withdrawal, login" /></FilterField></FilterBar>
          <Card pad={false}>
            <TableWrap><thead><tr><th>#</th><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
              <tbody>{log.rows.map((r) => <tr key={r.id}><td className="num">{r.id}</td><td className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</td><td>{r.userName ?? "system"}</td><td className="font-medium">{r.action}</td><td className="text-xs">{r.entityType} {r.entityId?.slice(0, 8)}</td><td className="text-xs text-muted max-w-96 truncate" title={JSON.stringify(r.detail)}>{JSON.stringify(r.detail)}</td></tr>)}</tbody></TableWrap>
            <Pagination page={page} pages={Math.ceil(log.n / PAGE)} total={log.n} params={{ tab: "log", q }} base="/audit" />
          </Card>
        </>
      )}
    </>
  );
}
