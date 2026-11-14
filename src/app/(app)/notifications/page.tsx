import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { announcements, members, notifications } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ActionForm, Field, ModalForm } from "@/components/forms";
import { Badge, Card, Empty, FilterBar, FilterField, PageHeader, Pagination, Stat, TableWrap, one, pageParam } from "@/components/ui";
import { dispatchQueueAction, sendAnnouncementAction } from "@/app/actions/admin";
import { runContributionAlertsAction } from "@/app/actions/finance";
import { providerConfig } from "@/lib/services/notify";
import { fmtDateTime, label } from "@/lib/format";

export const metadata = { title: "Notifications" };
const PAGE = 30;

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage();
  const sp = await searchParams;
  const channel = one(sp.channel), status = one(sp.status), kind = one(sp.kind), page = pageParam(sp.page);
  const where = and(eq(notifications.orgId, ctx.orgId), channel ? eq(notifications.channel, channel) : undefined, status ? eq(notifications.status, status) : undefined, kind ? eq(notifications.kind, kind) : undefined);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(notifications).where(where);
  const rows = await db.select({ n: notifications, m: members.fullName }).from(notifications).leftJoin(members, eq(members.id, notifications.memberId)).where(where).orderBy(desc(notifications.createdAt)).limit(PAGE).offset((page - 1) * PAGE);
  const counts = (await db.execute(sql`select status, count(*)::int c from notifications where org_id=${ctx.orgId} and channel <> 'in_app' group by status`)).rows as { status: string; c: number }[];
  const c = (s: string) => counts.find((x) => x.status === s)?.c ?? 0;
  const ann = await db.select().from(announcements).where(eq(announcements.orgId, ctx.orgId)).orderBy(desc(announcements.createdAt)).limit(5);
  const prov = providerConfig();
  const send = can(ctx.role, "notifications.send");
  return (
    <>
      <PageHeader title="Notification centre" sub="Contribution reminders, missed-payment alerts, loan reminders, decisions, withdrawal updates and announcements." actions={send && <>
        <ActionForm action={runContributionAlertsAction} submit="Run reminders and overdue checks" inline reset={false}><span /></ActionForm>
        <ActionForm action={dispatchQueueAction} submit="Process queue" inline reset={false}><span /></ActionForm>
        <ModalForm trigger="New announcement" title="Announcement to all active members" action={sendAnnouncementAction} submit="Send announcement"><Field label="Title" name="title" required /><Field label="Message" name="body" required><textarea id="body" name="body" required className="input" /></Field></ModalForm></>} />
      <Card title="Delivery channels" className="mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-sm">
          <div><p className="font-semibold">In-app</p><Badge value="Live" tone="badge-ok" /></div>
          {([["SMS (Africa's Talking)", prov.sms, "AT_USERNAME, AT_API_KEY"], ["Email (Resend)", prov.email, "RESEND_API_KEY, EMAIL_FROM"], ["WhatsApp Cloud API", prov.whatsapp, "WHATSAPP_TOKEN, WHATSAPP_PHONE_ID"]] as const).map(([name, ok, env]) => (
            <div key={name}><p className="font-semibold">{name}</p>{ok ? <Badge value="Credentials configured (untested)" tone="badge-info" /> : <Badge value="Not configured - messages are SIMULATED" tone="badge-warn" />}{!ok && <p className="text-xs text-muted mt-1">Set {env}</p>}</div>))}
        </div>
        <p className="hint mt-3">Status meanings: <b>Sent</b> = accepted by the provider; <b>Simulated</b> = no provider configured, NOT delivered to a phone or inbox; <b>Queued</b> = waiting to be processed; <b>Failed</b> = provider error.</p>
      </Card>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4"><Stat label="Sent to provider" value={c("sent")} /><Stat label="Simulated (not delivered)" value={c("simulated")} tone={c("simulated") ? "warn" : undefined} /><Stat label="Queued" value={c("queued")} /><Stat label="Failed" value={c("failed")} tone={c("failed") ? "danger" : undefined} /></div>
      {ann.length > 0 && <Card title="Recent announcements" className="mb-4"><ul className="space-y-2 text-sm">{ann.map((a) => <li key={a.id}><b>{a.title}</b> <span className="text-muted">- {fmtDateTime(a.createdAt)}</span><p className="text-muted">{a.body}</p></li>)}</ul></Card>}
      <FilterBar action="/notifications">
        <FilterField label="Channel" name="channel"><select id="channel" name="channel" defaultValue={channel ?? ""} className="input"><option value="">All</option><option value="in_app">In-app</option><option value="sms">SMS</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></select></FilterField>
        <FilterField label="Status" name="status"><select id="status" name="status" defaultValue={status ?? ""} className="input"><option value="">All</option>{["delivered", "queued", "sent", "simulated", "failed"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></FilterField>
        <FilterField label="Type" name="kind"><select id="kind" name="kind" defaultValue={kind ?? ""} className="input"><option value="">All</option>{["contribution_reminder", "contribution_receipt", "missed_payment", "loan_reminder", "loan_decision", "withdrawal_update", "meeting_reminder", "announcement"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></FilterField>
      </FilterBar>
      <Card title="Delivery log" pad={false}>
        {rows.length === 0 ? <Empty title="No notifications yet" /> : <TableWrap><thead><tr><th>When</th><th>Recipient</th><th>Type</th><th>Channel</th><th>Message</th><th>Status</th></tr></thead>
          <tbody>{rows.map(({ n, m }) => <tr key={n.id}><td className="whitespace-nowrap">{fmtDateTime(n.createdAt)}</td><td>{m ?? "-"}</td><td>{label(n.kind)}</td><td>{label(n.channel)}</td><td className="max-w-80"><p className="font-medium truncate">{n.title}</p><p className="text-xs text-muted truncate" title={n.body}>{n.body}</p></td>
            <td><Badge value={n.status} />{n.error && <p className="text-xs text-muted max-w-56">{n.error}</p>}</td></tr>)}</tbody></TableWrap>}
        <Pagination page={page} pages={Math.ceil(Number(n) / PAGE)} total={Number(n)} params={{ channel, status, kind }} base="/notifications" />
      </Card>
    </>
  );
}
