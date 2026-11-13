"use server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { loans, members, notificationPrefs, savingsAccounts, contributionSchedules } from "@/db/schema";
import type { FormState } from "@/components/forms";
import { act, S, O, I, B, oneOf, isoDate } from "@/lib/action-helpers";
import { AppError, audit } from "@/lib/core";
import { normalizeUgPhone } from "@/lib/format";
import { parseCsv } from "@/lib/csv";
import { addOrgUser, createMember, openAccountTx, type MemberInput } from "@/lib/services/org";
import { ROLES } from "@/lib/permissions";

const readMember = (fd: FormData): MemberInput => ({
  fullName: S(fd, "fullName"), phone: S(fd, "phone"), gender: O(fd, "gender"), dateOfBirth: isoDate(O(fd, "dateOfBirth"), "Date of birth"), nationalId: O(fd, "nationalId"),
  email: O(fd, "email"), address: O(fd, "address"), district: O(fd, "district"), occupation: O(fd, "occupation"),
  nokName: O(fd, "nokName"), nokPhone: O(fd, "nokPhone"), nokRelationship: O(fd, "nokRelationship"), joinedAt: isoDate(O(fd, "joinedAt"), "Joining date"),
});

export async function createMemberAction(_p: FormState, fd: FormData) {
  return act("members.manage", async (_c, svc) => {
    const m = await createMember(svc, readMember(fd));
    return { message: `Member ${m.memberNo} registered`, redirect: `/members/${m.id}` };
  });
}

export async function updateMemberAction(_p: FormState, fd: FormData) {
  return act("members.manage", async (ctx, svc) => {
    const id = S(fd, "id"), i = readMember(fd);
    const phone = normalizeUgPhone(i.phone);
    if (!phone) throw new AppError("Enter a valid Uganda phone number");
    await db.transaction(async (tx) => {
      const [dup] = await tx.select({ n: members.fullName }).from(members).where(and(eq(members.orgId, ctx.orgId), eq(members.phone, phone), sql`${members.id} <> ${id}`));
      if (dup) throw new AppError(`Phone number already registered to ${dup.n}`);
      const r = await tx.update(members).set({
        fullName: i.fullName, phone, gender: i.gender ?? null, dateOfBirth: i.dateOfBirth ?? null, nationalId: i.nationalId ?? null, email: i.email ?? null, address: i.address ?? null,
        district: i.district ?? null, occupation: i.occupation ?? null, nokName: i.nokName ?? null, nokPhone: normalizeUgPhone(i.nokPhone) ?? i.nokPhone ?? null, nokRelationship: i.nokRelationship ?? null,
      }).where(and(eq(members.id, id), eq(members.orgId, ctx.orgId))).returning({ id: members.id });
      if (!r[0]) throw new AppError("Member not found", 404);
      await audit(tx, ctx.orgId, svc.actor, "member.updated", "member", id, { name: i.fullName });
    });
    return "Member details updated";
  });
}

export async function memberStatusAction(_p: FormState, fd: FormData) {
  return act("members.status", async (ctx, svc) => {
    const id = S(fd, "id"), status = oneOf(S(fd, "status"), ["active", "suspended", "exited"] as const, "status"), reason = S(fd, "reason");
    if (reason.length < 5) throw new AppError("A reason is required");
    await db.transaction(async (tx) => {
      if (status === "exited") {
        const [l] = await tx.select({ c: sql<number>`count(*)` }).from(loans).where(and(eq(loans.memberId, id), eq(loans.status, "active")));
        const [s] = await tx.select({ b: sql<string>`coalesce(sum(${savingsAccounts.balance}),0)` }).from(savingsAccounts).where(eq(savingsAccounts.memberId, id));
        if (Number(l.c) > 0) throw new AppError("Member has active loans and cannot exit");
        if (Number(s.b) > 0) throw new AppError("Member still holds savings. Withdraw all balances before exit.");
      }
      const r = await tx.update(members).set({ status, statusReason: reason }).where(and(eq(members.id, id), eq(members.orgId, ctx.orgId))).returning({ id: members.id });
      if (!r[0]) throw new AppError("Member not found", 404);
      if (status !== "active") await tx.update(contributionSchedules).set({ active: false }).where(and(eq(contributionSchedules.memberId, id)));
      else await tx.update(contributionSchedules).set({ active: true }).where(eq(contributionSchedules.memberId, id));
      await audit(tx, ctx.orgId, svc.actor, `member.${status}`, "member", id, { reason });
    });
    return `Member status set to ${status}`;
  });
}

