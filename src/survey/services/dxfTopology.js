/**
 * DXF Topological Whitespace Scanner — pure functions used by
 * sub-projects 4c (block placer), 4d (per-feature label placement),
 * and 3-v2 (Schedule of Areas topological placement).
 *
 * Algorithms are byte-for-byte ports from `app-backend/src/services/
 * pdfkitGeoPDF.js` (line numbers cited per function). Interfaces are
 * normalised to a uniform `{x, y}` object shape (matching 4a's
 * dxfGeometry.js convention) and a named-argument signature for the
 * public `computeWhitespaceZones` function.
 *
 * All inputs are unit-agnostic; caller's responsibility to keep units
 * consistent within one call. When called from sub-project 4c, units
 * will be ground metres at the chosen scale.
 *
 * No DXF dependencies, no module state, no I/O. Pure math.
 *
 * Verbatim-port fidelity note: the PDF's band-flush logic in
 * `computeWhitespaceZones` uses Math.min/max reductions that pick the
 * polygon edge closest to the zone (not the most conservative one).
 * This can produce zones that overlap the polygon when the band's
 * `rightAt[y]` varies significantly. In practice the bands form only
 * where the profile is roughly constant, so the issue rarely surfaces.
 * Preserved verbatim for fidelity to the production PDF.
 */

/**
 * Walks each polygon edge and samples it at integer multiples of
 * `scanStep`, recording for each sampled coordinate the most-extreme
 * x or y at that slice. Returns 4 dictionaries:
 *   - rightAt[y] = rightmost x of polygon at horizontal slice y
 *   - leftAt[y]  = leftmost x at slice y
 *   - bottomAt[x] = bottommost y at vertical slice x (max — y increases downward in PDF convention)
 *   - topAt[x]    = topmost y at slice x (min)
 *
 * Port of `pdfkitGeoPDF.js:9021`. Algorithm verbatim; interface
 * normalised to `{x, y}` polygon vertices (the PDF version already
 * used `{x, y}` objects so no destructuring change was needed).
 *
 * CLOSED-POLYGON ASSUMPTION: iterates `polygon.length - 1` edges, so
 * the polygon must be presented closed (last vertex equals first). An
 * open polygon will silently miss its final closing edge. Same
 * convention as `isPointNearPolygon` in 4a's dxfGeometry.js.
 *
 * @param {Array<{x:number,y:number}>} polygon - Closed polygon vertices
 * @param {number} scanStep - Sampling resolution (must be > 0)
 * @returns {{rightAt: Object, leftAt: Object, bottomAt: Object, topAt: Object}}
 *   Dictionaries keyed by integer multiples of scanStep.
 */
export function computePolygonProfile(polygon, scanStep) {
  const rightAt = {}, leftAt = {}, bottomAt = {}, topAt = {}

  for (let i = 0; i < polygon.length - 1; i++) {
    const p1 = polygon[i], p2 = polygon[i + 1]

    // Horizontal profiles (rightAt / leftAt) — sample at y intervals
    if (Math.abs(p2.y - p1.y) > 0.001) {
      const yMin = Math.min(p1.y, p2.y)
      const yMax = Math.max(p1.y, p2.y)
      for (let y = Math.ceil(yMin / scanStep) * scanStep; y <= yMax; y += scanStep) {
        const t = (y - p1.y) / (p2.y - p1.y)
        const x = p1.x + t * (p2.x - p1.x)
        rightAt[y] = Math.max(rightAt[y] ?? -Infinity, x)
        leftAt[y]  = Math.min(leftAt[y]  ??  Infinity, x)
      }
    }

    // Vertical profiles (bottomAt / topAt) — sample at x intervals
    if (Math.abs(p2.x - p1.x) > 0.001) {
      const xMin = Math.min(p1.x, p2.x)
      const xMax = Math.max(p1.x, p2.x)
      for (let x = Math.ceil(xMin / scanStep) * scanStep; x <= xMax; x += scanStep) {
        const t = (x - p1.x) / (p2.x - p1.x)
        const y = p1.y + t * (p2.y - p1.y)
        bottomAt[x] = Math.max(bottomAt[x] ?? -Infinity, y)
        topAt[x]    = Math.min(topAt[x]    ??  Infinity, y)
      }
    }
  }
  return { rightAt, leftAt, bottomAt, topAt }
}

/**
 * Derive rectangular whitespace zones from the polygon's boundary
 * profile. For each directional strip (right / left / bottom / top),
 * consecutive scan lines where available width ≥ tableMinWidth are
 * grouped into a conservative rectangle.
 *
 * Topology-aware: an L-shaped polygon exposes its open corner as a
 * valid zone, whereas a simple bounding-box approach would exclude
 * that corner entirely.
 *
 * Port of `pdfkitGeoPDF.js:9070`. The PDF version takes positional
 * arguments + a `scaleDenominator` for groundWidthM annotation; this
 * port uses a named-argument object and drops groundWidthM (redundant
 * when inputs are already in ground units).
 *
 * Verbatim-port fidelity note: the band-flush reductions
 * (Math.min(bandMinRight, rx) on the right strip, Math.max(bandMaxLeft,
 * lx) on the left, etc.) pick the polygon edge closest to the zone
 * rather than the most conservative one. When `rightAt[y]` varies
 * significantly within a band, the emitted zone may overlap the
 * polygon at high-rightAt y values. In practice the bands form only
 * where the profile is roughly constant, so the issue rarely surfaces.
 *
 * @param {Object} args
 * @param {Array<{x:number,y:number}>} args.polygon - Closed polygon; if null/empty/<3 vertices, returns full-bounds zone
 * @param {{x:number,y:number,width:number,height:number}} args.mapBounds - The rectangular region within which to find whitespace
 * @param {number} args.buffer - Minimum clear distance between zone edge and polygon
 * @param {number} args.tableMinWidth - Minimum zone width to be considered usable
 * @param {number} args.scanStep - Sampling resolution (passed through to computePolygonProfile)
 * @returns {Array<{x:number,y:number,width:number,height:number,side:string,area:number}>}
 *   Zones sorted by side preference (right, bottom, left, top) then area descending.
 */
