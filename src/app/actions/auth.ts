"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { FormState } from "@/components/forms";
import { consumePasswordReset, createPasswordReset, createSession, destroySession, getCtx, login } from "@/lib/auth";
import { AppError, auditStandalone } from "@/lib/core";
import { pub, S, O } from "@/lib/action-helpers";
import { registerOrganisation } from "@/lib/services/org";
import { dispatchQueued, providerConfig } from "@/lib/services/notify";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgUsers, platformSettings } from "@/db/schema";

export async function loginAction(_p: FormState, fd: FormData): Promise<FormState> {
  return pub(async () => {
    const email = S(fd, "email"), password = String(fd.get("password") ?? "");
    if (!email || !password) throw new AppError("Enter your email and password");
    const r = await login(email, password);
    return { message: "Signed in", redirect: r.isPlatformAdmin && !r.role ? "/admin" : r.role === "member" ? "/portal" : "/dashboard" };
  });
}

export async function registerAction(_p: FormState, fd: FormData): Promise<FormState> {
  return pub(async () => {
    const [s] = await db.select().from(platformSettings).where(eq(platformSettings.key, "signup_enabled"));
    if (s && s.value === false) throw new AppError("New registrations are currently disabled");
    if (S(fd, "password") !== S(fd, "confirm")) throw new AppError("Passwords do not match");
    if (fd.get("terms") !== "on") throw new AppError("Please accept the terms and data protection notice");
    const r = await registerOrganisation({ orgName: S(fd, "orgName"), type: S(fd, "type") || "sacco", adminName: S(fd, "adminName"), email: S(fd, "email"), phone: O(fd, "phone"), password: String(fd.get("password")), district: O(fd, "district") });
    await createSession(r.user.id, r.org.id);
    return { message: "Workspace created", redirect: "/dashboard" };
  });
}

export async function forgotAction(_p: FormState, fd: FormData): Promise<FormState> {
  return pub(async () => {
    const email = S(fd, "email");
    const r = await createPasswordReset(email);
    // Never reveal whether the email exists.
    if (r) {
      const h = await headers();
      const origin = process.env.APP_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
      const link = `${origin}/reset-password?token=${r.token}`;
      if (providerConfig().email) {
        await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: process.env.EMAIL_FROM, to: email, subject: "Reset your password", text: `Use this link within 1 hour: ${link}` }) }).catch(() => null);
      } else if (process.env.NODE_ENV !== "production" || process.env.SHOW_RESET_LINK === "true") {
        return { message: `Email delivery is not configured on this server, so no email was sent. Development reset link: ${link}` };
      } else console.warn("[auth] password reset requested but no email provider configured");
    }
    return "If an account exists for that email, a reset link has been sent.";
  });
}

export async function resetAction(_p: FormState, fd: FormData): Promise<FormState> {
  return pub(async () => {
    if (S(fd, "password") !== S(fd, "confirm")) throw new AppError("Passwords do not match");
    await consumePasswordReset(S(fd, "token"), String(fd.get("password")));
    return { message: "Password updated. Please sign in.", redirect: "/login" };
  });
}

export async function logoutAction() {
  const ctx = await getCtx();
  if (ctx) await auditStandalone(ctx.orgId, { userId: ctx.user.id, name: ctx.user.fullName }, "auth.logout", "user", ctx.user.id);
  await destroySession();
  redirect("/login");
}

export async function switchOrgAction(fd: FormData) {
  const ctx = await getCtx();
  const orgId = String(fd.get("orgId") ?? "");
  if (!ctx || !orgId) return;
  const [m] = await db.select().from(orgUsers).where(eq(orgUsers.orgId, orgId));
  void m; // membership is verified by getCtx on every request; only switch to orgs the user belongs to
  const mine = await db.select({ orgId: orgUsers.orgId }).from(orgUsers).where(eq(orgUsers.userId, ctx.user.id));
  if (!mine.some((x) => x.orgId === orgId)) return;
  const { sessions } = await import("@/db/schema");
  await db.update(sessions).set({ orgId }).where(eq(sessions.id, ctx.sessionId));
  redirect("/dashboard");
}
export async function _unused() { return dispatchQueued; }
