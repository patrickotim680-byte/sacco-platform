import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Toaster } from "@/components/forms";

export const metadata: Metadata = {
  title: { default: "SokoSave", template: "%s | SokoSave" },
  description: "SokoSave: savings, loans and group management for SACCOs and savings groups in Uganda.",
  applicationName: "SokoSave",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b6e4f" };

const themeScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
