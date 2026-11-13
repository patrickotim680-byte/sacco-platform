export const ROLES = ["super_admin", "chairperson", "manager", "treasurer", "secretary", "loan_officer", "auditor", "member"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin (Owner)", chairperson: "Chairperson", manager: "Manager", treasurer: "Treasurer",
  secretary: "Secretary", loan_officer: "Loan Officer", auditor: "Auditor", member: "Member",
};

export type Perm =
  | "members.view" | "members.manage" | "members.status" | "members.import"
  | "savings.view" | "savings.deposit" | "savings.withdraw.request" | "savings.withdraw.approve" | "savings.products" | "savings.interest"
  | "loans.view" | "loans.apply" | "loans.review" | "loans.approve" | "loans.disburse" | "loans.repay" | "loans.restructure" | "loans.products"
  | "groups.view" | "groups.manage"
  | "accounting.view" | "accounting.post" | "accounting.reverse"
  | "payments.view" | "payments.manage"
  | "notifications.send" | "reports.view" | "audit.view"
  | "settings.manage" | "users.manage" | "portal.use";

const VIEW: Perm[] = ["members.view", "savings.view", "loans.view", "groups.view", "accounting.view", "payments.view", "reports.view"];

export const ROLE_PERMS: Record<Role, Perm[]> = {
  super_admin: [
    ...VIEW, "members.manage", "members.status", "members.import", "savings.deposit", "savings.withdraw.request", "savings.withdraw.approve",
    "savings.products", "savings.interest", "loans.apply", "loans.review", "loans.approve", "loans.disburse", "loans.repay", "loans.restructure",
    "loans.products", "groups.manage", "accounting.post", "accounting.reverse", "payments.manage", "notifications.send", "audit.view",
    "settings.manage", "users.manage",
  ],
  chairperson: [
    ...VIEW, "members.status", "savings.withdraw.approve", "loans.review", "loans.approve", "loans.restructure", "groups.manage",
    "notifications.send", "audit.view", "accounting.reverse",
  ],
  manager: [
    ...VIEW, "members.manage", "members.status", "members.import", "savings.deposit", "savings.withdraw.request", "savings.withdraw.approve",
    "savings.products", "savings.interest", "loans.apply", "loans.review", "loans.disburse", "loans.repay", "loans.restructure", "loans.products",
    "groups.manage", "notifications.send", "payments.manage", "settings.manage", "audit.view",
  ],
  treasurer: [
    "members.view", "savings.view", "loans.view", "groups.view", "accounting.view", "payments.view", "reports.view",
    "savings.deposit", "savings.withdraw.approve", "savings.interest", "loans.disburse", "loans.repay", "accounting.post", "accounting.reverse", "payments.manage",
  ],
  secretary: [
    "members.view", "savings.view", "loans.view", "groups.view", "reports.view", "members.manage", "members.import", "groups.manage", "notifications.send",
  ],
  loan_officer: [
    "members.view", "savings.view", "loans.view", "reports.view", "groups.view", "loans.apply", "loans.review", "loans.repay", "loans.restructure",
    "savings.deposit", "savings.withdraw.request",
  ],
  auditor: [...VIEW, "audit.view"],
  member: ["portal.use"],
};

export function can(role: Role | null | undefined, perm: Perm) {
  return !!role && ROLE_PERMS[role].includes(perm);
}
