import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  members, notificationPrefs, orgSubscriptions, orgUsers, organisations, paymentIntegrations, plans, savingsAccounts, savingsProducts, loanProducts, subscriptionInvoices, users,
} from "@/db/schema";
import { AppError, audit, DEFAULT_SETTINGS, nextSeq, seedChartOfAccounts, type Actor, type Tx } from "@/lib/core";
import { hashPassword, passwordProblem } from "@/lib/password";
import { addDays, addMonths, todayEAT } from "@/lib/finance";
import { normalizeUgPhone } from "@/lib/format";
import type { Role } from "@/lib/permissions";
import type { Svc } from "@/lib/services/savings";

export const PLAN_DEFAULTS = [
  { code: "starter", name: "Starter", monthlyPrice: "50000", annualPrice: "500000", maxMembers: 100, maxUsers: 3, features: ["members", "savings", "loans", "reports_basic"], sortOrder: 1 },
  { code: "growth", name: "Growth", monthlyPrice: "150000", annualPrice: "1500000", maxMembers: 500, maxUsers: 10, features: ["members", "savings", "loans", "vsla_groups", "accounting", "reports_basic", "reports_export", "member_portal", "notifications_sms"], sortOrder: 2 },
  { code: "professional", name: "Professional", monthlyPrice: "400000", annualPrice: "4000000", maxMembers: 3000, maxUsers: 40, features: ["members", "savings", "loans", "vsla_groups", "accounting", "reports_basic", "reports_export", "member_portal", "notifications_sms", "mobile_money", "audit_trail", "api_access"], sortOrder: 3 },
  { code: "enterprise", name: "Enterprise", monthlyPrice: "1200000", annualPrice: "12000000", maxMembers: 100000, maxUsers: 500, features: ["members", "savings", "loans", "vsla_groups", "accounting", "reports_basic", "reports_export", "member_portal", "notifications_sms", "mobile_money", "audit_trail", "api_access", "sso", "priority_support"], sortOrder: 4 },
];
export const ALL_FEATURES = ["members", "savings", "loans", "vsla_groups", "accounting", "reports_basic", "reports_export", "member_portal", "notifications_sms", "mobile_money", "audit_trail", "api_access", "sso", "priority_support"];

export async function ensurePlans(tx: Tx) {
  await tx.insert(plans).values(PLAN_DEFAULTS).onConflictDoNothing();
}
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org";

export async function createOrganisation(tx: Tx, i: {
  name: string; type: string; regulatoryStatus?: string; phone?: string; email?: string; district?: string; planCode?: string; isDemo?: boolean; makerChecker?: boolean;
}) {
  await ensurePlans(tx);
  let slug = slugify(i.name);
  const [clash] = await tx.select({ id: organisations.id }).from(organisations).where(eq(organisations.slug, slug));
  if (clash) slug += "-" + Math.random().toString(36).slice(2, 6);
  const [org] = await tx.insert(organisations).values({
    name: i.name, slug, type: i.type, regulatoryStatus: i.regulatoryStatus ?? (i.type === "sacco" ? "registered_cooperative" : "informal"), phone: i.phone, email: i.email, district: i.district,
    isDemo: !!i.isDemo, settings: { ...DEFAULT_SETTINGS, makerChecker: i.makerChecker ?? true },
  }).returning();
  await seedChartOfAccounts(tx, org.id);
  const [plan] = await tx.select().from(plans).where(eq(plans.code, i.planCode ?? "starter"));
  const today = todayEAT();
  await tx.insert(orgSubscriptions).values({ orgId: org.id, planId: plan.id, status: i.isDemo ? "active" : "trial", currentPeriodStart: today, currentPeriodEnd: i.isDemo ? addMonths(today, 12) : addDays(today, 30) });
  await tx.insert(subscriptionInvoices).values({ orgId: org.id, planId: plan.id, invoiceNo: `INV-${org.slug.slice(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`, amount: i.isDemo ? "0" : plan.monthlyPrice, periodStart: today, periodEnd: addDays(today, 30), status: i.isDemo ? "paid" : "open" });
  await tx.insert(paymentIntegrations).values([
    { orgId: org.id, provider: "cash", displayName: "Cash" }, { orgId: org.id, provider: "manual", displayName: "Manually verified" },
    { orgId: org.id, provider: "bank", displayName: "Bank transfer" }, { orgId: org.id, provider: "mtn_momo", displayName: "MTN Mobile Money Uganda" },
    { orgId: org.id, provider: "airtel_money", displayName: "Airtel Money Uganda" },
  ]).onConflictDoNothing();
  await tx.insert(savingsProducts).values([
    { orgId: org.id, name: "Ordinary Savings", category: "voluntary", planType: "flexible", frequency: "monthly", minContribution: "10000", interestRate: "3" },
    { orgId: org.id, name: "Mandatory Monthly Savings", category: "mandatory", planType: "flexible", frequency: "monthly", minContribution: "20000", interestRate: "0" },
  ]);
  await tx.insert(loanProducts).values({ orgId: org.id, name: "Standard Member Loan", interestRate: "24", interestMethod: "reducing", minAmount: "100000", maxAmount: "10000000", maxTermMonths: 12, savingsMultiple: "3" });
  return org;
}

