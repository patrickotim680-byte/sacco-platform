import { ActionForm, Field } from "@/components/forms";
import { resetAction } from "@/app/actions/auth";

export const metadata = { title: "Choose a new password" };

export default async function ResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) return <div className="card card-pad"><p>This reset link is missing its token. Request a new one.</p></div>;
  return (
    <div className="card card-pad">
      <h2 className="text-xl font-semibold">Choose a new password</h2>
      <ActionForm action={resetAction} submit="Update password" reset={false} className="mt-4">
        <input type="hidden" name="token" value={token} />
        <Field label="New password" name="password" type="password" required hint="8+ characters with letters and numbers" />
        <Field label="Confirm password" name="confirm" type="password" required />
      </ActionForm>
    </div>
  );
}
