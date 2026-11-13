import Link from "next/link";

export default function NotFound() {
  return (
    <main className="min-h-dvh grid place-items-center p-6"><div className="card card-pad max-w-md text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted mt-2">The record may not exist or may belong to another organisation.</p>
      <Link href="/" className="btn btn-primary mt-4">Go home</Link>
    </div></main>
  );
}
