export function AutoNestPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Auto Nest</h1>
        <p className="text-muted-foreground">Preset-driven bin packing</p>
      </header>

      <div className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-foreground">
        Migration in progress — feature parity with the web cutting engine is tracked in the
        Rubberfit-Desktop migration plan.
      </div>

      <section className="rounded-lg border border-border bg-card p-6 text-card-foreground">
        <h2 className="text-lg font-medium">Coming soon</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick a preset, drop your cut list, and let the nesting engine produce bin-packed layouts.
          The desktop build will invoke the same Rust engine as the web portal via a Tauri command.
        </p>
      </section>
    </div>
  )
}
