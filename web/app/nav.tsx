"use client";

import { useState, useRef, useEffect } from "react";

interface DropdownItem {
  href: string;
  label: string;
}

const v2Links: DropdownItem[] = [
  { href: "/oracle-v2/matches", label: "Matches" },
  { href: "/oracle-v2/diagnostics", label: "Diagnostics" },
];

const v1Links: DropdownItem[] = [
  { href: "/", label: "Rankings" },
  { href: "/matches", label: "Matches" },
  { href: "/measureme", label: "Diagnostics" },
];

function NavDropdown({
  label,
  href,
  items,
  accent,
}: {
  label: string;
  href: string;
  items: DropdownItem[];
  accent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center gap-0">
        <a
          href={href}
          className={`text-xs transition-colors font-mono uppercase tracking-wider ${
            accent
              ? "text-muted hover:text-accent-green"
              : "text-muted/60 hover:text-muted"
          }`}
        >
          {label}
        </a>
        <button
          onClick={() => setOpen(!open)}
          className={`text-xs transition-colors font-mono ml-1 ${
            accent
              ? "text-muted/60 hover:text-muted"
              : "text-muted/40 hover:text-muted/60"
          }`}
        >
          <svg
            className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="absolute left-0 top-full mt-2 bg-[#1a1a1a] border border-border rounded-md shadow-lg py-1 min-w-[140px] z-50">
          {items.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className="block px-4 py-2 text-xs text-muted hover:text-accent-green hover:bg-white/5 transition-colors font-mono uppercase tracking-wider"
            >
              {link.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function Nav() {
  return (
    <nav className="border-b border-border px-6 py-3">
      <div className="mx-auto max-w-7xl flex items-center gap-6">
        <a
          href="/"
          className="text-sm font-bold tracking-wider text-foreground uppercase"
        >
          MSI 2026
        </a>

        <div className="flex items-center gap-5 ml-auto">
          <NavDropdown
            label="Oracle V2"
            href="/oracle-v2"
            items={v2Links}
            accent
          />
          <span className="text-xs text-muted/30 font-mono">|</span>
          <NavDropdown
            label="V1"
            href="/oracle"
            items={v1Links}
          />
        </div>
      </div>
    </nav>
  );
}
