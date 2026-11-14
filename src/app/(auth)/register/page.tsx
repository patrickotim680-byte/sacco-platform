import Link from "next/link";
import { ActionForm, Field, Grid, Select } from "@/components/forms";
import { registerAction } from "@/app/actions/auth";

export const metadata = { title: "Register your organisation" };

export default function RegisterPage() {
  return (
    <div className="card card-pad">
      <h2 className="text-xl font-semibold">Create your SokoSave account</h2>
      <p className="text-sm text-muted mb-5">Set up your SACCO or savings group. Your workspace starts with a 30-day free trial and a ready-made chart of accounts.</p>
      <ActionForm action={registerAction} submit="Create workspace" reset={false}>
        <Field label="Organisation name" name="orgName" required placeholder="e.g. Kawempe Teachers SACCO" />
        <Grid>
          <Select label="Organisation type" name="type" required defaultValue="sacco" options={[{ value: "sacco", label: "SACCO" }, { value: "vsla", label: "VSLA" }, { value: "investment_club", label: "Investment club" }, { value: "cooperative", label: "Cooperative" }, { value: "community_group", label: "Community savings group" }]} />
          <Field label="District" name="district" placeholder="Kampala" />
        </Grid>
        <Field label="Your full name" name="adminName" required />
        <Grid>
          <Field label="Email" name="email" type="email" required />
          <Field label="Phone" name="phone" placeholder="0772 123 456" inputMode="tel" />
        </Grid>
        <Grid>
          <Field label="Password" name="password" type="password" required hint="8+ characters with letters and numbers" />
          <Field label="Confirm password" name="confirm" type="password" required />
        </Grid>
        <label className="flex gap-2 text-sm items-start"><input type="checkbox" name="terms" className="mt-1" /> <span>I accept the terms of service and confirm member personal data will be handled in line with the Uganda Data Protection and Privacy Act, 2019.</span></label>
      </ActionForm>
      <p className="text-sm mt-5 text-center"><Link href="/login" className="text-brand font-medium">Already have an account? Sign in</Link></p>
    </div>
  );
}
