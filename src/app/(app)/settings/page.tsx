import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { members, orgSubscriptions, orgUsers, plans, subscriptionInvoices, users } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { ActionForm, ConfirmAction, Field, Grid, ModalForm, Select } from "@/components/forms";
import { Badge, Card, KV, PageHeader, Tabs, TableWrap, one } from "@/components/ui";
import { addStaffAction } from "@/app/actions/members";
import { changePasswordAction, savePoliciesAction, saveOrgProfileAction, setUserStatusAction } from "@/app/actions/admin";
import { getSettings } from "@/lib/core";
import { planLimits } from "@/lib/services/org";
import { ROLES, ROLE_LABELS } from "@/lib/permissions";
import { fmtDate, fmtDateTime, ugx } from "@/lib/format";
import type { ReactNode } from "react";

export const metadata = { title: "Settings" };
const Check = ({ name, label, on, hint }: { name: string; label: string; on: boolean; hint?: string }) => <label className="flex gap-2 items-start text-sm"><input type="checkbox" name={name} defaultChecked={on} className="mt-1" /><span>{label}{hint && <span className="block text-xs text-muted">{hint}</span>}</span></label>;

export default async function Settings({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("settings.manage");
  const tab = one((await searchParams).tab) ?? "profile";
  const o = ctx.org, s = getSettings(o);
  let body: ReactNode;
  if (tab === "policies") {
    body = (
      <Card title="Financial policies and fraud controls">
        <ActionForm action={savePoliciesAction} submit="Save policies">
          <Grid>
            <Field label="Single-transaction hard limit (UGX)" name="singleTxnLimit" required defaultValue={s.singleTxnLimit} inputMode="numeric" hint="Transactions above this are rejected" />
            <Field label="Flag large transactions at (UGX)" name="largeTxnFlag" required defaultValue={s.largeTxnFlag} inputMode="numeric" hint="Creates a suspicious-activity flag" />
            <Field label="Duplicate detection window (minutes)" name="duplicateWindowMinutes" required defaultValue={s.duplicateWindowMinutes} inputMode="numeric" />
            <Field label="Membership fee (UGX)" name="membershipFee" required defaultValue={s.membershipFee} inputMode="numeric" />
            <Field label="Repayment reminder (days before due)" name="repaymentReminderDays" required defaultValue={s.repaymentReminderDays} inputMode="numeric" />
          </Grid>
          <Check name="makerChecker" label="Require maker-checker approval" on={s.makerChecker} hint="The person who requests a withdrawal, submits a loan or posts a transaction cannot approve or reverse it themselves. Keep ON whenever you have two or more officers." />
          <Check name="allowEarlySettlement" label="Allow early loan settlement with interest rebate" on={s.allowEarlySettlement} />
          <p className="text-xs font-semibold uppercase tracking-wide text-muted pt-2">Notification channels</p>
          <Check name="smsEnabled" label="SMS notifications" on={s.smsEnabled} /><Check name="emailEnabled" label="Email notifications" on={s.emailEnabled} /><Check name="whatsappEnabled" label="WhatsApp notifications" on={s.whatsappEnabled} />
        </ActionForm>
      </Card>
    );
  } else if (tab === "users") {
    const rows = await db.select({ ou: orgUsers, u: users }).from(orgUsers).innerJoin(users, eq(users.id, orgUsers.userId)).where(eq(orgUsers.orgId, ctx.orgId)).orderBy(orgUsers.role);
    body = (
      <Card title="Users and roles" pad={false} actions={<ModalForm small trigger="Add staff user" title="Add staff user" action={addStaffAction}><Field label="Full name" name="fullName" required /><Field label="Email" name="email" type="email" required /><Select label="Role" name="role" required options={ROLES.filter((r) => r !== "member").map((r) => ({ value: r, label: ROLE_LABELS[r] }))} /><Field label="Temporary password" name="password" required hint="8+ characters, letters and numbers" /></ModalForm>}>
        <TableWrap><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last login</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map(({ ou, u }) => <tr key={ou.id}><td>{u.fullName}</td><td>{u.email}</td><td>{ROLE_LABELS[ou.role as keyof typeof ROLE_LABELS]}</td><td>{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : "-"}</td><td><Badge value={ou.status} /></td>
            <td className="r">{u.id !== ctx.user.id && (ou.status === "active" ? <ConfirmAction action={setUserStatusAction} fields={{ id: ou.id, status: "disabled" }} label="Disable" danger message={`Disable ${u.fullName}'s access to this organisation?`} /> : <ConfirmAction action={setUserStatusAction} fields={{ id: ou.id, status: "active" }} label="Enable" message="Restore access." />)}</td></tr>)}</tbody></TableWrap>
      </Card>
    );
  } else if (tab === "billing") {
    const [sub] = await db.select({ s: orgSubscriptions, p: plans }).from(orgSubscriptions).innerJoin(plans, eq(plans.id, orgSubscriptions.planId)).where(eq(orgSubscriptions.orgId, ctx.orgId));
    const lim = await planLimits(ctx.orgId);
    const [mc] = await db.select({ n: sql<number>`count(*)` }).from(members).where(eq(members.orgId, ctx.orgId));
    const [uc] = await db.select({ n: sql<number>`count(*)` }).from(orgUsers).where(eq(orgUsers.orgId, ctx.orgId));
    const inv = await db.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.orgId, ctx.orgId)).orderBy(desc(subscriptionInvoices.createdAt)).limit(10);
    body = (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Subscription"><dl><KV k="Plan">{sub.p.name} <Badge value={sub.s.status} /></KV><KV k="Billing">{sub.s.billingCycle}</KV><KV k="Current period">{fmtDate(sub.s.currentPeriodStart)} - {fmtDate(sub.s.currentPeriodEnd)}</KV><KV k="Members">{Number(mc.n)} / {lim.maxMembers.toLocaleString()}</KV><KV k="Users">{Number(uc.n)} / {lim.maxUsers}</KV><KV k="Features">{sub.p.features.join(", ")}</KV></dl><p className="hint mt-2">Plan changes are made by Softronics support. Contact us from the Support page.</p></Card>
        <Card title="Invoices" pad={false}><TableWrap><thead><tr><th>Invoice</th><th>Period</th><th className="r">Amount</th><th>Status</th></tr></thead><tbody>{inv.map((i) => <tr key={i.id}><td className="num text-xs">{i.invoiceNo}</td><td>{fmtDate(i.periodStart)}</td><td className="r num">{ugx(i.amount)}</td><td><Badge value={i.status} /></td></tr>)}</tbody></TableWrap></Card>
      </div>
    );
  } else if (tab === "security") {
    body = (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Change your password"><ActionForm action={changePasswordAction} submit="Change password"><Field label="Current password" name="current" type="password" required /><Field label="New password" name="password" type="password" required /><Field label="Confirm new password" name="confirm" type="password" required /></ActionForm></Card>
        <Card title="Backups and recovery">
          <ul className="text-sm space-y-2 list-disc pl-5 text-muted">
            <li>Database: enable daily automated backups with point-in-time recovery on your PostgreSQL host (Supabase, Neon, RDS). Additionally run <code>scripts/backup.sh</code> to produce encrypted <code>pg_dump</code> files.</li>
            <li>Documents: back up the <code>STORAGE_DIR</code> directory (or the object-storage bucket) alongside the database.</li>
            <li>Recovery: restore the dump into a fresh database, re-apply <code>src/db/setup-sql.ts</code> triggers (done automatically on start), then verify the audit chain and the Accounting reconciliation page.</li>
            <li>See <code>README.md</code> for the full runbook. This page does not take backups itself.</li>
          </ul>
        </Card>
      </div>
    );
  } else {
    body = (
      <Card title="Organisation profile and branding">
        <ActionForm action={saveOrgProfileAction} submit="Save profile">
          <Field label="Organisation name" name="name" required defaultValue={o.name} />
          <Grid>
            <Select label="Type" name="type" required defaultValue={o.type} options={[{ value: "sacco", label: "SACCO" }, { value: "vsla", label: "VSLA" }, { value: "investment_club", label: "Investment club" }, { value: "cooperative", label: "Cooperative" }, { value: "community_group", label: "Community savings group" }]} />
            <Select label="Regulatory status" name="regulatoryStatus" required defaultValue={o.regulatoryStatus} hint="Obligations differ: informal groups, registered cooperative SACCOs and licensed tier 4 institutions have different reporting duties. Confirm yours with the Ministry/UMRA/Registrar." options={[{ value: "informal", label: "Informal savings group" }, { value: "registered_cooperative", label: "Registered cooperative / SACCO" }, { value: "tier4_microfinance", label: "Tier 4 microfinance institution" }, { value: "umra_licensed", label: "UMRA licensed" }]} />
            <Field label="Registration number" name="registrationNo" defaultValue={o.registrationNo} /><Field label="Phone" name="phone" defaultValue={o.phone} inputMode="tel" /><Field label="Email" name="email" type="email" defaultValue={o.email} /><Field label="District" name="district" defaultValue={o.district} />
            <Field label="Address" name="address" defaultValue={o.address} /><Field label="Brand colour" name="brandColor" type="color" defaultValue={o.brandColor} /><Field label="Financial year starts in month (1-12)" name="fyStart" required defaultValue={o.financialYearStartMonth} inputMode="numeric" hint="1 = January ... 7 = July (Uganda Government FY)" />
          </Grid>
          <p className="hint">Currency: {o.currency}. Time zone: {o.timezone} (East Africa Time, UTC+3).</p>
        </ActionForm>
      </Card>
    );
  }
  return (
    <>
      <PageHeader title="Settings" sub="Organisation profile, policies, users, subscription and security." />
      <Tabs base="/settings" current={tab} tabs={[{ key: "profile", label: "Profile & branding" }, { key: "policies", label: "Policies & limits" }, { key: "users", label: "Users & roles" }, { key: "billing", label: "Subscription" }, { key: "security", label: "Security & backups" }]} />
      {body}
    </>
  );
}