export async function registerOrganisation(i: { orgName: string; type: string; adminName: string; email: string; phone?: string; password: string; district?: string }) {
  const prob = passwordProblem(i.password);
  if (prob) throw new AppError(prob);
  const email = i.email.toLowerCase().trim();
  const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
  if (exists) throw new AppError("An account with this email already exists");
  return db.transaction(async (tx) => {
    const org = await createOrganisation(tx, { name: i.orgName, type: i.type, phone: normalizeUgPhone(i.phone) ?? undefined, email, district: i.district, makerChecker: false });
    const [u] = await tx.insert(users).values({ email, fullName: i.adminName, phone: normalizeUgPhone(i.phone), passwordHash: await hashPassword(i.password) }).returning();
    await tx.insert(orgUsers).values({ orgId: org.id, userId: u.id, role: "super_admin" });
    await audit(tx, org.id, { userId: u.id, name: u.fullName }, "org.registered", "organisation", org.id, { name: org.name, type: org.type });
    return { org, user: u };
  });
}

export async function planLimits(orgId: string) {
  const [r] = await db.select({ plan: plans, org: organisations }).from(organisations)
    .innerJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organisations.id)).innerJoin(plans, eq(plans.id, orgSubscriptions.planId)).where(eq(organisations.id, orgId));
  if (!r) throw new AppError("Subscription not found", 500);
  return { maxMembers: r.org.limitOverrides.maxMembers ?? r.plan.maxMembers, maxUsers: r.org.limitOverrides.maxUsers ?? r.plan.maxUsers, features: r.plan.features, planName: r.plan.name };
}

