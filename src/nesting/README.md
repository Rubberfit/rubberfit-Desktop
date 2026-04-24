# nesting/

2D nesting engine for the cut planner. Packs irregularly-shaped parts onto rectangular stock material (rolls) to minimize waste, then computes reusable offcuts from the leftover free space.

## Architecture Overview

```text
Shape Definition          Packing                    Post-Processing
─────────────────    ──────────────────────    ─────────────────────────
shape-to-polygon.ts  nfp-greedy-placer.ts      free-space.ts
  rect / trapezoid     Greedy bottom-left        Clipper difference
  circle / sector      NFP placement             Inscribed rectangle
        │              Coarse-to-fine rotation    extraction
        ▼              search (36→±5°→±1°)        Sheet-based offcut
   convex-hull.ts          │                      classification
     Andrew's hull         ▼                          │
     Shoelace area    nfp-solver.ts                   ▼
                        GA-based optimizer        Reusable offcuts
                        (vendor/fit/)             vs scrap regions
```

## How It Works

1. **Shape conversion** (`shape-to-polygon.ts`): Parts (rectangles, circles, trapezoids, annular sectors) are converted to polygon vertex arrays
2. **Convex hull** (`convex-hull.ts`): Andrew's monotone chain computes the convex hull of each polygon for efficient NFP computation
3. **Greedy packing** (`nfp-greedy-placer.ts`): For identical shapes, a greedy bottom-left NFP placer finds optimal placement positions with sub-degree rotation precision via coarse-to-fine search
4. **GA optimization** (`nfp-solver.ts` + `vendor/fit/`): For mixed shapes, the Fit packer uses a genetic algorithm to evolve placement orderings
5. **Free-space analysis** (`free-space.ts`): After packing, Clipper boolean difference computes the exact free-space polygons, then iteratively extracts the largest axis-aligned inscribed rectangles as reusable offcuts

## Files

### types.ts

Core type definitions shared across the nesting engine.

```typescript
export interface Point2D {
  x: number
  y: number
}
export interface Polygon2D {
  id: string
  points: Point2D[]
  rotationSteps?: number
}
export interface NestingPart {
  id: string
  polygon: Polygon2D
  quantity: number
  renderShape: "rect" | "circle" | "trapezoid" | "sector"
  originalSpec: Record<string, unknown>
}
export interface NestingInput {
  binWidth: number
  binHeight: number
  parts: NestingPart[]
  spacing: number
  rotationSteps: number
  populationSize?: number
  mutationRate?: number
  generations?: number
  seed?: number
}
export interface Placement2D {
  partId: string
  x: number
  y: number
  width: number
  height: number
  polygonArea: number
  rotation: number
  placedPolygon: Point2D[]
  flipped: boolean
}
export interface NestingResult {
  placements: Placement2D[]
  placed: number
  overflow: number
  usedArea: number
  occupiedArea: number
  stockArea: number
  wasteArea: number
  efficiency: number // 0-100
  source: "heuristic" | "optimized"
}
```

### shape-to-polygon.ts

Converts geometric shapes to polygon vertex arrays for the nesting engine.

| Function                                               | Shape                 | Output                                              |
| ------------------------------------------------------ | --------------------- | --------------------------------------------------- |
| `rectToPolygon(w, h)`                                  | Rectangle             | 4 vertices                                          |
| `circleToPolygon(d, segments=24)`                      | Circle                | N vertices on circumference                         |
| `ellipseToPolygon(w, h, segments=48)`                  | Ellipse               | N vertices on perimeter                             |
| `triangleToPolygon(base, h)`                           | Isoceles triangle     | 3 vertices, apex on top                             |
| `rightTriangleToPolygon(base, h)`                      | Right triangle        | 3 vertices, right angle bottom-left                 |
| `ngonToPolygon(sides, radius)`                         | Regular n-gon         | `sides` vertices distributed on a circle            |
| `starToPolygon(points, rOut, rIn)`                     | N-pointed star        | `points × 2` alternating outer/inner vertices       |
| `ringToPolygon(outerD, innerD, segments=48)`           | Annulus (with hole)   | Outer CCW + bridge + inner CW (Clipper-normalized)  |
| `ringOuterOnlyPolygon(outerD, segments=48)`            | Annulus (outer only)  | For renderers that can't handle holes               |
| `trapezoidToPolygon(topW, bottomW, h)`                 | Trapezoid             | 4 vertices, centered                                |
| `sectorToPolygon(innerR, outerR, arcDeg, segments=24)` | Annular sector (cone) | ~50 vertices: outer arc forward + inner arc reverse |

