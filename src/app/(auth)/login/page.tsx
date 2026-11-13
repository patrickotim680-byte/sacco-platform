import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organisations } from "@/db/schema";
import { getCtx } from "@/lib/auth";
import { LoginForm } from "@/components/login-form";
import { DEMO_LOGINS, DEMO_PASSWORD, DEMO_SLUG } from "@/db/seed";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await getCtx();
  if (ctx) redirect(ctx.role === "member" ? "/portal" : ctx.orgId ? "/dashboard" : ctx.user.isPlatformAdmin ? "/admin" : "/login");
  const sp = await searchParams;
  const [demo] = await db.select({ id: organisations.id }).from(organisations).where(eq(organisations.slug, DEMO_SLUG));
  const showDemo = !!demo && process.env.SHOW_DEMO_LOGINS !== "false";
  return (
    <div className="card card-pad">
      <h2 className="text-xl font-semibold">Sign in</h2>
      <p className="text-sm text-muted mb-4">Access your organisation workspace.</p>
      {sp.error === "no-org" && <p className="text-sm text-danger mb-3">Your account is not linked to an active organisation.</p>}
      <LoginForm demos={showDemo ? DEMO_LOGINS : []} password={DEMO_PASSWORD} />
      <div className="flex justify-between text-sm mt-5">
        <Link href="/forgot-password" className="text-brand font-medium">Forgot password?</Link>
        <Link href="/register" className="text-brand font-medium">Register an organisation</Link>
      </div>
    </div>
  );
}
