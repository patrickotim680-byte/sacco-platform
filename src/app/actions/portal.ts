"use server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { members, notificationPrefs, loans } from "@/db/schema";
import type { FormState } from "@/components/forms";
import { fail, S, O, I, OI, oneOf, B } from "@/lib/action-helpers";
import { getCtx, actorOf } from "@/lib/auth";
import { AppError, audit } from "@/lib/core";
import { normalizeUgPhone } from "@/lib/format";
import * as Sv from "@/lib/services/savings";
import * as Ln from "@/lib/services/loans";
import { revalidatePath } from "next/cache";

async function member() {
  const ctx = await getCtx();
  if (!ctx || !ctx.orgId || !ctx.org || ctx.role !== "member" || !ctx.memberId) throw new AppError("Member access required", 403);
  if (ctx.org.status !== "active") throw new AppError("This organisation is suspended", 403);
  return { ctx, svc: { orgId: ctx.orgId, org: ctx.org, actor: actorOf(ctx) }, memberId: ctx.memberId };
}
const ok = (message: string, redirect?: string): FormState => { revalidatePath("/portal", "layout"); return { ok: true, message, redirect, n: Date.now() }; };

export async function portalWithdrawAction(_p: FormState, fd: FormData): Promise<FormState> {
  try {
    const { svc, memberId } = await member();
    await Sv.requestWithdrawal(svc, { accountId: S(fd, "accountId"), amount: I(fd, "amount", "Amount"), channel: oneOf(S(fd, "channel"), ["cash", "mtn_momo", "airtel_money", "bank"] as const, "channel"), reason: O(fd, "reason"), memberIdMustBe: memberId });
    return ok("Withdrawal request sent. You will be notified once it is reviewed.");
  } catch (e) { return fail(e); }
}
export async function portalApplyAction(_p: FormState, fd: FormData): Promise<FormState> {
  try {
    const { svc, memberId } = await member();
    await Ln.applyForLoan(svc, { memberId, productId: S(fd, "productId"), amount: I(fd, "amount", "Amount"), termMonths: I(fd, "termMonths", "Term"), purpose: O(fd, "purpose"), guarantors: [{ memberId: S(fd, "g1"), amount: OI(fd, "ga1") ?? 0 }] });
    return ok("Loan application submitted", "/portal/loans");
  } catch (e) { return fail(e); }
}
export async function portalProfileAction(_p: FormState, fd: FormData): Promise<FormState> {
  try {
    const { ctx, svc, memberId } = await member();
    const phone = normalizeUgPhone(S(fd, "phone"));
    if (!phone) throw new AppError("Enter a valid Uganda phone number");
    await db.transaction(async (tx) => {
      await tx.update(members).set({ phone, email: O(fd, "email") ?? null, address: O(fd, "address") ?? null, nokName: O(fd, "nokName") ?? null, nokPhone: normalizeUgPhone(S(fd, "nokPhone")) ?? O(fd, "nokPhone") ?? null, nokRelationship: O(fd, "nokRelationship") ?? null }).where(and(eq(members.id, memberId), eq(members.orgId, ctx.orgId!)));
      await audit(tx, svc.orgId, svc.actor, "member.self_updated", "member", memberId, {});
    });
    return ok("Details updated");
  } catch (e) { return fail(e); }
}
export async function portalPrefsAction(_p: FormState, fd: FormData): Promise<FormState> {
  try {
    const { svc, memberId } = await member();
    await db.insert(notificationPrefs).values({ orgId: svc.orgId, memberId, sms: B(fd, "sms"), email: B(fd, "email"), whatsapp: B(fd, "whatsapp") })
      .onConflictDoUpdate({ target: [notificationPrefs.orgId, notificationPrefs.memberId], set: { sms: B(fd, "sms"), email: B(fd, "email"), whatsapp: B(fd, "whatsapp") } });
    return ok("Notification preferences saved");
  } catch (e) { return fail(e); }
}
void loans;
