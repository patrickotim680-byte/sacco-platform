"use server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  announcements, fraudFlags, members, notifications, orgSubscriptions, orgUsers, organisations, paymentIntegrations, plans, platformSettings,
  supportTickets, ticketMessages, subscriptionInvoices, users,
} from "@/db/schema";
import type { FormState } from "@/components/forms";
import { act, pub, S, O, I, OI, B, oneOf, isoDate } from "@/lib/action-helpers";
import { AppError, audit, DEFAULT_SETTINGS, type OrgSettings } from "@/lib/core";
import { requireAction, requirePlatformAction, getCtx, actorOf } from "@/lib/auth";
import { normalizeUgPhone } from "@/lib/format";
import { addDays, addMonths, todayEAT } from "@/lib/finance";
import { dispatchQueued, queueNotification } from "@/lib/services/notify";
import { createOrganisation, ALL_FEATURES } from "@/lib/services/org";
import { revalidatePath } from "next/cache";
import { hashPassword, passwordProblem } from "@/lib/password";

/* ------------------------------- org settings ------------------------------- */
export async function saveOrgProfileAction(_p: FormState, fd: FormData) {
  return act("settings.manage", async (ctx, svc) => {
    const color = S(fd, "brandColor");
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new AppError("Brand colour must be a hex value such as #0b6e4f");
    const fy = I(fd, "fyStart", "Financial year start month");
    if (fy < 1 || fy > 12) throw new AppError("Financial year start month must be 1-12");
    await db.transaction(async (tx) => {
      await tx.update(organisations).set({
        name: S(fd, "name"), type: oneOf(S(fd, "type"), ["sacco", "vsla", "investment_club", "cooperative", "community_group"] as const, "type"),
        regulatoryStatus: oneOf(S(fd, "regulatoryStatus"), ["informal", "registered_cooperative", "tier4_microfinance", "umra_licensed"] as const, "regulatory status"),
        registrationNo: O(fd, "registrationNo") ?? null, phone: normalizeUgPhone(S(fd, "phone")) ?? O(fd, "phone") ?? null, email: O(fd, "email") ?? null, address: O(fd, "address") ?? null,
        district: O(fd, "district") ?? null, brandColor: color, financialYearStartMonth: fy,
      }).where(eq(organisations.id, ctx.orgId));
      await audit(tx, ctx.orgId, svc.actor, "org.profile_updated", "organisation", ctx.orgId, { name: S(fd, "name") });
    });
    return "Organisation profile saved";
  });
}
export async function savePoliciesAction(_p: FormState, fd: FormData) {
  return act("settings.manage", async (ctx, svc) => {
    const s: OrgSettings = {
      makerChecker: B(fd, "makerChecker"), singleTxnLimit: I(fd, "singleTxnLimit", "Single transaction limit"), largeTxnFlag: I(fd, "largeTxnFlag", "Large transaction flag"),
      duplicateWindowMinutes: I(fd, "duplicateWindowMinutes", "Duplicate window"), membershipFee: I(fd, "membershipFee", "Membership fee"), smsEnabled: B(fd, "smsEnabled"), emailEnabled: B(fd, "emailEnabled"),
      whatsappEnabled: B(fd, "whatsappEnabled"), repaymentReminderDays: I(fd, "repaymentReminderDays", "Reminder days"), allowEarlySettlement: B(fd, "allowEarlySettlement"),
    };
    if (s.singleTxnLimit < 1000 || s.largeTxnFlag < 0 || s.duplicateWindowMinutes < 0 || s.duplicateWindowMinutes > 1440) throw new AppError("One or more limits are out of range");
    await db.transaction(async (tx) => {
      await tx.update(organisations).set({ settings: { ...DEFAULT_SETTINGS, ...s } }).where(eq(organisations.id, ctx.orgId));
      await audit(tx, ctx.orgId, svc.actor, "org.policies_updated", "organisation", ctx.orgId, { ...s });
    });
    return "Financial policies saved";
  });
}
export async function setUserStatusAction(_p: FormState, fd: FormData) {
  return act("users.manage", async (ctx, svc) => {
    const id = S(fd, "id"), status = oneOf(S(fd, "status"), ["active", "disabled"] as const, "status");
    const [ou] = await db.select().from(orgUsers).where(and(eq(orgUsers.id, id), eq(orgUsers.orgId, ctx.orgId)));
    if (!ou) throw new AppError("User not found", 404);
    if (ou.userId === ctx.user.id) throw new AppError("You cannot change your own access");
    await db.transaction(async (tx) => {
      await tx.update(orgUsers).set({ status }).where(eq(orgUsers.id, id));
      await audit(tx, ctx.orgId, svc.actor, `user.${status}`, "user", ou.userId, {});
    });
    return `User ${status === "active" ? "re-enabled" : "disabled"}`;
  });
}
export async function changePasswordAction(_p: FormState, fd: FormData) {
  return pub(async () => {
    const ctx = await getCtx();
    if (!ctx) throw new AppError("Please sign in", 401);
    const [u] = await db.select().from(users).where(eq(users.id, ctx.user.id));
    const { verifyPassword } = await import("@/lib/password");
    if (!(await verifyPassword(String(fd.get("current")), u.passwordHash))) throw new AppError("Current password is incorrect");
    const np = String(fd.get("password"));
    const prob = passwordProblem(np);
    if (prob) throw new AppError(prob);
    if (np !== String(fd.get("confirm"))) throw new AppError("Passwords do not match");
    await db.update(users).set({ passwordHash: await hashPassword(np) }).where(eq(users.id, u.id));
    return "Password changed";
  });
}
export async function reviewFlagAction(_p: FormState, fd: FormData) {
  return act("audit.view", async (ctx, svc) => {
    const status = oneOf(S(fd, "status"), ["reviewed", "dismissed"] as const, "status");
    await db.transaction(async (tx) => {
      await tx.update(fraudFlags).set({ status, reviewedBy: ctx.user.id }).where(and(eq(fraudFlags.id, S(fd, "id")), eq(fraudFlags.orgId, ctx.orgId)));
      await audit(tx, ctx.orgId, svc.actor, `fraud_flag.${status}`, "fraud_flag", S(fd, "id"), {});
    });
    return "Flag updated";
  });
}
export async function saveIntegrationAction(_p: FormState, fd: FormData) {
  return act("payments.manage", async (ctx, svc) => {
    const mode = oneOf(S(fd, "mode"), ["manual_only", "sandbox", "production"] as const, "mode");
    await db.transaction(async (tx) => {
      await tx.update(paymentIntegrations).set({ mode, enabled: B(fd, "enabled"), accountNumber: O(fd, "accountNumber") ?? null }).where(and(eq(paymentIntegrations.id, S(fd, "id")), eq(paymentIntegrations.orgId, ctx.orgId)));
      await audit(tx, ctx.orgId, svc.actor, "payments.integration_updated", "payment_integration", S(fd, "id"), { mode });
    });
    return "Integration settings saved";
  });
}

