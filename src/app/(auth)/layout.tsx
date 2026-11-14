import Image from "next/image";
import type { ReactNode } from "react";

/** SokoSave mark: a gold tile with a rising arrow over a coin. */
function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label="SokoSave" className="shrink-0">
      <defs>
        <linearGradient id="ss-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f1c85a" />
          <stop offset="1" stopColor="#b9831c" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill="url(#ss-gold)" />
      <path d="M9 27.5 16 20l4.5 4.5L30 13" fill="none" stroke="#1a1203" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M23.5 12.5H30.5V19.5" fill="none" stroke="#1a1203" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="11" cy="31" r="2.6" fill="#1a1203" />
    </svg>
  );
}

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-dark min-h-dvh bg-bg text-fg lg:grid lg:grid-cols-[1.05fr_1fr]">
      {/* Photo: a banner on phones, a full-height panel on large screens */}
      <aside className="relative h-[36dvh] min-h-[250px] max-h-[360px] overflow-hidden lg:h-auto lg:max-h-none lg:min-h-dvh">
        <Image
          src="/brand/sokosave-hero.webp"
          alt="Members of a savings group checking their SACCO account together on a phone outside the SACCO office"
          fill
          priority
          sizes="(min-width: 1024px) 52vw, 100vw"
          className="object-cover object-[50%_45%] lg:object-[50%_40%]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/35 to-transparent lg:bg-gradient-to-t lg:from-black/95 lg:via-black/25 lg:to-transparent" />
        <div className="absolute inset-x-0 bottom-0 hidden p-12 lg:block">
          <h1 className="max-w-md text-4xl font-semibold leading-[1.1] tracking-tight text-white">Your SACCO, in every pocket.</h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-white/75">
            Savings, loans and group meetings for SACCOs and savings groups across Uganda, with every shilling accounted for.
          </p>
        </div>
      </aside>

      <div className="relative flex min-h-[64dvh] flex-col px-4 pb-8 sm:px-8 lg:min-h-dvh lg:px-12">
        <main className="flex flex-1 flex-col items-center justify-start py-0 lg:justify-center">
          <div className="-mt-12 w-full max-w-md lg:mt-0">
            <div className="mb-5 flex items-center gap-3">
              <Mark />
              <span className="text-2xl font-semibold tracking-tight text-white">
                Soko<span className="text-brand">Save</span>
              </span>
            </div>
            {children}
          </div>
        </main>

        <footer className="mt-10 flex flex-col items-center gap-2 pt-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.28em] text-muted">from</span>
          <Image src="/brand/softronics-logo.webp" alt="Softronics" width={760} height={186} className="h-auto w-[148px] opacity-95 mix-blend-screen" />
        </footer>
      </div>
    </div>
  );
}
