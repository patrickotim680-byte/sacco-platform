/**
 * Softronics SACCO Platform - relational schema (PostgreSQL / Drizzle).
 * Money is always numeric(18,2). Every tenant table carries org_id.
 * Financial tables (journal_lines, journal_entries, audit_logs, transactions) are
 * protected by DB triggers (see src/db/setup-sql.ts) against edit/delete.
 */
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, numeric, integer, boolean, timestamp, date, jsonb,
  index, uniqueIndex, check, bigserial,
} from "drizzle-orm/pg-core";

const pk = () => uuid("id").defaultRandom().primaryKey();
const money = (n: string) => numeric(n, { precision: 18, scale: 2 }).notNull().default("0");
const ts = (n: string) => timestamp(n, { withTimezone: true }).notNull().defaultNow();

/* ------------------------------ SaaS / platform ------------------------------ */
export const plans = pgTable("plans", {
  id: pk(),
  code: text("code").notNull().unique(), // starter | growth | professional | enterprise
  name: text("name").notNull(),
  monthlyPrice: money("monthly_price"),
  annualPrice: money("annual_price"),
  maxMembers: integer("max_members").notNull(),
  maxUsers: integer("max_users").notNull(),
  features: jsonb("features").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const organisations = pgTable("organisations", {
  id: pk(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  type: text("type").notNull().default("sacco"), // sacco | vsla | investment_club | cooperative | community_group
  regulatoryStatus: text("regulatory_status").notNull().default("informal"), // informal | registered_cooperative | tier4_microfinance | umra_licensed
  registrationNo: text("registration_no"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  district: text("district"),
  currency: text("currency").notNull().default("UGX"),
  timezone: text("timezone").notNull().default("Africa/Kampala"),
  brandColor: text("brand_color").notNull().default("#0b6e4f"),
  financialYearStartMonth: integer("fy_start_month").notNull().default(1),
  status: text("status").notNull().default("active"), // active | suspended | deactivated
  isDemo: boolean("is_demo").notNull().default(false),
  /** financial policies & limits, validated by zod in lib/policies.ts */
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  limitOverrides: jsonb("limit_overrides").$type<{ maxMembers?: number; maxUsers?: number }>().notNull().default({}),
  createdAt: ts("created_at"),
});

export const orgSubscriptions = pgTable("org_subscriptions", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id).unique(),
  planId: uuid("plan_id").notNull().references(() => plans.id),
  billingCycle: text("billing_cycle").notNull().default("monthly"), // monthly | annual
  status: text("status").notNull().default("trial"), // trial | active | past_due | cancelled
  currentPeriodStart: date("current_period_start").notNull(),
  currentPeriodEnd: date("current_period_end").notNull(),
  createdAt: ts("created_at"),
});

export const subscriptionInvoices = pgTable("subscription_invoices", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  planId: uuid("plan_id").notNull().references(() => plans.id),
  invoiceNo: text("invoice_no").notNull().unique(),
  amount: money("amount"),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  status: text("status").notNull().default("open"), // open | paid | void
  createdAt: ts("created_at"),
}, (t) => [index("sub_inv_org").on(t.orgId)]);

export const supportTickets = pgTable("support_tickets", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  createdBy: uuid("created_by").notNull(),
  subject: text("subject").notNull(),
  priority: text("priority").notNull().default("normal"),
  status: text("status").notNull().default("open"), // open | in_progress | resolved
  createdAt: ts("created_at"),
}, (t) => [index("tickets_org").on(t.orgId)]);

export const ticketMessages = pgTable("ticket_messages", {
  id: pk(),
  ticketId: uuid("ticket_id").notNull().references(() => supportTickets.id),
  authorId: uuid("author_id").notNull(),
  fromPlatform: boolean("from_platform").notNull().default(false),
  body: text("body").notNull(),
  createdAt: ts("created_at"),
});

export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: ts("updated_at"),
});