### convex-hull.ts

Computational geometry utilities. No external dependencies.

**Algorithms:**

- **Convex hull**: Andrew's monotone chain algorithm (1979). O(n log n). Returns vertices in CCW order.
- **Polygon area**: Shoelace formula. Returns absolute area regardless of winding.

```text
Reference: A.M. Andrew, "Another Efficient Algorithm for Convex Hulls in Two Dimensions", 1979
```

### nfp-greedy-placer.ts

Greedy bottom-left NFP placer for packing identical shapes. Optimized for the common cut-planner case where many copies of the same shape are cut from one stock sheet.

**Key design decisions:**

1. **Convex hull for both NFP and overlap validation**: NFP computation uses the convex hull (faster Minkowski difference with only 2 NFPs total regardless of quantity). Overlap validation also uses convex hulls with SAT (Separating Axis Theorem), which prevents non-convex shapes (e.g. annular sectors/cones) from interlocking through concave voids — physically impossible for sheet cutting.

2. **Coarse-to-fine rotation search**: Instead of brute-forcing all 360 angles, uses a 3-pass strategy:
   - **Coarse**: 36 equally-spaced angles (every 10°) → find top results
   - **Fine**: ±5° at 1° increments around top 2 coarse results
   - **Ultra-fine**: ±1° at 0.25° increments around the best
   - Result: sub-degree optimal rotation with ~67 packing attempts instead of 360+

3. **SAT overlap validation on convex hulls**: Each candidate position is validated by SAT (O(n+m)) between the candidate's convex hull and all previously placed convex hulls. This catches Clipper precision errors in the NFP valid-region computation and prevents non-convex shape interlocking.

```typescript
export function greedyNfpPack(
  polygon: Polygon2D,
  binWidth: number,
  binHeight: number,
  qty: number,
  spacing?: number,
  rotationSteps?: number
): GreedyPackResult
```

### free-space.ts

Polygon-aware free-space computation. After shapes are packed onto a stock sheet, this module finds the largest reusable offcuts in the remaining free space.

**Algorithm (iterative extraction):**

