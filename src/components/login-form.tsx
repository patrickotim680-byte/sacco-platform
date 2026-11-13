"use client";
import { ActionForm, Field } from "@/components/forms";
import { loginAction } from "@/app/actions/auth";

export function LoginForm({ demos, password }: { demos: { email: string; role: string }[]; password: string }) {
  const fill = (email: string) => {
    (document.getElementById("email") as HTMLInputElement).value = email;
    (document.getElementById("password") as HTMLInputElement).value = password;
  };
  return (
    <>
      <ActionForm action={loginAction} submit="Sign in" reset={false}>
        <Field label="Email" name="email" type="email" required />
        <Field label="Password" name="password" type="password" required />
      </ActionForm>
      {demos.length > 0 && (
        <div className="mt-6 pt-4 border-t border-line">
          <p className="text-xs font-semibold text-warn uppercase tracking-wide">Demo environment - fictional data</p>
          <p className="text-xs text-muted mt-1 mb-2">Pick a role to fill the form (password <code className="num">{password}</code>), then press Sign in.</p>
          <ul className="grid gap-1.5">
            {demos.map((d) => (
              <li key={d.email}><button type="button" onClick={() => fill(d.email)} className="w-full text-left btn btn-sm justify-between"><span>{d.role}</span><span className="text-muted font-normal hidden sm:inline">{d.email}</span></button></li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
