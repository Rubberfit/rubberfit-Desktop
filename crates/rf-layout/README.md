# rf-layout

2D nesting engine built on jagua-rs (collision engine) and sparrow (LNS+SA optimizer). REMA's proprietary scoring (fabrication score, reusable-offcut classification, intra-blank waste) layers on top of the standard core via a dedicated `proprietary` module.

## Layout

- `src/domain/` — pure types matching `src/application/packing/types.ts` in the TS repo (camelCase serde) + industry-standard synonyms via `#[serde(alias)]`
- `src/application/pack.rs` — pack() orchestrator (Task 18)
- `src/infrastructure/` — jagua-rs adapter, sparrow driver, warm-start (Phase 6)

## Public API (v0.1)

```rust
use rf_layout::application::pack;
use rf_layout::domain::{PackRequest, PackResult};

let request: PackRequest = serde_json::from_str(&json)?;
let result: PackResult = pack(request)?;
```

## Wire format

Field names are camelCase. Industry-common synonyms accepted as aliases:

- `quantity` ↔ `demand` (jagua-rs BPP)
- `clearance` ↔ `kerf` ↔ `spacing` (CAM / Deepnest / libnest2d)
- `efficiency` ↔ `density` on `BinResult` (jagua-rs output)

Units default to inches; pass `units: "mm"` to override.

## Experimental: `fixed_bin_sparrow_repack`

`src/infrastructure/search/mod.rs` exposes
`fixed_bin_sparrow_repack(bin, items, clearance, config)` — a bounded
sparrow-style repack that force-places items with overlaps and runs the
BPP-shaped GLS to resolve them. Standalone, not wired into `pack()`.

**2026-04-19 finding:** does NOT lift density on the production 37-part
fixture. The ported GLS is architecturally a collision resolver, not a
density-increasing packer. Retained as infrastructure for a future
ruin-and-recreate LNS port. See
`.claude/research/sparrow-integration/spike-result.md` for the full
kill-signal write-up.
