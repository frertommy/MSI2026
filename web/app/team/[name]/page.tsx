import Link from "next/link";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const teamName = decodeURIComponent(name);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <Link
            href="/"
            className="text-muted hover:text-foreground transition-colors text-sm"
          >
            &larr; Back
          </Link>
          <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            {teamName}
          </h1>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-12">
        <div className="rounded border border-border bg-surface p-8 text-center">
          <p className="text-muted text-sm font-mono">
            Team detail page for{" "}
            <span className="text-accent-green font-bold">{teamName}</span>
          </p>
          <p className="text-muted text-xs mt-2 font-mono">
            Match history, odds movement, and injury reports coming soon.
          </p>
        </div>
      </main>
    </div>
  );
}