/* ------------------------------- notifications ------------------------------- */
export async function sendAnnouncementAction(_p: FormState, fd: FormData) {
  return act("notifications.send", async (ctx, svc) => {
    const title = S(fd, "title"), body = S(fd, "body");
    if (!title || !body) throw new AppError("Title and message are required");
    const targets = await db.select({ id: members.id }).from(members).where(and(eq(members.orgId, ctx.orgId), eq(members.status, "active")));
    await db.transaction(async (tx) => {
      const [a] = await tx.insert(announcements).values({ orgId: ctx.orgId, title, body, createdBy: ctx.user.id }).returning({ id: announcements.id });
      for (const m of targets) await queueNotification(tx, ctx.orgId, { memberId: m.id, kind: "announcement", title, body, dedupeKey: `ann:${a.id}` });
      await audit(tx, ctx.orgId, svc.actor, "notification.announcement", "announcement", a.id, { recipients: targets.length });
    });
    const d = await dispatchQueued(ctx.orgId, 500);
    return `Announcement sent to ${targets.length} member(s) in-app. External channels: ${d.sent} sent, ${d.simulated} simulated (NOT delivered, provider not configured), ${d.failed} failed.`;
  });
}
export async function dispatchQueueAction(_p: FormState, _fd: FormData) {
  return act("notifications.send", async (ctx) => {
    const d = await dispatchQueued(ctx.orgId, 500);
    return `Processed ${d.processed}: ${d.sent} sent to provider, ${d.simulated} simulated (not delivered), ${d.failed} failed`;
  });
}
export async function markReadAction(id: string) {
  const ctx = await requireAction("portal.use").catch(() => null) ?? (await requireAction("members.view"));
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.orgId, ctx.orgId)));
  revalidatePath("/", "layout");
}

