export function FreeRoamPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Free Roam</h1>
        <p className="text-muted-foreground">CAD-style manual placement</p>
      </header>

      <div className="rounded-md border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning-foreground">
        Migration in progress — the Konva canvas and tool palette land in a later phase.
      </div>

      <section className="rounded-lg border border-border bg-card p-6 text-card-foreground">
        <h2 className="text-lg font-medium">Coming soon</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A desktop-class 2D workspace for positioning rubber parts by hand: snap-to-edge, rotate,
          duplicate, and export. Target frame-rate on modest hardware is 60 fps.
        </p>
      </section>
    </div>
  )
}