/* ------------------------------ identity ------------------------------ */
export const users = pgTable("users", {
  id: pk(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull(),
  phone: text("phone"),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  status: text("status").notNull().default("active"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: ts("created_at"),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const orgUsers = pgTable("org_users", {
  id: pk(),
  orgId: uuid("org_id").notNull().references(() => organisations.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  // super_admin | chairperson | manager | treasurer | secretary | loan_officer | auditor | member
  role: text("role").notNull(),
  memberId: uuid("member_id"),
  status: text("status").notNull().default("active"),
  createdAt: ts("created_at"),
}, (t) => [uniqueIndex("org_users_uq").on(t.orgId, t.userId), index("org_users_user").on(t.userId)]);

export const sessions = pgTable("sessions", {
  id: pk(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  orgId: uuid("org_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  userAgent: text("user_agent"),
  createdAt: ts("created_at"),
});

export const passwordResets = pgTable("password_resets", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: ts("created_at"),
});

export const counters = pgTable("counters", {
  orgId: uuid("org_id").notNull(),
  key: text("key").notNull(),
  value: integer("value").notNull().default(0),
}, (t) => [uniqueIndex("counters_uq").on(t.orgId, t.key)]);

/* ------------------------------ members ------------------------------ */
const orgRef = () => uuid("org_id").notNull().references(() => organisations.id);

export const members = pgTable("members", {
  id: pk(),
  orgId: orgRef(),
  memberNo: text("member_no").notNull(),
  fullName: text("full_name").notNull(),
  gender: text("gender"),
  dateOfBirth: date("date_of_birth"),
  nationalId: text("national_id"),
  phone: text("phone").notNull(),
  email: text("email"),
  address: text("address"),
  district: text("district"),
  occupation: text("occupation"),
  nokName: text("nok_name"),
  nokPhone: text("nok_phone"),
  nokRelationship: text("nok_relationship"),
  photoPath: text("photo_path"),
  status: text("status").notNull().default("active"), // active | suspended | exited
  statusReason: text("status_reason"),
  joinedAt: date("joined_at").notNull(),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: ts("created_at"),
}, (t) => [
  uniqueIndex("members_no_uq").on(t.orgId, t.memberNo),
  index("members_org_status").on(t.orgId, t.status),
  index("members_org_name").on(t.orgId, t.fullName),
  index("members_phone").on(t.orgId, t.phone),
]);

export const memberDocuments = pgTable("member_documents", {
  id: pk(),
  orgId: orgRef(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  kind: text("kind").notNull(), // national_id | photo | passport | loan_form | other
  fileName: text("file_name").notNull(),
  storagePath: text("storage_path").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedBy: uuid("uploaded_by"),
  createdAt: ts("created_at"),
}, (t) => [index("docs_member").on(t.orgId, t.memberId)]);

/* ------------------------------ savings ------------------------------ */
export const savingsProducts = pgTable("savings_products", {
  id: pk(),
  orgId: orgRef(),
  name: text("name").notNull(),
  category: text("category").notNull().default("voluntary"), // mandatory | voluntary
  planType: text("plan_type").notNull().default("flexible"), // flexible | fixed
  frequency: text("frequency").notNull().default("monthly"), // daily | weekly | monthly | custom
  minContribution: money("min_contribution"),
  interestRate: numeric("interest_rate", { precision: 6, scale: 3 }).notNull().default("0"), // % p.a.
  lockMonths: integer("lock_months").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at"),
}, (t) => [index("sp_org").on(t.orgId)]);

export const savingsAccounts = pgTable("savings_accounts", {
  id: pk(),
  orgId: orgRef(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  productId: uuid("product_id").notNull().references(() => savingsProducts.id),
  accountNo: text("account_no").notNull(),
  /** derived cache: only mutable inside ledger transactions (DB trigger enforced) */
  balance: money("balance"),
  status: text("status").notNull().default("active"), // active | closed | frozen
  maturityDate: date("maturity_date"),
  openedAt: date("opened_at").notNull(),
  createdAt: ts("created_at"),
}, (t) => [
  uniqueIndex("sa_no_uq").on(t.orgId, t.accountNo),
  index("sa_member").on(t.orgId, t.memberId),
  check("sa_balance_nonneg", sql`${t.balance} >= 0`),
]);

export const contributionSchedules = pgTable("contribution_schedules", {
  id: pk(),
  orgId: orgRef(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  accountId: uuid("account_id").notNull().references(() => savingsAccounts.id),
  amount: money("amount"),
  frequency: text("frequency").notNull(), // daily | weekly | monthly | custom
  intervalDays: integer("interval_days"),
  nextDue: date("next_due").notNull(),
  active: boolean("active").notNull().default(true),
  lastAlertOn: date("last_alert_on"),
}, (t) => [index("cs_due").on(t.orgId, t.nextDue)]);

/** Every money movement. Immutable except status transition completed->reversed. */
export const transactions = pgTable("transactions", {
  id: pk(),
  orgId: orgRef(),
  reference: text("reference").notNull().unique(),
  // deposit | withdrawal | interest | loan_disbursement | loan_repayment | fee | income | expense | reversal | group_entry
  type: text("type").notNull(),
  memberId: uuid("member_id").references(() => members.id),
  accountId: uuid("account_id").references(() => savingsAccounts.id),
  loanId: uuid("loan_id"),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  channel: text("channel").notNull().default("cash"), // cash | bank | mtn_momo | airtel_money | manual
  status: text("status").notNull().default("completed"), // completed | reversed
  externalRef: text("external_ref"),
  description: text("description"),
  journalEntryId: uuid("journal_entry_id"),
  reversalOfId: uuid("reversal_of_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid("created_by"),
  txnDate: date("txn_date").notNull(),
  createdAt: ts("created_at"),
}, (t) => [
  index("txn_org_date").on(t.orgId, t.txnDate),
  index("txn_member").on(t.orgId, t.memberId),
  index("txn_account").on(t.accountId),
  index("txn_loan").on(t.loanId),
  uniqueIndex("txn_ext_uq").on(t.orgId, t.channel, t.externalRef).where(sql`${t.externalRef} is not null and ${t.type} <> 'reversal'`),
  check("txn_amount_pos", sql`${t.amount} > 0`),
]);

export const withdrawalRequests = pgTable("withdrawal_requests", {
  id: pk(),
  orgId: orgRef(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  accountId: uuid("account_id").notNull().references(() => savingsAccounts.id),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  channel: text("channel").notNull().default("cash"),
  reason: text("reason"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected | cancelled
  requestedBy: uuid("requested_by").notNull(),
  reviewedBy: uuid("reviewed_by"),
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  transactionId: uuid("transaction_id"),
  createdAt: ts("created_at"),
}, (t) => [index("wr_org_status").on(t.orgId, t.status), check("wr_amount_pos", sql`${t.amount} > 0`)]);

export const fraudFlags = pgTable("fraud_flags", {
  id: pk(),
  orgId: orgRef(),
  transactionId: uuid("transaction_id"),
  kind: text("kind").notNull(), // large_amount | duplicate_override | rapid_withdrawals | self_approval_blocked | limit_exceeded
  severity: text("severity").notNull().default("medium"),
  detail: text("detail").notNull(),
  status: text("status").notNull().default("open"), // open | reviewed | dismissed
  reviewedBy: uuid("reviewed_by"),
  createdAt: ts("created_at"),
}, (t) => [index("ff_org").on(t.orgId, t.status)]);

/* ------------------------------ loans ------------------------------ */
export const loanProducts = pgTable("loan_products", {
  id: pk(),
  orgId: orgRef(),
  name: text("name").notNull(),
  interestRate: numeric("interest_rate", { precision: 6, scale: 3 }).notNull(), // % per annum
  interestMethod: text("interest_method").notNull().default("reducing"), // flat | reducing
  frequency: text("frequency").notNull().default("monthly"), // weekly | monthly
  minAmount: money("min_amount"),
  maxAmount: money("max_amount"),
  minTermMonths: integer("min_term_months").notNull().default(1),
  maxTermMonths: integer("max_term_months").notNull().default(12),
  savingsMultiple: numeric("savings_multiple", { precision: 5, scale: 2 }).notNull().default("3"),
  minMembershipMonths: integer("min_membership_months").notNull().default(3),
  guarantorsRequired: integer("guarantors_required").notNull().default(1),
  processingFeePct: numeric("processing_fee_pct", { precision: 5, scale: 2 }).notNull().default("1"),
  penaltyRatePct: numeric("penalty_rate_pct", { precision: 5, scale: 2 }).notNull().default("5"), // % of overdue amount per 30 days
  graceDays: integer("grace_days").notNull().default(3),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at"),
}, (t) => [index("lp_org").on(t.orgId)]);

export const loanApplications = pgTable("loan_applications", {
  id: pk(),
  orgId: orgRef(),
  applicationNo: text("application_no").notNull(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  productId: uuid("product_id").notNull().references(() => loanProducts.id),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  termMonths: integer("term_months").notNull(),
  purpose: text("purpose"),
  // pending | under_review | approved | rejected | disbursed | withdrawn
  status: text("status").notNull().default("pending"),
  eligibility: jsonb("eligibility").$type<Record<string, unknown>>().notNull().default({}),
  reviewedBy: uuid("reviewed_by"),
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  appliedBy: uuid("applied_by"),
  loanId: uuid("loan_id"),
  createdAt: ts("created_at"),
}, (t) => [
  uniqueIndex("la_no_uq").on(t.orgId, t.applicationNo),
  index("la_org_status").on(t.orgId, t.status),
  index("la_member").on(t.orgId, t.memberId),
  check("la_amount_pos", sql`${t.amount} > 0`),
]);

export const loans = pgTable("loans", {
  id: pk(),
  orgId: orgRef(),
  loanNo: text("loan_no").notNull(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  productId: uuid("product_id").notNull().references(() => loanProducts.id),
  applicationId: uuid("application_id"),
  principal: numeric("principal", { precision: 18, scale: 2 }).notNull(),
  interestRate: numeric("interest_rate", { precision: 6, scale: 3 }).notNull(),
  interestMethod: text("interest_method").notNull(),
  frequency: text("frequency").notNull(),
  termMonths: integer("term_months").notNull(),
  penaltyRatePct: numeric("penalty_rate_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  graceDays: integer("grace_days").notNull().default(0),
  disbursedAt: date("disbursed_at").notNull(),
  channel: text("channel").notNull().default("cash"),
  status: text("status").notNull().default("active"), // active | closed | restructured | written_off
  principalPaid: money("principal_paid"),
  interestPaid: money("interest_paid"),
  penaltyPaid: money("penalty_paid"),
  restructuredFromId: uuid("restructured_from_id"),
  disbursedBy: uuid("disbursed_by"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: ts("created_at"),
}, (t) => [
  uniqueIndex("loans_no_uq").on(t.orgId, t.loanNo),
  index("loans_org_status").on(t.orgId, t.status),
  index("loans_member").on(t.orgId, t.memberId),
]);

export const loanSchedule = pgTable("loan_schedule", {
  id: pk(),
  orgId: orgRef(),
  loanId: uuid("loan_id").notNull().references(() => loans.id),
  installmentNo: integer("installment_no").notNull(),
  dueDate: date("due_date").notNull(),
  principalDue: money("principal_due"),
  interestDue: money("interest_due"),
  principalPaid: money("principal_paid"),
  interestPaid: money("interest_paid"),
  penaltyAccrued: money("penalty_accrued"),
  penaltyPaid: money("penalty_paid"),
  penaltyPeriods: integer("penalty_periods").notNull().default(0),
  status: text("status").notNull().default("pending"), // pending | partial | paid | superseded
}, (t) => [
  uniqueIndex("ls_uq").on(t.loanId, t.installmentNo),
  index("ls_due").on(t.orgId, t.dueDate, t.status),
]);

export const loanGuarantors = pgTable("loan_guarantors", {
  id: pk(),
  orgId: orgRef(),
  applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
  guarantorMemberId: uuid("guarantor_member_id").notNull().references(() => members.id),
  amountGuaranteed: numeric("amount_guaranteed", { precision: 18, scale: 2 }).notNull(),
  status: text("status").notNull().default("pending"), // pending | accepted | declined
  createdAt: ts("created_at"),
}, (t) => [index("lg_app").on(t.applicationId)]);

export const loanCollaterals = pgTable("loan_collaterals", {
  id: pk(),
  orgId: orgRef(),
  applicationId: uuid("application_id").notNull().references(() => loanApplications.id),
  description: text("description").notNull(),
  estimatedValue: money("estimated_value"),
  documentRef: text("document_ref"),
  createdAt: ts("created_at"),
}, (t) => [index("lc_app").on(t.applicationId)]);

export const loanRepayments = pgTable("loan_repayments", {
  id: pk(),
  orgId: orgRef(),
  loanId: uuid("loan_id").notNull().references(() => loans.id),
  transactionId: uuid("transaction_id").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  principal: money("principal"),
  interest: money("interest"),
  penalty: money("penalty"),
  allocation: jsonb("allocation").$type<{ scheduleId: string; principal: number; interest: number; penalty: number }[]>().notNull().default([]),
  kind: text("kind").notNull().default("regular"), // regular | early_settlement
  reversed: boolean("reversed").notNull().default(false),
  paidAt: date("paid_at").notNull(),
}, (t) => [index("lr_loan").on(t.loanId)]);

/* ------------------------------ groups / VSLA ------------------------------ */
export const groups = pgTable("groups", {
  id: pk(),
  orgId: orgRef(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("vsla"), // vsla | rotating | investment_club | other
  registrationNo: text("registration_no"),
  location: text("location"),
  constitution: text("constitution"),
  rules: jsonb("rules").$type<{ sharePrice: number; maxSharesPerMeeting: number; loanInterestPct: number; socialFundContribution: number; lateFine: number; absentFine: number; loanMultipleOfSavings: number }>().notNull(),
  status: text("status").notNull().default("active"),
  createdAt: ts("created_at"),
}, (t) => [index("groups_org").on(t.orgId)]);

export const groupMembers = pgTable("group_members", {
  id: pk(),
  orgId: orgRef(),
  groupId: uuid("group_id").notNull().references(() => groups.id),
  memberId: uuid("member_id").notNull().references(() => members.id),
  role: text("role").notNull().default("member"), // chairperson | secretary | treasurer | member
  joinedAt: date("joined_at").notNull(),
}, (t) => [uniqueIndex("gm_uq").on(t.groupId, t.memberId)]);

export const groupCycles = pgTable("group_cycles", {
  id: pk(),
  orgId: orgRef(),
  groupId: uuid("group_id").notNull().references(() => groups.id),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  status: text("status").notNull().default("open"), // open | closed
  savingsTarget: money("savings_target"),
  shareOut: jsonb("share_out").$type<unknown>(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [index("gc_group").on(t.groupId)]);

export const groupMeetings = pgTable("group_meetings", {
  id: pk(),
  orgId: orgRef(),
  groupId: uuid("group_id").notNull().references(() => groups.id),
  cycleId: uuid("cycle_id"),
  meetingDate: date("meeting_date").notNull(),
  venue: text("venue"),
  agenda: text("agenda"),
  minutes: text("minutes"),
  status: text("status").notNull().default("scheduled"), // scheduled | held | cancelled
}, (t) => [index("gmeet_group").on(t.groupId, t.meetingDate)]);

export const meetingAttendance = pgTable("meeting_attendance", {
  id: pk(),
  orgId: orgRef(),
  meetingId: uuid("meeting_id").notNull().references(() => groupMeetings.id),
  memberId: uuid("member_id").notNull().references(() => members.id),
  status: text("status").notNull(), // present | absent | apology | late
}, (t) => [uniqueIndex("ma_uq").on(t.meetingId, t.memberId)]);

/** share purchases, social/emergency fund, fines, loans, repayments, rotating payouts */
export const groupEntries = pgTable("group_entries", {
  id: pk(),
  orgId: orgRef(),
  groupId: uuid("group_id").notNull().references(() => groups.id),
  cycleId: uuid("cycle_id"),
  memberId: uuid("member_id").references(() => members.id),
  meetingId: uuid("meeting_id"),
  // share | social_fund | emergency_fund | fine | loan_out | loan_repayment | rotating_payout | fund_payout
  kind: text("kind").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  shares: integer("shares").notNull().default(0),
  interestPortion: money("interest_portion"),
  loanId: uuid("loan_id"),
  note: text("note"),
  reference: text("reference").notNull().unique(),
  entryDate: date("entry_date").notNull(),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at"),
}, (t) => [index("ge_group").on(t.groupId, t.cycleId, t.kind), check("ge_amount_pos", sql`${t.amount} > 0`)]);

export const groupLoans = pgTable("group_loans", {
  id: pk(),
  orgId: orgRef(),
  groupId: uuid("group_id").notNull().references(() => groups.id),
  cycleId: uuid("cycle_id"),
  memberId: uuid("member_id").notNull().references(() => members.id),
  principal: numeric("principal", { precision: 18, scale: 2 }).notNull(),
  interestDue: money("interest_due"),
  repaid: money("repaid"),
  dueDate: date("due_date").notNull(),
  status: text("status").notNull().default("active"), // active | repaid
  createdAt: ts("created_at"),
}, (t) => [index("gl_group").on(t.groupId)]);

export const groupResolutions = pgTable("group_resolutions", {
  id: pk(),
  orgId: orgRef(),
  groupId: uuid("group_id").notNull().references(() => groups.id),
  meetingId: uuid("meeting_id"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  resolvedOn: date("resolved_on").notNull(),
}, (t) => [index("gr_group").on(t.groupId)]);

/* ------------------------------ accounting ------------------------------ */
export const glAccounts = pgTable("gl_accounts", {
  id: pk(),
  orgId: orgRef(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(), // asset | liability | equity | income | expense
  isCash: boolean("is_cash").notNull().default(false),
  isSystem: boolean("is_system").notNull().default(false),
  active: boolean("active").notNull().default(true),
}, (t) => [uniqueIndex("gl_code_uq").on(t.orgId, t.code)]);

export const journalEntries = pgTable("journal_entries", {
  id: pk(),
  orgId: orgRef(),
  entryNo: text("entry_no").notNull(),
  entryDate: date("entry_date").notNull(),
  description: text("description").notNull(),
  source: text("source").notNull().default("system"), // system | manual | adjustment | reversal
  sourceType: text("source_type"),
  sourceId: uuid("source_id"),
  reversalOfId: uuid("reversal_of_id"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at"),
}, (t) => [uniqueIndex("je_no_uq").on(t.orgId, t.entryNo), index("je_org_date").on(t.orgId, t.entryDate)]);

export const journalLines = pgTable("journal_lines", {
  id: pk(),
  orgId: orgRef(),
  entryId: uuid("entry_id").notNull().references(() => journalEntries.id),
  accountId: uuid("account_id").notNull().references(() => glAccounts.id),
  debit: money("debit"),
  credit: money("credit"),
  memo: text("memo"),
}, (t) => [
  index("jl_entry").on(t.entryId),
  index("jl_account").on(t.orgId, t.accountId),
  check("jl_nonneg", sql`${t.debit} >= 0 and ${t.credit} >= 0`),
  check("jl_one_side", sql`(${t.debit} = 0) <> (${t.credit} = 0)`),
]);

export const payablesReceivables = pgTable("payables_receivables", {
  id: pk(),
  orgId: orgRef(),
  kind: text("kind").notNull(), // payable | receivable
  party: text("party").notNull(),
  description: text("description"),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  settled: money("settled"),
  dueDate: date("due_date").notNull(),
  status: text("status").notNull().default("open"), // open | settled
  createdAt: ts("created_at"),
}, (t) => [index("pr_org").on(t.orgId, t.kind, t.status)]);

/* ------------------------------ notifications ------------------------------ */
export const notifications = pgTable("notifications", {
  id: pk(),
  orgId: orgRef(),
  memberId: uuid("member_id"),
  userId: uuid("user_id"),
  kind: text("kind").notNull(), // contribution_reminder | missed_payment | loan_reminder | loan_decision | withdrawal_update | meeting_reminder | announcement | membership
  channel: text("channel").notNull().default("in_app"), // in_app | sms | email | whatsapp
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** queued | delivered | failed | simulated (NOT delivered - provider not configured) | read */
  status: text("status").notNull().default("queued"),
  provider: text("provider"),
  providerRef: text("provider_ref"),
  error: text("error"),
  readAt: timestamp("read_at", { withTimezone: true }),
  dedupeKey: text("dedupe_key"),
  createdAt: ts("created_at"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  index("notif_org").on(t.orgId, t.createdAt),
  index("notif_member").on(t.orgId, t.memberId),
  uniqueIndex("notif_dedupe").on(t.orgId, t.dedupeKey, t.channel).where(sql`${t.dedupeKey} is not null`),
]);

export const notificationPrefs = pgTable("notification_prefs", {
  id: pk(),
  orgId: orgRef(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  sms: boolean("sms").notNull().default(true),
  email: boolean("email").notNull().default(false),
  whatsapp: boolean("whatsapp").notNull().default(false),
}, (t) => [uniqueIndex("np_uq").on(t.orgId, t.memberId)]);

export const announcements = pgTable("announcements", {
  id: pk(),
  orgId: orgRef(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at"),
}, (t) => [index("ann_org").on(t.orgId, t.createdAt)]);

/* ------------------------------ payments ------------------------------ */
export const paymentIntegrations = pgTable("payment_integrations", {
  id: pk(),
  orgId: orgRef(),
  provider: text("provider").notNull(), // mtn_momo | airtel_money | bank | cash | manual
  displayName: text("display_name").notNull(),
  mode: text("mode").notNull().default("manual_only"), // manual_only | sandbox | production
  enabled: boolean("enabled").notNull().default(true),
  accountNumber: text("account_number"), // merchant/collection number (not a secret)
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestResult: text("last_test_result"),
}, (t) => [uniqueIndex("pi_uq").on(t.orgId, t.provider)]);

export const paymentRequests = pgTable("payment_requests", {
  id: pk(),
  orgId: orgRef(),
  reference: text("reference").notNull().unique(),
  provider: text("provider").notNull(),
  direction: text("direction").notNull().default("collection"), // collection | disbursement
  purpose: text("purpose").notNull().default("deposit"), // deposit | loan_repayment | loan_disbursement | withdrawal
  memberId: uuid("member_id").references(() => members.id),
  accountId: uuid("account_id"),
  loanId: uuid("loan_id"),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  msisdn: text("msisdn"),
  /** awaiting_confirmation | pending_provider | confirmed | failed | cancelled */
  status: text("status").notNull().default("awaiting_confirmation"),
  providerRef: text("provider_ref"),
  providerStatusRaw: text("provider_status_raw"),
  transactionId: uuid("transaction_id"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at"),
}, (t) => [index("pr2_org").on(t.orgId, t.status), check("pr2_amount_pos", sql`${t.amount} > 0`)]);

/* ------------------------------ audit ------------------------------ */
export const auditLogs = pgTable("audit_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  orgId: uuid("org_id"),
  userId: uuid("user_id"),
  userName: text("user_name"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  prevHash: text("prev_hash"),
  hash: text("hash").notNull(),
  createdAt: ts("created_at"),
}, (t) => [index("audit_org").on(t.orgId, t.id)]);
