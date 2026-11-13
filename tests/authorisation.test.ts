import { describe, expect, it } from "vitest";
import { can, ROLES, ROLE_PERMS, type Perm } from "@/lib/permissions";

describe("role-based access control", () => {
  it("members can only use the self-service portal", () => expect(ROLE_PERMS.member).toEqual(["portal.use"]));
  it("auditors are strictly read-only", () => {
    const write = ["members.manage", "savings.deposit", "savings.withdraw.approve", "loans.approve", "loans.disburse", "loans.repay", "accounting.post", "accounting.reverse", "payments.manage", "settings.manage", "users.manage", "notifications.send"] as Perm[];
    for (const p of write) expect(can("auditor", p)).toBe(false);
    expect(can("auditor", "audit.view")).toBe(true);
  });
  it("loan approval is restricted to chairperson and super admin", () => {
    expect(ROLES.filter((r) => can(r, "loans.approve")).sort()).toEqual(["chairperson", "super_admin"]);
  });
  it("loan officers cannot disburse, approve or post to the ledger", () => {
    for (const p of ["loans.approve", "loans.disburse", "accounting.post", "accounting.reverse", "savings.withdraw.approve", "users.manage"] as Perm[]) expect(can("loan_officer", p)).toBe(false);
  });
  it("only the owner can manage users", () => expect(ROLES.filter((r) => can(r, "users.manage"))).toEqual(["super_admin"]));
  it("treasurer controls cash but cannot approve loans", () => {
    expect(can("treasurer", "loans.disburse")).toBe(true);
    expect(can("treasurer", "loans.approve")).toBe(false);
    expect(can("treasurer", "accounting.post")).toBe(true);
  });
  it("unknown or missing roles have no permissions", () => { expect(can(null, "members.view")).toBe(false); expect(can(undefined, "members.view")).toBe(false); });
});