/* ------------------------------- support ------------------------------- */
export async function createTicketAction(_p: FormState, fd: FormData) {
  return act("members.view", async (ctx, svc) => {
    const subject = S(fd, "subject"), body = S(fd, "body");
    if (!subject || !body) throw new AppError("Subject and description are required");
    await db.transaction(async (tx) => {
      const [t] = await tx.insert(supportTickets).values({ orgId: ctx.orgId, createdBy: ctx.user.id, subject, priority: oneOf(S(fd, "priority") || "normal", ["low", "normal", "high"] as const, "priority") }).returning();
      await tx.insert(ticketMessages).values({ ticketId: t.id, authorId: ctx.user.id, body });
      await audit(tx, ctx.orgId, svc.actor, "support.ticket_created", "support_ticket", t.id, { subject });
    });
    return "Support request submitted";
  });
}

/* ------------------------------- platform administration ------------------------------- */
export async function adminOrgStatusAction(_p: FormState, fd: FormData) {
  try {
    const ctx = await requirePlatformAction();
    const status = oneOf(S(fd, "status"), ["active", "suspended", "deactivated"] as const, "status");
    const id = S(fd, "id");
    await db.transaction(async (tx) => {
      await tx.update(organisations).set({ status }).where(eq(organisations.id, id));
      await audit(tx, id, actorOf(ctx), `platform.org_${status}`, "organisation", id, { reason: O(fd, "reason") });
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: `Organisation ${status}`, n: Date.now() } as FormState;
  } catch (e) { return { error: (e as Error).message, n: Date.now() } as FormState; }
}
export async function adminSetPlanAction(_p: FormState, fd: FormData) {
  try {
    const ctx = await requirePlatformAction();
    const id = S(fd, "id");
    const [plan] = await db.select().from(plans).where(eq(plans.code, S(fd, "plan")));
    if (!plan) throw new AppError("Plan not found");
    const cycle = oneOf(S(fd, "cycle"), ["monthly", "annual"] as const, "billing cycle");
    const today = todayEAT();
    const end = cycle === "annual" ? addMonths(today, 12) : addMonths(today, 1);
    await db.transaction(async (tx) => {
      await tx.update(orgSubscriptions).set({ planId: plan.id, billingCycle: cycle, status: oneOf(S(fd, "status") || "active", ["trial", "active", "past_due", "cancelled"] as const, "status"), currentPeriodStart: today, currentPeriodEnd: end }).where(eq(orgSubscriptions.orgId, id));
      await tx.insert(subscriptionInvoices).values({ orgId: id, planId: plan.id, invoiceNo: `INV-${Date.now().toString(36).toUpperCase()}`, amount: cycle === "annual" ? plan.annualPrice : plan.monthlyPrice, periodStart: today, periodEnd: end, status: "open" });
      await audit(tx, id, actorOf(ctx), "platform.plan_changed", "organisation", id, { plan: plan.code, cycle });
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Subscription updated and invoice generated", n: Date.now() } as FormState;
  } catch (e) { return { error: (e as Error).message, n: Date.now() } as FormState; }
}
export async function adminLimitsAction(_p: FormState, fd: FormData) {
  try {
    const ctx = await requirePlatformAction();
    const id = S(fd, "id");
    await db.transaction(async (tx) => {
      await tx.update(organisations).set({ limitOverrides: { ...(OI(fd, "maxMembers") ? { maxMembers: OI(fd, "maxMembers") } : {}), ...(OI(fd, "maxUsers") ? { maxUsers: OI(fd, "maxUsers") } : {}) } }).where(eq(organisations.id, id));
      await audit(tx, id, actorOf(ctx), "platform.limits_changed", "organisation", id, { maxMembers: OI(fd, "maxMembers"), maxUsers: OI(fd, "maxUsers") });
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Limits updated", n: Date.now() } as FormState;
  } catch (e) { return { error: (e as Error).message, n: Date.now() } as FormState; }
}
export async function adminPlanSaveAction(_p: FormState, fd: FormData) {
  try {
    await requirePlatformAction();
    const features = ALL_FEATURES.filter((f) => B(fd, `f_${f}`));
    await db.update(plans).set({ name: S(fd, "name"), monthlyPrice: String(I(fd, "monthly", "Monthly price")), annualPrice: String(I(fd, "annual", "Annual price")), maxMembers: I(fd, "maxMembers", "Max members"), maxUsers: I(fd, "maxUsers", "Max users"), features, active: B(fd, "active") }).where(eq(plans.id, S(fd, "id")));
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Plan saved", n: Date.now() } as FormState;
  } catch (e) { return { error: (e as Error).message, n: Date.now() } as FormState; }
}
export async function adminCreateOrgAction(_p: FormState, fd: FormData) {
  try {
    const ctx = await requirePlatformAction();
    const email = S(fd, "email").toLowerCase(), pw = String(fd.get("password"));
    const prob = passwordProblem(pw);
    if (prob) throw new AppError(prob);
    const [ex] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    if (ex) throw new AppError("A user with that email already exists");
    await db.transaction(async (tx) => {
      const org = await createOrganisation(tx, { name: S(fd, "name"), type: S(fd, "type") || "sacco", planCode: S(fd, "plan") || "starter", email, makerChecker: false });
      const [u] = await tx.insert(users).values({ email, fullName: S(fd, "adminName"), passwordHash: await hashPassword(pw) }).returning();
      await tx.insert(orgUsers).values({ orgId: org.id, userId: u.id, role: "super_admin" });
      await audit(tx, org.id, actorOf(ctx), "platform.org_created", "organisation", org.id, { name: org.name });
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Organisation created", n: Date.now() } as FormState;
  } catch (e) { return { error: (e as Error).message, n: Date.now() } as FormState; }
}
export async function adminTicketAction(_p: FormState, fd: FormData) {
  try {
    const ctx = await requirePlatformAction();
    const id = S(fd, "id");
    await db.transaction(async (tx) => {
      if (O(fd, "body")) await tx.insert(ticketMessages).values({ ticketId: id, authorId: ctx.user.id, fromPlatform: true, body: S(fd, "body") });
      await tx.update(supportTickets).set({ status: oneOf(S(fd, "status") || "in_progress", ["open", "in_progress", "resolved"] as const, "status") }).where(eq(supportTickets.id, id));
    });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Ticket updated", n: Date.now() } as FormState;
  } catch (e) { return { error: (e as Error).message, n: Date.now() } as FormState; }
}
export async function adminSettingsAction(_p: FormState, fd: FormData) {
  try {
    await requirePlatformAction();
    const rows = [{ key: "signup_enabled", value: B(fd, "signup_enabled") }, { key: "maintenance_mode", value: B(fd, "maintenance_mode") }, { key: "support_email", value: S(fd, "support_email") }];
    for (const r of rows) await db.insert(platformSettings).values(r).onConflictDoUpdate({ target: platformSettings.key, set: { value: r.value, updatedAt: new Date() } });
    revalidatePath("/admin", "layout");
    return { ok: true, message: "Platform settings saved", n: Date.now() } as FormState;
  } catch (e) { return { error: (e as Error).message, n: Date.now() } as FormState; }
}
void isoDate;
