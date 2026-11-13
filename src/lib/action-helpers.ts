import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireAction, actorOf, type OrgCtx } from "@/lib/auth";
import { AppError } from "@/lib/core";
import type { Perm } from "@/lib/permissions";
import { friendly, type Svc } from "@/lib/services/savings";

export type Out = string | { message?: string; redirect?: string } | void;

export const svcOf = (ctx: OrgCtx): Svc => ({ orgId: ctx.orgId, org: ctx.org, actor: actorOf(ctx) });

export function fail(e: unknown): FormState {
  const f = friendly(e);
  if (f instanceof AppError) return { error: f.message, n: Date.now() };
  console.error("[action]", e);
  return { error: "Something went wrong. Please try again; if it persists contact support.", n: Date.now() };
}
const done = (out: Out): FormState => {
  revalidatePath("/", "layout");
  if (typeof out === "string") return { ok: true, message: out, n: Date.now() };
  return { ok: true, message: out?.message ?? "Saved", redirect: out?.redirect, n: Date.now() };
};

/** Runs an org-scoped action: authenticates, authorises, executes, maps errors. */
export async function act(perm: Perm, fn: (ctx: OrgCtx, svc: Svc) => Promise<Out>): Promise<FormState> {
  try {
    const ctx = await requireAction(perm);
    return done(await fn(ctx, svcOf(ctx)));
  } catch (e) { return fail(e); }
}
/** For unauthenticated flows (login, register, reset). */
export async function pub(fn: () => Promise<Out>): Promise<FormState> {
  try { return done(await fn()); } catch (e) { return fail(e); }
}

export const S = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
export const O = (fd: FormData, k: string) => S(fd, k) || undefined;
export const B = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
export function I(fd: FormData, k: string, label = k) {
  const raw = S(fd, k).replace(/[,\s]/g, "");
  if (raw === "") throw new AppError(`${label} is required`);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new AppError(`${label} must be a number`);
  return n;
}
export function OI(fd: FormData, k: string) {
  const raw = S(fd, k).replace(/[,\s]/g, "");
  return raw === "" ? undefined : Number(raw);
}
export function oneOf<T extends string>(v: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(v)) throw new AppError(`Invalid ${label}`);
  return v as T;
}
export function isoDate(v: string | undefined, label = "Date") {
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AppError(`${label} is invalid`);
  return v;
}
