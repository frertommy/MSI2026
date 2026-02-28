export default function CompareLoading() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto max-w-7xl flex items-center gap-4">
          <span className="text-muted text-sm">&larr; Rankings</span>
          <div className="h-2 w-2 rounded-full bg-accent-green animate-pulse" />
          <h1 className="text-lg font-bold tracking-wider text-foreground uppercase">
            Oracle Compare
          </h1>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-6">
        <div className="space-y-8 animate-pulse">
          {/* Controls skeleton */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="h-10 w-48 rounded bg-border/50" />
            <div className="flex gap-1">
              <div className="h-8 w-10 rounded bg-border/50" />
              <div className="h-8 w-10 rounded bg-border/50" />
              <div className="h-8 w-10 rounded bg-border/50" />
            </div>
            <div className="flex gap-2 ml-auto">
              <div className="h-8 w-20 rounded bg-border/50" />
              <div className="h-8 w-20 rounded bg-border/50" />
              <div className="h-8 w-20 rounded bg-border/50" />
              <div className="h-8 w-20 rounded bg-border/50" />
            </div>
          </div>

          {/* Chart skeleton */}
          <div className="border border-border rounded-lg p-4 bg-surface">
            <div className="h-4 w-40 rounded bg-border/50 mb-4" />
            <div className="h-[350px] rounded bg-border/30 flex items-center justify-center">
              <div className="text-muted text-sm font-mono">Loading chart...</div>
            </div>
          </div>

          {/* Stats skeleton */}
          <div className="grid grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="border border-border rounded-lg p-4 bg-surface">
                <div className="h-3 w-20 rounded bg-border/50 mb-3" />
                <div className="space-y-2">
                  <div className="h-3 w-full rounded bg-border/50" />
                  <div className="h-3 w-3/4 rounded bg-border/50" />
                  <div className="h-3 w-2/3 rounded bg-border/50" />
                  <div className="h-3 w-1/2 rounded bg-border/50" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
