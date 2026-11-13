import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { orgSubscriptions, organisations, plans, platformSettings, supportTickets, ticketMessages, users } from "@/db/schema";
import { requirePlatformAdmin } from "@/lib/auth";
import { ActionForm, ConfirmAction, Field, Grid, ModalForm, Select } from "@/components/forms";
import { Badge, Card, Empty, PageHeader, Stat, Tabs, TableWrap, one } from "@/components/ui";
import { adminCreateOrgAction, adminLimitsAction, adminOrgStatusAction, adminPlanSaveAction, adminSetPlanAction, adminSettingsAction, adminTicketAction } from "@/app/actions/admin";
import { ALL_FEATURES } from "@/lib/services/org";
import { fmtDate, fmtDateTime, label, ugx } from "@/lib/format";
import { providerConfig } from "@/lib/services/notify";
import type { ReactNode } from "react";

export const metadata = { title: "Platform console" };

export default async function Admin({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePlatformAdmin();
  const tab = one((await searchParams).tab) ?? "overview";
  const t0 = Date.now();
  await db.execute(sql`select 1`);
  const dbMs = Date.now() - t0;
  const planList = await db.select().from(plans).orderBy(plans.sortOrder);
  // Aggregates only: organisation-level counts, never member balances or personal data.
  const orgs = (await db.execute(sql`
    select o.id, o.name, o.type, o.status, o.is_demo, o.created_at, o.limit_overrides, p.code plan_code, p.name plan_name, p.max_members, p.max_users, s.status sub_status, s.billing_cycle, s.current_period_end,
      (select count(*) from members m where m.org_id=o.id) members, (select count(*) from org_users u where u.org_id=o.id and u.role <> 'member') staff,
      (select count(*) from transactions t where t.org_id=o.id) txns, (select max(created_at) from audit_logs a where a.org_id=o.id) last_activity
    from organisations o join org_subscriptions s on s.org_id=o.id join plans p on p.id=s.plan_id order by o.created_at desc`)).rows as Record<string, string | number | null | Record<string, number>>[];
  let body: ReactNode;
  if (tab === "orgs") {
    body = (
      <Card title="Organisations" pad={false} actions={<ModalForm small trigger="Register organisation" title="Register an organisation" action={adminCreateOrgAction}><Field label="Organisation name" name="name" required /><Grid><Select label="Type" name="type" required options={[{ value: "sacco", label: "SACCO" }, { value: "vsla", label: "VSLA" }, { value: "investment_club", label: "Investment club" }, { value: "cooperative", label: "Cooperative" }, { value: "community_group", label: "Community group" }]} /><Select label="Plan" name="plan" required defaultValue="starter" options={planList.map((p) => ({ value: p.code, label: p.name }))} /><Field label="Owner name" name="adminName" required /><Field label="Owner email" name="email" type="email" required /></Grid><Field label="Temporary password" name="password" required /></ModalForm>}>
        <TableWrap><thead><tr><th>Organisation</th><th>Type</th><th>Plan</th><th className="r">Members</th><th className="r">Staff</th><th className="r">Txns</th><th>Last activity</th><th>Status</th><th /></tr></thead>
          <tbody>{orgs.map((o) => (
            <tr key={String(o.id)}><td className="font-medium">{String(o.name)} {o.is_demo ? <Badge value="Demo" tone="badge-warn" /> : null}</td><td>{label(String(o.type))}</td><td>{String(o.plan_name)} <span className="text-muted text-xs">({String(o.billing_cycle)}, {label(String(o.sub_status))})</span></td><td className="r num">{String(o.members)} / {String((o.limit_overrides as { maxMembers?: number })?.maxMembers ?? o.max_members)}</td><td className="r num">{String(o.staff)}</td><td className="r num">{String(o.txns)}</td><td>{o.last_activity ? fmtDateTime(String(o.last_activity)) : "-"}</td><td><Badge value={String(o.status)} /></td>
              <td className="r"><div className="flex gap-1.5 justify-end flex-wrap">
                {o.status === "active" ? <ConfirmAction action={adminOrgStatusAction} fields={{ id: String(o.id), status: "suspended" }} label="Suspend" danger message="Users of this organisation lose access immediately. Data is retained." /> : <ConfirmAction action={adminOrgStatusAction} fields={{ id: String(o.id), status: "active" }} label="Activate" variant="primary" message="Restore access for this organisation." />}
                {o.status !== "deactivated" && <ConfirmAction action={adminOrgStatusAction} fields={{ id: String(o.id), status: "deactivated" }} label="Deactivate" danger message="Marks the organisation as closed. Data is retained for legal retention periods." />}
                <ModalForm small variant="default" trigger="Plan" title={`Plan - ${o.name}`} action={adminSetPlanAction}><input type="hidden" name="id" value={String(o.id)} /><Grid><Select label="Plan" name="plan" required defaultValue={String(o.plan_code)} options={planList.map((p) => ({ value: p.code, label: `${p.name} (${ugx(p.monthlyPrice)}/mo)` }))} /><Select label="Billing" name="cycle" required defaultValue={String(o.billing_cycle)} options={[{ value: "monthly", label: "Monthly" }, { value: "annual", label: "Annual" }]} /><Select label="Subscription status" name="status" required defaultValue={String(o.sub_status)} options={["trial", "active", "past_due", "cancelled"].map((s) => ({ value: s, label: label(s) }))} /></Grid><p className="hint">Generates an open invoice for the period.</p></ModalForm>
                <ModalForm small variant="default" trigger="Limits" title={`Limit overrides - ${o.name}`} action={adminLimitsAction}><input type="hidden" name="id" value={String(o.id)} /><Grid><Field label="Max members" name="maxMembers" inputMode="numeric" defaultValue={(o.limit_overrides as { maxMembers?: number })?.maxMembers} /><Field label="Max staff users" name="maxUsers" inputMode="numeric" defaultValue={(o.limit_overrides as { maxUsers?: number })?.maxUsers} /></Grid><p className="hint">Leave blank to use the plan default.</p></ModalForm>
              </div></td></tr>))}</tbody></TableWrap>
      </Card>
    );
  } else if (tab === "plans") {
    body = (
      <Card title="Subscription plans" pad={false}>
        <TableWrap><thead><tr><th>Plan</th><th className="r">Monthly</th><th className="r">Annual</th><th className="r">Members</th><th className="r">Users</th><th>Features</th><th /></tr></thead>
          <tbody>{planList.map((p) => <tr key={p.id}><td className="font-medium">{p.name} {!p.active && <Badge value="inactive" />}</td><td className="r num">{ugx(p.monthlyPrice)}</td><td className="r num">{ugx(p.annualPrice)}</td><td className="r num">{p.maxMembers.toLocaleString()}</td><td className="r num">{p.maxUsers}</td><td className="text-xs text-muted max-w-96">{p.features.join(", ")}</td>
            <td className="r"><ModalForm wide small variant="default" trigger="Edit" title={`Edit ${p.name}`} action={adminPlanSaveAction}><input type="hidden" name="id" value={p.id} /><Grid><Field label="Name" name="name" required defaultValue={p.name} /><Field label="Monthly price (UGX)" name="monthly" required defaultValue={Number(p.monthlyPrice)} inputMode="numeric" /><Field label="Annual price (UGX)" name="annual" required defaultValue={Number(p.annualPrice)} inputMode="numeric" /><Field label="Max members" name="maxMembers" required defaultValue={p.maxMembers} inputMode="numeric" /><Field label="Max staff users" name="maxUsers" required defaultValue={p.maxUsers} inputMode="numeric" /></Grid>
              <p className="lbl">Features</p><div className="grid grid-cols-2 gap-1">{ALL_FEATURES.map((f) => <label key={f} className="flex gap-2 text-sm items-center"><input type="checkbox" name={`f_${f}`} defaultChecked={p.features.includes(f)} /> {label(f)}</label>)}</div><label className="flex gap-2 text-sm items-center"><input type="checkbox" name="active" defaultChecked={p.active} /> Plan available for new organisations</label></ModalForm></td></tr>)}</tbody></TableWrap>
      </Card>
    );
  } else if (tab === "support") {
    const tickets = await db.select({ t: supportTickets, org: organisations.name }).from(supportTickets).innerJoin(organisations, eq(organisations.id, supportTickets.orgId)).orderBy(desc(supportTickets.createdAt)).limit(40);
    const msgs = await db.select({ m: ticketMessages, name: users.fullName }).from(ticketMessages).innerJoin(users, eq(users.id, ticketMessages.authorId)).orderBy(ticketMessages.createdAt);
    body = tickets.length === 0 ? <Card><Empty title="No support requests" /></Card> : (
      <div className="space-y-3">{tickets.map(({ t, org }) => (
        <Card key={t.id} title={<>{t.subject} <span className="text-muted font-normal">- {org}</span> <Badge value={t.status} /></>} actions={<span className="text-xs text-muted">{fmtDateTime(t.createdAt)} - {t.priority}</span>}>
          <ul className="space-y-2 text-sm mb-3">{msgs.filter((x) => x.m.ticketId === t.id).map((x) => <li key={x.m.id} className={x.m.fromPlatform ? "pl-4 border-l-2 border-brand" : ""}><b>{x.name}</b><p className="whitespace-pre-wrap text-muted">{x.m.body}</p></li>)}</ul>
          <ActionForm action={adminTicketAction} submit="Reply / update"><input type="hidden" name="id" value={t.id} /><Grid><Field label="Reply" name="body"><textarea id={`b${t.id}`} name="body" className="input" /></Field><Select label="Status" name="status" required defaultValue={t.status} options={[{ value: "open", label: "Open" }, { value: "in_progress", label: "In progress" }, { value: "resolved", label: "Resolved" }]} /></Grid></ActionForm>
        </Card>))}</div>
    );
  } else if (tab === "settings") {
    const st = Object.fromEntries((await db.select().from(platformSettings)).map((s) => [s.key, s.value]));
    const pc = providerConfig();
    body = (
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Platform settings"><ActionForm action={adminSettingsAction} submit="Save settings">
          <label className="flex gap-2 text-sm items-center"><input type="checkbox" name="signup_enabled" defaultChecked={st.signup_enabled !== false} /> Allow new organisation self-registration</label>
          <label className="flex gap-2 text-sm items-center"><input type="checkbox" name="maintenance_mode" defaultChecked={st.maintenance_mode === true} /> Maintenance mode flag</label>
          <Field label="Support email" name="support_email" defaultValue={String(st.support_email ?? "")} /></ActionForm></Card>
        <Card title="Platform integrations (environment)"><ul className="text-sm space-y-2"><li>SMS (Africa&apos;s Talking): {pc.sms ? "configured" : "not configured"}</li><li>Email (Resend): {pc.email ? "configured" : "not configured"}</li><li>WhatsApp Cloud API: {pc.whatsapp ? "configured" : "not configured"}</li><li>MTN MoMo credentials: {process.env.MTN_MOMO_API_KEY ? "present" : "absent"}</li><li>Airtel Money credentials: {process.env.AIRTEL_CLIENT_ID ? "present" : "absent"}</li></ul></Card>
      </div>
    );
  } else {
    const active = orgs.filter((o) => o.status === "active").length;
    const mrr = orgs.filter((o) => o.status === "active" && !o.is_demo && o.sub_status === "active").reduce((s, o) => s + Number(planList.find((p) => p.code === o.plan_code)?.monthlyPrice ?? 0), 0);
    const byPlan = planList.map((p) => ({ p, n: orgs.filter((o) => o.plan_code === p.code).length }));
    body = (
      <>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3"><Stat label="Organisations" value={orgs.length} sub={`${active} active`} /><Stat label="Total members (count only)" value={orgs.reduce((s, o) => s + Number(o.members), 0).toLocaleString()} /><Stat label="Transactions processed (count)" value={orgs.reduce((s, o) => s + Number(o.txns), 0).toLocaleString()} /><Stat label="Monthly recurring revenue" value={ugx(mrr)} sub="Active paying, non-demo orgs" /></div>
        <div className="grid lg:grid-cols-2 gap-4 mt-4">
          <Card title="Platform health"><ul className="text-sm space-y-2"><li className="flex justify-between"><span>Database</span><Badge value="Connected" tone="badge-ok" /></li><li className="flex justify-between"><span>Query latency</span><span className="num">{dbMs} ms</span></li><li className="flex justify-between"><span>Suspended organisations</span><span>{orgs.filter((o) => o.status === "suspended").length}</span></li><li className="flex justify-between"><span>Subscriptions past due</span><span>{orgs.filter((o) => o.sub_status === "past_due").length}</span></li></ul><p className="hint mt-3">This console shows organisation-level usage only. It never lists member balances or personal data.</p></Card>
          <Card title="Organisations by plan" pad={false}><TableWrap><thead><tr><th>Plan</th><th className="r">Organisations</th><th className="r">Price / month</th></tr></thead><tbody>{byPlan.map(({ p, n }) => <tr key={p.id}><td>{p.name}</td><td className="r num">{n}</td><td className="r num">{ugx(p.monthlyPrice)}</td></tr>)}</tbody></TableWrap></Card>
        </div>
        <Card title="Newest organisations" className="mt-4" pad={false}><TableWrap><thead><tr><th>Name</th><th>Plan</th><th>Registered</th><th>Subscription ends</th><th>Status</th></tr></thead><tbody>{orgs.slice(0, 6).map((o) => <tr key={String(o.id)}><td>{String(o.name)}</td><td>{String(o.plan_name)}</td><td>{fmtDate(String(o.created_at))}</td><td>{fmtDate(String(o.current_period_end))}</td><td><Badge value={String(o.status)} /></td></tr>)}</tbody></TableWrap></Card>
      </>
    );
  }
  void orgSubscriptions;
  return (
    <>
      <PageHeader title="Platform console" sub="SaaS administration for Softronics: organisations, subscriptions, limits, support and platform settings." />
      <Tabs base="/admin" current={tab} tabs={[{ key: "overview", label: "Overview" }, { key: "orgs", label: "Organisations", count: orgs.length }, { key: "plans", label: "Plans & features" }, { key: "support", label: "Support" }, { key: "settings", label: "Settings" }]} />
      {body}
    </>
  );
}
