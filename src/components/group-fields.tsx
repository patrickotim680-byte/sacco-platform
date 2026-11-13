import { Field, Grid } from "@/components/forms";
import type { GroupRules } from "@/lib/services/groups";
import { DEFAULT_RULES } from "@/lib/services/groups";

export function RulesFields({ rules = DEFAULT_RULES }: { rules?: GroupRules }) {
  return (
    <Grid>
      <Field label="Share price (UGX)" name="sharePrice" required defaultValue={rules.sharePrice} inputMode="numeric" />
      <Field label="Max shares per member per meeting" name="maxShares" required defaultValue={rules.maxSharesPerMeeting} inputMode="numeric" />
      <Field label="Group loan interest (% per loan)" name="loanInterest" required defaultValue={rules.loanInterestPct} inputMode="decimal" />
      <Field label="Loan limit (x member's share savings)" name="loanMultiple" required defaultValue={rules.loanMultipleOfSavings} inputMode="decimal" />
      <Field label="Social fund per meeting (UGX)" name="socialFund" required defaultValue={rules.socialFundContribution} inputMode="numeric" />
      <Field label="Late fine (UGX)" name="lateFine" required defaultValue={rules.lateFine} inputMode="numeric" />
      <Field label="Absence fine (UGX)" name="absentFine" required defaultValue={rules.absentFine} inputMode="numeric" />
    </Grid>
  );
}