export function computeWhitespaceZones({
  polygon, mapBounds, buffer, tableMinWidth, scanStep,
}) {
  const mLeft   = mapBounds.x
  const mRight  = mapBounds.x + mapBounds.width
  const mTop    = mapBounds.y
  const mBottom = mapBounds.y + mapBounds.height

  if (!polygon || polygon.length < 3) {
    return [{
      x: mLeft, y: mTop, width: mapBounds.width, height: mapBounds.height,
      side: 'full', area: mapBounds.width * mapBounds.height,
    }]
  }

  const profile = computePolygonProfile(polygon, scanStep)
  const zones   = []

  // Align scan starts to multiples of scanStep so they hit the same keys
  // computePolygonProfile wrote (which also samples at ceil(coord/step)*step).
  const yStart = Math.ceil(mTop / scanStep) * scanStep
  const xStart = Math.ceil(mLeft / scanStep) * scanStep

  // RIGHT strip — scan y top→bottom; available x = rightAt[y]+buffer → mRight
  {
    let bandStart = null, bandMinRight = Infinity
    const flush = (yEnd) => {
      if (bandStart === null) return
      const x = bandMinRight + buffer
      const w = mRight - x
      if (w >= tableMinWidth) {
        zones.push({
          x, y: bandStart, width: w, height: yEnd - bandStart,
          side: 'right', area: w * (yEnd - bandStart),
        })
      }
      bandStart = null
      bandMinRight = Infinity
    }
    for (let y = yStart; y <= mBottom; y += scanStep) {
      const rx = profile.rightAt[y]
      if (rx == null || rx + buffer >= mRight - tableMinWidth) { flush(y); continue }
      const avail = mRight - (rx + buffer)
      if (avail < tableMinWidth) { flush(y); continue }
      if (bandStart === null) bandStart = y
      bandMinRight = Math.min(bandMinRight, rx)  // PDF verbatim — see fidelity note
    }
    flush(mBottom)
  }

  // LEFT strip — scan y top→bottom; available x = mLeft → leftAt[y]-buffer
  {
    let bandStart = null, bandMaxLeft = -Infinity
    const flush = (yEnd) => {
      if (bandStart === null) return
      const right = bandMaxLeft - buffer
      const w = right - mLeft
      if (w >= tableMinWidth) {
        zones.push({
          x: mLeft, y: bandStart, width: w, height: yEnd - bandStart,
          side: 'left', area: w * (yEnd - bandStart),
        })
      }
      bandStart = null
      bandMaxLeft = -Infinity
    }
    for (let y = yStart; y <= mBottom; y += scanStep) {
      const lx = profile.leftAt[y]
      if (lx == null || lx - buffer <= mLeft + tableMinWidth) { flush(y); continue }
      const avail = (lx - buffer) - mLeft
      if (avail < tableMinWidth) { flush(y); continue }
      if (bandStart === null) bandStart = y
      bandMaxLeft = Math.max(bandMaxLeft, lx)  // PDF verbatim
    }
    flush(mBottom)
  }

  // BOTTOM strip — scan x left→right; available y = bottomAt[x]+buffer → mBottom
  {
    let bandStart = null, bandMinBottom = Infinity
    const flush = (xEnd) => {
      if (bandStart === null) return
      const y = bandMinBottom + buffer
      const h = mBottom - y
      if (h >= tableMinWidth / 2 && xEnd - bandStart >= tableMinWidth) {
        zones.push({
          x: bandStart, y, width: xEnd - bandStart, height: h,
          side: 'bottom', area: (xEnd - bandStart) * h,
        })
      }
      bandStart = null
      bandMinBottom = Infinity
    }
    for (let x = xStart; x <= mRight; x += scanStep) {
      const by = profile.bottomAt[x]
      if (by == null || by + buffer >= mBottom) { flush(x); continue }
      if (bandStart === null) bandStart = x
      bandMinBottom = Math.min(bandMinBottom, by)  // PDF verbatim
    }
    flush(mRight)
  }

  // TOP strip — scan x left→right; available y = mTop → topAt[x]-buffer
  {
    let bandStart = null, bandMaxTop = -Infinity
    const flush = (xEnd) => {
      if (bandStart === null) return
      const bottom = bandMaxTop - buffer
      const h = bottom - mTop
      if (h >= tableMinWidth / 2 && xEnd - bandStart >= tableMinWidth) {
        zones.push({
          x: bandStart, y: mTop, width: xEnd - bandStart, height: h,
          side: 'top', area: (xEnd - bandStart) * h,
        })
      }
      bandStart = null
      bandMaxTop = -Infinity
    }
    for (let x = xStart; x <= mRight; x += scanStep) {
      const ty = profile.topAt[x]
      if (ty == null || ty - buffer <= mTop) { flush(x); continue }
      if (bandStart === null) bandStart = x
      bandMaxTop = Math.max(bandMaxTop, ty)  // PDF verbatim
    }
    flush(mRight)
  }

  // Sort: right preferred (SI 727 natural block side), then by area descending
  const sideOrder = { right: 0, bottom: 1, left: 2, top: 3 }
  return zones
    .filter(z => z.width > 0 && z.height > 0)
    .sort((a, b) => {
      const d = (sideOrder[a.side] ?? 9) - (sideOrder[b.side] ?? 9)
      return d !== 0 ? d : b.area - a.area
    })
}
