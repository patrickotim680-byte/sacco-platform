import { Field, Grid, Select } from "@/components/forms";
import { members } from "@/db/schema";
import { todayEAT } from "@/lib/finance";

export const CHANNEL_OPTIONS = [
  { value: "cash", label: "Cash" }, { value: "mtn_momo", label: "MTN Mobile Money" }, { value: "airtel_money", label: "Airtel Money" }, { value: "bank", label: "Bank transfer" }, { value: "manual", label: "Manually verified" },
];

export function MemberFields({ m }: { m?: typeof members.$inferSelect }) {
  return (
    <>
      <Field label="Full name" name="fullName" required defaultValue={m?.fullName} />
      <Grid>
        <Field label="Phone" name="phone" required defaultValue={m?.phone} placeholder="0772 123 456" inputMode="tel" hint="Uganda number; stored as +256..." />
        <Field label="Email" name="email" type="email" defaultValue={m?.email} />
        <Select label="Gender" name="gender" defaultValue={m?.gender ?? ""} options={[{ value: "female", label: "Female" }, { value: "male", label: "Male" }, { value: "other", label: "Other" }]} />
        <Field label="Date of birth" name="dateOfBirth" type="date" defaultValue={m?.dateOfBirth} />
        <Field label="National ID (NIN)" name="nationalId" defaultValue={m?.nationalId} />
        <Field label="Occupation" name="occupation" defaultValue={m?.occupation} />
        <Field label="District" name="district" defaultValue={m?.district} />
        <Field label="Village / address" name="address" defaultValue={m?.address} />
        {!m && <Field label="Joining date" name="joinedAt" type="date" defaultValue={todayEAT()} />}
      </Grid>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted pt-1">Next of kin</p>
      <Grid cols={3}>
        <Field label="Name" name="nokName" defaultValue={m?.nokName} />
        <Field label="Phone" name="nokPhone" defaultValue={m?.nokPhone} inputMode="tel" />
        <Field label="Relationship" name="nokRelationship" defaultValue={m?.nokRelationship} />
      </Grid>
    </>
  );
}

export function MoneyFields({ withDuplicate = true, withDate = true, withRef = true, channels = CHANNEL_OPTIONS }: { withDuplicate?: boolean; withDate?: boolean; withRef?: boolean; channels?: typeof CHANNEL_OPTIONS }) {
  return (
    <>
      <Grid>
        <Field label="Amount (UGX)" name="amount" required inputMode="numeric" placeholder="50000" />
        <Select label="Channel" name="channel" required defaultValue="cash" options={channels} />
        {withRef && <Field label="Provider / bank reference" name="externalRef" hint="Required for mobile money and bank; must be unique" />}
        {withDate && <Field label="Date" name="date" type="date" defaultValue={todayEAT()} />}
      </Grid>
      {withDuplicate && <label className="flex gap-2 text-sm items-center"><input type="checkbox" name="confirmDuplicate" /> Confirm duplicate (only if an identical payment is genuine)</label>}
    </>
  );
}
