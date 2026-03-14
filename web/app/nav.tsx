"use client";

export function Nav() {
  return (
    <nav className="border-b border-border px-6 py-3">
      <div className="mx-auto max-w-7xl flex items-center gap-6">
        <a
          href="/oracle-v3"
          className="text-sm font-bold tracking-wider text-foreground uppercase"
        >
          MSI 2026
        </a>

        <div className="flex items-center gap-5 ml-auto">
          <a
            href="/oracle-v3"
            className="text-xs transition-colors font-mono uppercase tracking-wider text-muted hover:text-accent-green"
          >
            Rankings
          </a>
          <a
            href="/oracle-v3/matches"
            className="text-xs transition-colors font-mono uppercase tracking-wider text-muted hover:text-accent-green"
          >
            Matches
          </a>
          <a
            href="/oracle-v3/diagnostics"
            className="text-xs transition-colors font-mono uppercase tracking-wider text-muted hover:text-accent-green"
          >
            Diagnostics
          </a>

          <span className="text-border text-xs select-none">│</span>

          <a
            href="/vglobal"
            className="text-xs transition-colors font-mono uppercase tracking-wider text-muted hover:text-amber-400"
          >
            vGlobal
          </a>
          <a
            href="/vglobal/matches"
            className="text-xs transition-colors font-mono uppercase tracking-wider text-muted hover:text-amber-400"
          >
            CL Matches
          </a>
          <a
            href="/vglobal/diagnostics"
            className="text-xs transition-colors font-mono uppercase tracking-wider text-muted hover:text-amber-400"
          >
            CL Diagnostics
          </a>
        </div>
      </div>
    </nav>
  );
}
