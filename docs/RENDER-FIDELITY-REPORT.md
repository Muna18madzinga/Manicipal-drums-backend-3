# Render fidelity proof

Generated 2026-10-03T15:21:02.575Z by `scripts/verify-render-fidelity.mjs`.

The paper claims symbology too complex for MapLibre is rendered by QGIS
Server rather than approximated. This checks the decision itself, on both
the real project and a fixture built from the QGIS symbol layers the real
project happens not to contain.

**54 styles · 0 invariant violations · 0 problems**

Levels: `direct` 31, `converted` 14, `server` 9

Strategies: `vector` 45, `wms` 9

## Fixture cases (the ones the corpus lacks)

| Layer | Expected | Classified | Strategy | MapLibre layers | QGIS classes | Vector would have drawn |
|---|---|---|---|---|---|---|
| solid_fill_control | direct | direct | vector | 1 | — | opacity undefined |
| solid_line_control | direct | direct | vector | 1 | — | — |
| circle_marker_control | converted | converted | vector | 1 | — | opacity undefined |
| brush_hatch_control | server | server | wms | 0 | — | opacity undefined |
| gradient_fill | server | server | wms | 0 | GradientFill | opacity undefined |
| shapeburst_fill | server | server | wms | 0 | ShapeburstFill | opacity undefined |
| line_pattern_fill | server | server | wms | 0 | LinePatternFill | opacity undefined |
| point_pattern_fill | server | server | wms | 0 | PointPatternFill | opacity undefined |
| svg_fill | server | server | wms | 0 | SVGFill | opacity undefined |
| stacked_fill_with_gradient | server | server | wms | 0 | GradientFill | opacity undefined |
| marker_line | server | server | wms | 0 | MarkerLine | — |
| font_marker | server | server | wms | 0 | FontMarker | opacity undefined |

The last column is the point of the fixture. None of those styles had a
faithful vector rendering available — the colour shown is what the
translator would have invented. What stops it reaching a citizen is the
fidelity rung, not the colour.

## Real project (what QGIS Server renders)

| Layer | Classified | Strategy | MapLibre layers | Notes |
|---|---|---|---|---|
| gweru_beyond_periurban_zones | converted | vector | 1 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixel |
| gweru_chiefdoms | converted | vector | 1 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixel |
| gweru_health_centres | converted | vector | 1 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI) |
| gweru_peri_urban_zone | converted | vector | 1 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixel |
| gweru_rivers | converted | vector | 1 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI) |
| gweru_rural_farms | converted | vector | 2 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixel |
| gweru_rural_planning_boundary | converted | vector | 2 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI) |
| proposed_peri_urban_zones | converted | vector | 2 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixels at 3.78 px/mm (96 DPI); millimetre widths converted to pixel |
| roads | direct | vector | 2 | — |
| zimbabwe | converted | vector | 2 | millimetre widths converted to pixels at 3.78 px/mm (96 DPI) |

## Generated QML corpus (32 files)

No generated style delegates to QGIS Server; every one compiles to MapLibre layers.

| Layer | Classified | Strategy | QGIS classes |
|---|---|---|---|

## What this does and does not prove

- It proves the routing decision is made from the authored symbology and
  that a delegated layer contributes no MapLibre layers, so no client
  can draw the approximation.
- It does not prove QGIS Server renders those layers correctly. That leg
  needs a running server: `npm run qgis:up` then
  `npm run qgis:verify`, and `npm run verify:legends` for the legend
  cross-check. See docs/LEGEND-FIDELITY-REPORT.md.