export type MemberInput = {
  fullName: string; phone: string; gender?: string; dateOfBirth?: string; nationalId?: string; email?: string; address?: string; district?: string; occupation?: string;
  nokName?: string; nokPhone?: string; nokRelationship?: string; joinedAt?: string; isDemo?: boolean;
};
export async function createMember(svc: Svc, i: MemberInput, opts: { openDefaultAccount?: boolean; skipLimit?: boolean } = {}) {
  const phone = normalizeUgPhone(i.phone);
  if (!phone) throw new AppError("Enter a valid Uganda phone number (e.g. 0772 123 456)");
  if (!i.fullName.trim()) throw new AppError("Full name is required");
  const lim = await planLimits(svc.orgId);
  return db.transaction(async (tx) => {
    const [c] = await tx.select({ c: sql<number>`count(*)` }).from(members).where(eq(members.orgId, svc.orgId));
    if (!opts.skipLimit && Number(c.c) >= lim.maxMembers) throw new AppError(`Your ${lim.planName} plan allows ${lim.maxMembers} members. Upgrade to add more.`);
    const [dup] = await tx.select({ n: members.fullName }).from(members).where(and(eq(members.orgId, svc.orgId), eq(members.phone, phone)));
    if (dup) throw new AppError(`Phone number already registered to ${dup.n}`);
    if (i.nationalId) {
      const [d2] = await tx.select({ n: members.fullName }).from(members).where(and(eq(members.orgId, svc.orgId), eq(members.nationalId, i.nationalId)));
      if (d2) throw new AppError(`National ID already registered to ${d2.n}`);
    }
    const seq = await nextSeq(tx, svc.orgId, "member");
    const [m] = await tx.insert(members).values({
      orgId: svc.orgId, memberNo: `M${String(seq).padStart(5, "0")}`, fullName: i.fullName.trim(), gender: i.gender || null, dateOfBirth: i.dateOfBirth || null, nationalId: i.nationalId || null,
      phone, email: i.email || null, address: i.address || null, district: i.district || null, occupation: i.occupation || null,
      nokName: i.nokName || null, nokPhone: normalizeUgPhone(i.nokPhone) ?? (i.nokPhone || null), nokRelationship: i.nokRelationship || null, joinedAt: i.joinedAt || todayEAT(), isDemo: !!i.isDemo,
    }).returning();
    await tx.insert(notificationPrefs).values({ orgId: svc.orgId, memberId: m.id }).onConflictDoNothing();
    if (opts.openDefaultAccount !== false) {
      const [p] = await tx.select().from(savingsProducts).where(and(eq(savingsProducts.orgId, svc.orgId), eq(savingsProducts.active, true))).orderBy(savingsProducts.createdAt).limit(1);
      if (p) await openAccountTx(tx, svc.orgId, m, p.id);
    }
    await audit(tx, svc.orgId, svc.actor, "member.created", "member", m.id, { memberNo: m.memberNo, name: m.fullName });
    return m;
  });
}

export async function openAccountTx(tx: Tx, orgId: string, m: { id: string; memberNo: string }, productId: string) {
  const seq = await nextSeq(tx, orgId, `acct:${m.id}`);
  const [p] = await tx.select().from(savingsProducts).where(and(eq(savingsProducts.id, productId), eq(savingsProducts.orgId, orgId)));
  if (!p) throw new AppError("Savings product not found", 404);
  const today = todayEAT();
  const [a] = await tx.insert(savingsAccounts).values({
    orgId, memberId: m.id, productId, accountNo: `${m.memberNo}-${String(seq).padStart(2, "0")}`, openedAt: today,
    maturityDate: p.planType === "fixed" && p.lockMonths > 0 ? addMonths(today, p.lockMonths) : null,
  }).returning();
  return a;
}

export async function addOrgUser(svc: Svc, i: { fullName: string; email: string; role: Role; password: string; memberId?: string }) {
  const prob = passwordProblem(i.password);
  if (prob) throw new AppError(prob);
  const lim = await planLimits(svc.orgId);
  const email = i.email.toLowerCase().trim();
  return db.transaction(async (tx) => {
    const [c] = await tx.select({ c: sql<number>`count(*)` }).from(orgUsers).where(and(eq(orgUsers.orgId, svc.orgId), sql`${orgUsers.role} <> 'member'`));
    if (i.role !== "member" && Number(c.c) >= lim.maxUsers) throw new AppError(`Your ${lim.planName} plan allows ${lim.maxUsers} staff users.`);
    let [u] = await tx.select().from(users).where(sql`lower(${users.email}) = ${email}`);
    if (u) {
      const [link] = await tx.select().from(orgUsers).where(and(eq(orgUsers.userId, u.id), eq(orgUsers.orgId, svc.orgId)));
      if (link) throw new AppError("This user already belongs to the organisation");
    } else {
      [u] = await tx.insert(users).values({ email, fullName: i.fullName, passwordHash: await hashPassword(i.password) }).returning();
    }
    if (i.role === "member") {
      if (!i.memberId) throw new AppError("Select the member this login belongs to");
      const [mm] = await tx.select({ id: members.id }).from(members).where(and(eq(members.id, i.memberId), eq(members.orgId, svc.orgId)));
      if (!mm) throw new AppError("Member not found", 404);
    }
    await tx.insert(orgUsers).values({ orgId: svc.orgId, userId: u.id, role: i.role, memberId: i.role === "member" ? i.memberId : null });
    await audit(tx, svc.orgId, svc.actor, "user.added", "user", u.id, { email, role: i.role });
    return u;
  });
}
