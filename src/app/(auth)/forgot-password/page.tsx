import Link from "next/link";
import { ActionForm, Field } from "@/components/forms";
import { forgotAction } from "@/app/actions/auth";

export const metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <div className="card card-pad">
      <h2 className="text-xl font-semibold">Forgot your password?</h2>
      <p className="text-sm text-muted mb-4">Enter your account email and we will send a reset link valid for one hour.</p>
      <ActionForm action={forgotAction} submit="Send reset link">
        <Field label="Email" name="email" type="email" required />
      </ActionForm>
      <p className="text-sm mt-5"><Link href="/login" className="text-brand font-medium">Back to sign in</Link></p>
    </div>
  );
}
