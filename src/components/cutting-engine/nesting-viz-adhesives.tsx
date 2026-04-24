export function SimpleModeAdhesives({ usedSqFt }: { usedSqFt: number }) {
  if (usedSqFt <= 0) return null

  const pr200Gallons = usedSqFt / 380
  const sc4000Gallons = usedSqFt / 47
  const e40Units = sc4000Gallons * 4

  return (
    <div className="border-t border-border bg-background px-4 py-4">
      <div className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        Adhesive Requirements
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            PR200 Primer
          </div>
          <div className="mt-1 text-2xl font-semibold text-violet-400">
            {pr200Gallons.toFixed(2)} <span className="text-sm text-muted-foreground">gal</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">1 gal / 380 sq ft</div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            SC4000 Glue
          </div>
          <div className="mt-1 text-2xl font-semibold text-violet-400">
            {sc4000Gallons.toFixed(2)} <span className="text-sm text-muted-foreground">gal</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">1 gal / 47 sq ft</div>
        </div>
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            E40 Hardener
          </div>
          <div className="mt-1 text-2xl font-semibold text-violet-400">
            {e40Units.toFixed(2)} <span className="text-sm text-muted-foreground">units</span>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">4 units / gal SC4000</div>
        </div>
      </div>
    </div>
  )
}
