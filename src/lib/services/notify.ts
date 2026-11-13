import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { members, notificationPrefs, notifications, organisations } from "@/db/schema";
import { getSettings, type Tx } from "@/lib/core";
import { normalizeUgPhone } from "@/lib/format";

export type NotifyInput = { memberId?: string | null; userId?: string | null; kind: string; title: string; body: string; dedupeKey?: string };

/**
 * Queues a notification: always an in-app record, plus SMS/email/WhatsApp rows according to the
 * member's preferences and organisation settings. External rows start as "queued" and are only
 * marked "sent" when a configured provider accepts them; otherwise "simulated" (NOT delivered).
 */
export async function queueNotification(tx: Tx, orgId: string, n: NotifyInput) {
  const base = { orgId, memberId: n.memberId ?? null, userId: n.userId ?? null, kind: n.kind, title: n.title, body: n.body };
  const key = (_c: string) => n.dedupeKey;
  await tx.insert(notifications).values({ ...base, channel: "in_app", status: "delivered", sentAt: new Date(), dedupeKey: key("in_app") }).onConflictDoNothing();
  if (!n.memberId) return;
  const [org] = await tx.select({ settings: organisations.settings }).from(organisations).where(eq(organisations.id, orgId));
  const s = getSettings({ settings: org?.settings ?? {} });
  const [m] = await tx.select({ phone: members.phone, email: members.email }).from(members).where(and(eq(members.id, n.memberId), eq(members.orgId, orgId)));
  if (!m) return;
  const [p] = await tx.select().from(notificationPrefs).where(and(eq(notificationPrefs.orgId, orgId), eq(notificationPrefs.memberId, n.memberId)));
  const pref = p ?? { sms: true, email: false, whatsapp: false };
  const rows: (typeof notifications.$inferInsert)[] = [];
  if (s.smsEnabled && pref.sms && normalizeUgPhone(m.phone)) rows.push({ ...base, channel: "sms", status: "queued", dedupeKey: key("sms") });
  if (s.emailEnabled && pref.email && m.email) rows.push({ ...base, channel: "email", status: "queued", dedupeKey: key("email") });
  if (s.whatsappEnabled && pref.whatsapp && normalizeUgPhone(m.phone)) rows.push({ ...base, channel: "whatsapp", status: "queued", dedupeKey: key("whatsapp") });
  if (rows.length) await tx.insert(notifications).values(rows).onConflictDoNothing();
}

/* ---------------- provider adapters (untested against live APIs unless env configured) ---------------- */
export type SendResult = { status: "sent" | "failed" | "simulated"; providerRef?: string; error?: string; provider: string };

export const providerConfig = () => ({
  sms: !!(process.env.AT_USERNAME && process.env.AT_API_KEY),
  email: !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
  whatsapp: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
});

async function sendSms(to: string, text: string): Promise<SendResult> {
  if (!providerConfig().sms) return { status: "simulated", provider: "none", error: "SMS provider not configured (set AT_USERNAME and AT_API_KEY)" };
  try {
    const sandbox = process.env.AT_USERNAME === "sandbox";
    const res = await fetch(`https://api${sandbox ? ".sandbox" : ""}.africastalking.com/version1/messaging`, {
      method: "POST",
      headers: { apiKey: process.env.AT_API_KEY!, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: process.env.AT_USERNAME!, to, message: text, ...(process.env.AT_SENDER_ID ? { from: process.env.AT_SENDER_ID } : {}) }),
    });
    const j = (await res.json().catch(() => ({}))) as { SMSMessageData?: { Recipients?: { status: string; messageId: string }[] } };
    const r = j.SMSMessageData?.Recipients?.[0];
    if (res.ok && r?.status === "Success") return { status: "sent", providerRef: r.messageId, provider: "africastalking" };
    return { status: "failed", provider: "africastalking", error: r?.status ?? `HTTP ${res.status}` };
  } catch (e) { return { status: "failed", provider: "africastalking", error: (e as Error).message }; }
}
async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  if (!providerConfig().email) return { status: "simulated", provider: "none", error: "Email provider not configured (set RESEND_API_KEY and EMAIL_FROM)" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, text }),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    return res.ok ? { status: "sent", providerRef: j.id, provider: "resend" } : { status: "failed", provider: "resend", error: j.message ?? `HTTP ${res.status}` };
  } catch (e) { return { status: "failed", provider: "resend", error: (e as Error).message }; }
}
async function sendWhatsApp(to: string, text: string): Promise<SendResult> {
  if (!providerConfig().whatsapp) return { status: "simulated", provider: "none", error: "WhatsApp Cloud API not configured (set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID)" };
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace("+", ""), type: "text", text: { body: text } }),
    });
    const j = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message: string } };
    return res.ok ? { status: "sent", providerRef: j.messages?.[0]?.id, provider: "whatsapp_cloud" } : { status: "failed", provider: "whatsapp_cloud", error: j.error?.message ?? `HTTP ${res.status}` };
  } catch (e) { return { status: "failed", provider: "whatsapp_cloud", error: (e as Error).message }; }
}

/** Sends queued external notifications. Safe to call repeatedly. */
export async function dispatchQueued(orgId: string, limit = 100) {
  const rows = await db.select({ n: notifications, phone: members.phone, email: members.email })
    .from(notifications).leftJoin(members, eq(members.id, notifications.memberId))
    .where(and(eq(notifications.orgId, orgId), eq(notifications.status, "queued"), inArray(notifications.channel, ["sms", "email", "whatsapp"]))).limit(limit);
  let sent = 0, failed = 0, simulated = 0;
  for (const { n, phone, email } of rows) {
    const to = normalizeUgPhone(phone);
    let r: SendResult;
    if (n.channel === "sms" && to) r = await sendSms(to, `${n.title}: ${n.body}`);
    else if (n.channel === "whatsapp" && to) r = await sendWhatsApp(to, `${n.title}\n${n.body}`);
    else if (n.channel === "email" && email) r = await sendEmail(email, n.title, n.body);
    else r = { status: "failed", provider: "none", error: "No valid destination" };
    await db.update(notifications).set({ status: r.status, provider: r.provider, providerRef: r.providerRef ?? null, error: r.error ?? null, sentAt: r.status === "sent" ? new Date() : null }).where(eq(notifications.id, n.id));
    if (r.status === "sent") sent++; else if (r.status === "failed") failed++; else simulated++;
  }
  return { processed: rows.length, sent, failed, simulated };
}

export const pendingCount = async (orgId: string) =>
  Number((await db.execute(sql`select count(*) c from notifications where org_id=${orgId} and status='queued' and channel <> 'in_app'`)).rows[0].c);