1. **Clipper difference**: `stock - union(placed shapes)` → outer contours (free space) + holes (placed shapes)
2. **Grid construction**: Seed regular intermediate grid lines at 2" intervals (`GRID_MAX_STEP`), then add polygon vertices + edge-grid intersection points. The regular seeding ensures triangular/trapezoidal free-space regions with few vertices get enough grid cells for the histogram algorithm
3. **Hole-aware PIP**: Each grid cell is classified as free/occupied by testing all 4 corners (with 0.001" epsilon inset) against the outer contour and all hole contours via ray-casting
4. **O(RC) histogram + monotonic stack**: Find the largest axis-aligned inscribed rectangle in the free-space grid, using actual physical dimensions (inches) for non-uniform cell sizes
5. **Subtract and repeat**: Subtract the found rectangle from its polygon via Clipper, requeue remainder polygons, repeat until `maxRects` reached or no rectangle meets minimum area

**Key design decisions:**

- **Hole-aware processing**: Clipper difference returns both outer contours (positive area) and holes (negative area = placed shapes). Holes persist through the iterative extraction — they represent physical shapes that can't be removed
- **Regular grid seeding**: `GRID_MAX_STEP = 2"` ensures at most 2" between grid lines before vertex/edge enrichment. Without this, simple polygons (e.g. the triangle between two packed trapezoids) produce a grid with only 1-2 cells that span the full height, failing the 4-corner PIP test because sloped edges cross through cell interiors
- **Edge intersection enrichment**: Where polygon edges cross grid lines, the intersection coordinates are added to the grid. This refines the grid at sloped edges (trapezoids) so inscribed rectangles align precisely with the polygon boundary
- **4-corner cell testing**: Each grid cell is tested at all 4 corners (inset by 0.001") instead of just the center point. Prevents inscribed rectangles from extending beyond sloped polygon edges
- **Sheet-based classification**: Offcut reusability is determined purely by material size thresholds, not by whether the current shape fits. A leftover piece that's too small for the current trapezoid might still be a useful rectangle for future cuts

```typescript
// Extract up to 10 reusable offcut rectangles from free space
export function extractMaximalFreeRects(
  stockW: number,
  stockH: number,
  placedPolygons: ReadonlyArray<ReadonlyArray<Point2D>>,
  maxRects?: number // default: 10
): FreeRegion[]

// Classify: "reusable" if ≥ 11.5"×12" offcut or ≥ 6"×24" strip
export function classifyFreeRegion(region: FreeRegion): "reusable" | "scrap"
```

## vendor/fit/

Third-party nesting library (vendored). Implements the core NFP packing algorithm with a genetic algorithm optimizer.

| File                              | Purpose                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `index.ts`                        | Library entry point                                                        |
| `packer.ts`                       | Main packing orchestrator                                                  |
| `placer.ts`                       | Places parts using NFP calculations                                        |
| `placement.ts`                    | Placement data structures                                                  |
| `part.ts`                         | Part representation                                                        |
| `bin.ts`                          | Bin (stock material) representation                                        |
| `polygon.ts`                      | Polygon operations (NFP, intersection, containment)                        |
| `bounding-box.ts`                 | Axis-aligned bounding box calculations                                     |
| `ga/ga.ts`                        | Genetic algorithm driver                                                   |
| `ga/dna.ts`                       | DNA encoding for part orderings/rotations                                  |
| `gaussian.ts`                     | Gaussian distribution for GA mutation                                      |
| `xorshift.ts`                     | Fast PRNG for the GA                                                       |
| `vector.ts` / `indexed-vector.ts` | 2D vector math                                                             |
| `util-geometry.ts`                | Geometry utilities                                                         |
| `util.ts`                         | General utilities (Minkowski difference, NFP computation, Clipper helpers) |
| `clipper-lib.d.ts`                | Type declarations for Clipper polygon clipping library                     |

## Dependencies

- **clipper-lib**: Polygon boolean operations (union, difference, intersection). Used by NFP greedy placer, free-space extraction, and the vendored Fit library. Already a project dependency.

## Key Algorithms Reference

| Algorithm                              | Used In                | Source                           |
| -------------------------------------- | ---------------------- | -------------------------------- |
| Andrew's monotone chain (convex hull)  | `convex-hull.ts`       | A.M. Andrew, 1979                |
| Shoelace formula (polygon area)        | `convex-hull.ts`       | Standard computational geometry  |
| Minkowski difference (NFP)             | `vendor/fit/util.ts`   | Vendored from Fit packer         |
| Greedy bottom-left placement           | `nfp-greedy-placer.ts` | Custom implementation            |
| Coarse-to-fine rotation search         | `nfp-greedy-placer.ts` | Custom 3-pass strategy           |
| Clipper boolean intersection (overlap) | `nfp-greedy-placer.ts` | Via clipper-lib                  |
| O(RC) histogram + monotonic stack      | `free-space.ts`        | Standard max-rectangle algorithm |
| Ray-casting PIP                        | `free-space.ts`        | Standard point-in-polygon test   |
| Iterative inscribed rect extraction    | `free-space.ts`        | Custom Clipper-based iteration   |
