import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createHash, randomBytes } from "crypto";
import { hashPassword, verifyPassword, passwordProblem } from "@/lib/password";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { orgUsers, organisations, passwordResets, sessions, users } from "@/db/schema";
import { AppError, auditStandalone, type Org } from "@/lib/core";
import { can, type Perm, type Role } from "@/lib/permissions";

export { hashPassword, verifyPassword, passwordProblem };
const COOKIE = "sacco_sid";
const SESSION_DAYS = 7;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type Ctx = {
  user: { id: string; email: string; fullName: string; isPlatformAdmin: boolean };
  sessionId: string;
  orgId: string | null;
  org: Org | null;
  role: Role | null;
  memberId: string | null;
  orgCount: number;
};

export async function createSession(userId: string, orgId: string | null) {
  const token = randomBytes(32).toString("base64url");
  const h = await headers();
  await db.insert(sessions).values({
    tokenHash: sha(token), userId, orgId, expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5), userAgent: h.get("user-agent")?.slice(0, 200),
  });
  const secure = h.get("x-forwarded-proto") === "https";
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_DAYS * 86400 });
}

export async function destroySession() {
  const jar = await cookies();
  const t = jar.get(COOKIE)?.value;
  if (t) await db.delete(sessions).where(eq(sessions.tokenHash, sha(t)));
  jar.delete(COOKIE);
}

export const getCtx = cache(async (): Promise<Ctx | null> => {
  const t = (await cookies()).get(COOKIE)?.value;
  if (!t) return null;
  const [s] = await db.select({
    sid: sessions.id, orgId: sessions.orgId, uid: users.id, email: users.email, fullName: users.fullName, admin: users.isPlatformAdmin, ustatus: users.status,
  }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha(t)), gt(sessions.expiresAt, new Date()))).limit(1);
  if (!s || s.ustatus !== "active") return null;
  const memberships = await db.select({ orgId: orgUsers.orgId, role: orgUsers.role, memberId: orgUsers.memberId, ostatus: orgUsers.status })
    .from(orgUsers).where(eq(orgUsers.userId, s.uid));
  const active = memberships.filter((m) => m.ostatus === "active");
  let m: (typeof active)[number] | undefined = active.find((x) => x.orgId === s.orgId) ?? active[0];
  let org: Org | null = null;
  if (m) {
    const [o] = await db.select().from(organisations).where(eq(organisations.id, m.orgId)).limit(1);
    org = o ?? null;
    if (!org) m = undefined;
  }
  return {
    user: { id: s.uid, email: s.email, fullName: s.fullName, isPlatformAdmin: s.admin }, sessionId: s.sid,
    orgId: m?.orgId ?? null, org, role: (m?.role as Role) ?? null, memberId: m?.memberId ?? null, orgCount: active.length,
  };
});

export type OrgCtx = Ctx & { orgId: string; org: Org; role: Role };

/** For pages: redirect when unauthenticated, forbidden when lacking permission. */
export async function requirePage(perm?: Perm): Promise<OrgCtx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  if (!ctx.orgId || !ctx.org || !ctx.role) redirect(ctx.user.isPlatformAdmin ? "/admin" : "/login?error=no-org");
  if (ctx.org.status !== "active") redirect("/suspended");
  if (ctx.role === "member" && perm !== "portal.use") redirect("/portal");
  if (perm && !can(ctx.role, perm)) redirect("/forbidden");
  return ctx as OrgCtx;
}

/** For server actions / route handlers: throws AppError on failure. */
export async function requireAction(perm: Perm): Promise<OrgCtx> {
  const ctx = await getCtx();
  if (!ctx) throw new AppError("Your session has expired. Please sign in again.", 401);
  if (!ctx.orgId || !ctx.org || !ctx.role) throw new AppError("No organisation workspace", 403);
  if (ctx.org.status !== "active") throw new AppError("This organisation is suspended", 403);
  if (!can(ctx.role, perm)) {
    await auditStandalone(ctx.orgId, { userId: ctx.user.id, name: ctx.user.fullName }, "security.permission_denied", "permission", perm, { role: ctx.role });
    throw new AppError("You do not have permission to perform this action", 403);
  }
  return ctx as OrgCtx;
}

export async function requirePlatformAdmin() {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  if (!ctx.user.isPlatformAdmin) redirect("/forbidden");
  return ctx;
}
export async function requirePlatformAction() {
  const ctx = await getCtx();
  if (!ctx?.user.isPlatformAdmin) throw new AppError("Platform administrator access required", 403);
  return ctx;
}

export const actorOf = (ctx: Ctx) => ({ userId: ctx.user.id, name: ctx.user.fullName });

/* ---------------- login with lockout ---------------- */
export async function login(email: string, password: string) {
  const [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase().trim()}`).limit(1);
  const bad = new AppError("Invalid email or password", 401);
  if (!u) { await hashPassword(password); throw bad; }
  if (u.lockedUntil && u.lockedUntil > new Date()) throw new AppError("Too many failed attempts. Try again in 15 minutes.", 429);
  if (u.status !== "active") throw new AppError("This account is disabled", 403);
  if (!(await verifyPassword(password, u.passwordHash))) {
    const attempts = u.failedAttempts + 1;
    await db.update(users).set({ failedAttempts: attempts, lockedUntil: attempts >= 5 ? new Date(Date.now() + 15 * 60000) : null }).where(eq(users.id, u.id));
    throw bad;
  }
  await db.update(users).set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, u.id));
  const [m] = await db.select().from(orgUsers).where(and(eq(orgUsers.userId, u.id), eq(orgUsers.status, "active"))).limit(1);
  await createSession(u.id, m?.orgId ?? null);
  await auditStandalone(m?.orgId ?? null, { userId: u.id, name: u.fullName }, "auth.login", "user", u.id);
  return { isPlatformAdmin: u.isPlatformAdmin, role: (m?.role as Role | undefined) ?? null };
}

export async function createPasswordReset(email: string) {
  const [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase().trim()}`).limit(1);
  if (!u) return null;
  const token = randomBytes(32).toString("base64url");
  await db.insert(passwordResets).values({ userId: u.id, tokenHash: sha(token), expiresAt: new Date(Date.now() + 3600_000) });
  return { token, user: u };
}
export async function consumePasswordReset(token: string, newPassword: string) {
  const prob = passwordProblem(newPassword);
  if (prob) throw new AppError(prob);
  const [r] = await db.select().from(passwordResets).where(and(eq(passwordResets.tokenHash, sha(token)), gt(passwordResets.expiresAt, new Date()), sql`${passwordResets.usedAt} is null`)).limit(1);
  if (!r) throw new AppError("This reset link is invalid or has expired");
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: await hashPassword(newPassword), failedAttempts: 0, lockedUntil: null }).where(eq(users.id, r.userId));
    await tx.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, r.id));
    await tx.delete(sessions).where(eq(sessions.userId, r.userId));
  });
}
