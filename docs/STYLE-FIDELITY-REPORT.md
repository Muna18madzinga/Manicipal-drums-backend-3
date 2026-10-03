# Style extraction fidelity report

Generated 2026-10-03T07:36:30.388Z by `scripts/verify-style-fidelity.mjs` against
`qgis-projects\vungu-project.qgs`. This is the evidence behind the paper's claim that QGIS
renderer definitions translate into MapLibre GL JS paint expressions.

**40/40 layers extracted · 0 fell back to the default style · 0 errored · 1 carry warnings**

Style sources: `project-file` 13, `canonical-qml` 27

| Layer | Source | Renderer | Classified on | Syms | Colours | Varies | Hatch | Grad | Labels | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| country | project-file | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| provinces | canonical-qml | categorizedSymbol | name_en | 11 | 14 | yes | no | no | no |  |
| districts | canonical-qml | singleSymbol | - | 1 | 1 | no | no | no | no |  |
| wards | canonical-qml | singleSymbol | - | 1 | 1 | no | no | no | no |  |
| landuse | canonical-qml | categorizedSymbol | fclass | 22 | 16 | yes | no | no | no |  |
| admin_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| places_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| water_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| waterways | canonical-qml | singleSymbol | - | 1 | 1 | no | no | no | no |  |
| protected_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| natural_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| roads | project-file | categorizedSymbol | fclass | 27 | 6 | yes | no | no | no |  |
| railways | canonical-qml | singleSymbol | - | 1 | 1 | no | no | no | no |  |
| buildings | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| traffic_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| transport_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| pois_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| places_of_worship_areas | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| places_points | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| pois_points | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| traffic_points | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| transport_points | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| natural_points | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| places_of_worship_points | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| stands | canonical-qml | categorizedSymbol | status | 5 | 12 | yes | no | no | no |  |
| vungu_cemeteries | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| vungu_waste_management | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| vungu_farm_cadastre | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| vungu_parcels | canonical-qml | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| vungu_proposed_peri_urban_zones | project-file | categorizedSymbol | zone | 12 | 15 | yes | no | no | yes | style id resolved via alias (vungu_proposed_peri_urban_zones) |
| vungu_beyond_peri_urban_zones | project-file | categorizedSymbol | settlement | 7 | 10 | yes | no | no | no |  |
| gweru_beyond_periurban_zones | project-file | categorizedSymbol | settlement | 7 | 10 | yes | no | no | no |  |
| gweru_chiefdoms | project-file | categorizedSymbol | chief | 4 | 7 | yes | no | no | no |  |
| gweru_health_centres | project-file | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| gweru_peri_urban_zone | project-file | categorizedSymbol | zone | 12 | 15 | yes | no | no | no |  |
| gweru_rivers | project-file | singleSymbol | - | 1 | 1 | no | no | no | no |  |
| gweru_rural_farms | project-file | graduatedSymbol | area_ha | 4 | 5 | yes | no | no | yes |  |
| gweru_rural_planning_boundary | project-file | singleSymbol | - | 1 | 2 | yes | no | no | no |  |
| proposed_peri_urban_zones | project-file | categorizedSymbol | zone | 12 | 15 | yes | no | no | yes |  |
| zimbabwe | project-file | singleSymbol | - | 1 | 2 | yes | no | no | no |  |

## Reading this table

- **Source** is the file the symbology came from: `project-file` (the .qgs QGIS
  Server serves), `qml-sidecar` / `canonical-qml` (exported QML), `qml-env-dir`
  (`$QGIS_QML_DIR`), or `default` when nothing was found.
- **Varies** is the check that matters: a `categorizedSymbol` or
  `graduatedSymbol` renderer must emit more than one colour, otherwise the
  classification reached MapLibre as a flat style.
- **Fallback** rows render, but with the flat default symbol rather than the
  council's authored symbology. They are the rows to fix first.

A live cross-check against QGIS Server `GetLegendGraphic` needs QGIS Server
running (`npm run qgis:up`) and is not part of this offline pass.
