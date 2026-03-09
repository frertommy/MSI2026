import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { Nav } from "./nav";
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
        <Nav />
        {children}
      </body>
    </html>
  );
}
