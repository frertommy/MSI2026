import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MSI 2026",
  description: "Football match intelligence dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistMono.variable} antialiased bg-background text-foreground`}>
        <nav className="border-b border-border px-6 py-3">
          <div className="mx-auto max-w-7xl flex items-center gap-6">
            <a
              href="/"
              className="text-sm font-bold tracking-wider text-foreground uppercase"
            >
              MSI 2026
            </a>
            <div className="flex items-center gap-4 ml-auto">
              {/* Primary nav */}
              {[
                { href: "/", label: "Rankings" },
                { href: "/oracle", label: "Oracle" },
                { href: "/oracle-v2", label: "Oracle V2" },
                { href: "/matches", label: "Matches" },
                { href: "/measureme", label: "MeasureMe" },
              ].map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-xs text-muted hover:text-accent-green transition-colors font-mono uppercase tracking-wider"
                >
                  {link.label}
                </a>
              ))}
              {/* Legacy pages */}
              <span className="text-xs text-muted/50 font-mono">|</span>
              {[
                { href: "/old/oracle", label: "Old Oracle" },
                { href: "/old/matches", label: "Old Matches" },
              ].map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-xs text-muted/60 hover:text-muted transition-colors font-mono uppercase tracking-wider"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
