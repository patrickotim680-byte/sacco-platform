import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { supportTickets, ticketMessages, users } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { Field, ModalForm, Select } from "@/components/forms";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { createTicketAction } from "@/app/actions/admin";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Support" };

export default async function Support() {
  const ctx = await requirePage();
  const tickets = await db.select().from(supportTickets).where(eq(supportTickets.orgId, ctx.orgId)).orderBy(desc(supportTickets.createdAt)).limit(30);
  const msgs = tickets.length ? await db.select({ m: ticketMessages, name: users.fullName }).from(ticketMessages).innerJoin(users, eq(users.id, ticketMessages.authorId)).where(inArray(ticketMessages.ticketId, tickets.map((t) => t.id))).orderBy(ticketMessages.createdAt) : [];
  return (
    <>
      <PageHeader title="Support" sub="Contact the Softronics platform team." actions={<ModalForm trigger="New request" title="New support request" action={createTicketAction}><Field label="Subject" name="subject" required /><Select label="Priority" name="priority" required defaultValue="normal" options={[{ value: "low", label: "Low" }, { value: "normal", label: "Normal" }, { value: "high", label: "High" }]} /><Field label="Describe the issue" name="body" required><textarea id="body" name="body" required className="input" /></Field><p className="hint">Do not include passwords or full member financial details.</p></ModalForm>} />
      {tickets.length === 0 ? <Card><Empty title="No support requests" /></Card> : <div className="space-y-3">{tickets.map((t) => (
        <Card key={t.id} title={<>{t.subject} <Badge value={t.status} /></>} actions={<span className="text-xs text-muted">{fmtDateTime(t.createdAt)}</span>}>
          <ul className="space-y-2 text-sm">{msgs.filter((x) => x.m.ticketId === t.id).map((x) => <li key={x.m.id} className={x.m.fromPlatform ? "pl-4 border-l-2 border-brand" : ""}><b>{x.m.fromPlatform ? "Softronics support" : x.name}</b> <span className="text-muted">{fmtDateTime(x.m.createdAt)}</span><p className="whitespace-pre-wrap text-muted">{x.m.body}</p></li>)}</ul>
        </Card>))}</div>}
    </>
  );
}
