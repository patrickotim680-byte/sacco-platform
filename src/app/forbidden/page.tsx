import Link from "next/link";

export default function Forbidden() {
  return (
    <main className="min-h-dvh grid place-items-center p-6"><div className="card card-pad max-w-md text-center">
      <h1 className="text-xl font-semibold">Access denied</h1>
      <p className="text-sm text-muted mt-2">Your role does not allow this action. The attempt has been recorded. Ask your organisation administrator if you need access.</p>
      <Link href="/" className="btn btn-primary mt-4">Back to home</Link>
    </div></main>
  );
}