export async function importMembersAction(_p: FormState, fd: FormData) {
  return act("members.import", async (_c, svc) => {
    const file = fd.get("file");
    let text = S(fd, "csv");
    if (file instanceof File && file.size > 0) {
      if (file.size > 2_000_000) throw new AppError("File too large (max 2 MB)");
      text = await file.text();
    }
    const rows = parseCsv(text);
    if (rows.length < 2) throw new AppError("Provide a CSV with a header row and at least one member");
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    const col = (r: string[], ...names: string[]) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0 && r[i]?.trim()) return r[i].trim(); } return undefined; };
    if (!head.includes("full_name") && !head.includes("name")) throw new AppError("CSV must have a full_name column (and phone)");
    if (rows.length > 1001) throw new AppError("Import at most 1,000 members at a time");
    let ok = 0; const errors: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      try {
        await createMember(svc, {
          fullName: col(r, "full_name", "name") ?? "", phone: col(r, "phone", "mobile", "telephone") ?? "", gender: col(r, "gender")?.toLowerCase(), nationalId: col(r, "national_id", "nin"),
          email: col(r, "email"), district: col(r, "district"), address: col(r, "address"), occupation: col(r, "occupation"), nokName: col(r, "nok_name", "next_of_kin"), nokPhone: col(r, "nok_phone"),
          nokRelationship: col(r, "nok_relationship"), dateOfBirth: col(r, "date_of_birth", "dob"), joinedAt: col(r, "joined_at", "join_date"),
        });
        ok++;
      } catch (e) { errors.push(`Row ${i + 1}: ${(e as Error).message}`); }
    }
    if (!ok && errors.length) throw new AppError(`No members imported. ${errors.slice(0, 3).join(" | ")}`);
    return `Imported ${ok} member(s)${errors.length ? `; ${errors.length} skipped. ${errors.slice(0, 3).join(" | ")}` : ""}`;
  });
}

export async function openAccountAction(_p: FormState, fd: FormData) {
  return act("members.manage", async (ctx, svc) => {
    const id = S(fd, "memberId");
    const [m] = await db.select().from(members).where(and(eq(members.id, id), eq(members.orgId, ctx.orgId)));
    if (!m) throw new AppError("Member not found", 404);
    await db.transaction(async (tx) => {
      const a = await openAccountTx(tx, ctx.orgId, m, S(fd, "productId"));
      await audit(tx, ctx.orgId, svc.actor, "savings.account_opened", "savings_account", a.id, { accountNo: a.accountNo });
    });
    return "Savings account opened";
  });
}

export async function createPortalLoginAction(_p: FormState, fd: FormData) {
  return act("users.manage", async (_c, svc) => {
    await addOrgUser(svc, { fullName: S(fd, "fullName"), email: S(fd, "email"), role: "member", password: String(fd.get("password")), memberId: S(fd, "memberId") });
    return "Member portal login created. Share the temporary password securely.";
  });
}

export async function addStaffAction(_p: FormState, fd: FormData) {
  return act("users.manage", async (_c, svc) => {
    const role = oneOf(S(fd, "role"), ROLES, "role");
    if (role === "member") throw new AppError("Create member logins from the member profile");
    await addOrgUser(svc, { fullName: S(fd, "fullName"), email: S(fd, "email"), role, password: String(fd.get("password")) });
    return "User added";
  });
}

export async function memberPrefsAction(_p: FormState, fd: FormData) {
  return act("members.manage", async (ctx, svc) => {
    const memberId = S(fd, "memberId");
    await db.transaction(async (tx) => {
      await tx.insert(notificationPrefs).values({ orgId: ctx.orgId, memberId, sms: B(fd, "sms"), email: B(fd, "email"), whatsapp: B(fd, "whatsapp") })
        .onConflictDoUpdate({ target: [notificationPrefs.orgId, notificationPrefs.memberId], set: { sms: B(fd, "sms"), email: B(fd, "email"), whatsapp: B(fd, "whatsapp") } });
      await audit(tx, ctx.orgId, svc.actor, "member.notification_prefs", "member", memberId, {});
    });
    return "Notification preferences saved";
  });
}
void I;
