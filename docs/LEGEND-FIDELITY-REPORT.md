# Legend fidelity cross-check

Generated 2026-10-03T13:24:27.209Z by `scripts/verify-legend-fidelity.mjs`.

QGIS Server: `http://localhost:8080` (NOT reachable — fetch failed)
Backend bridge: `http://localhost:3000/api/ogc/wms/legend/:layer`

This is the evidence for the paper's fallback claim: QGIS renders the
authored symbology through WMS `GetLegendGraphic`, and `GetStyles` returns the
SLD QGIS itself publishes, which can be diffed against what the client-side
translation sends to MapLibre.

**0/10 legends rendered as PNG · 0 via the backend bridge · 0 SLDs retrieved · 0 with palette drift · 10 failed**

| Layer | Legend PNG | Via bridge | SLD rules | SLD colours | Our symbols | Our colours | Verdict |
|---|---|---|---|---|---|---|---|
| gweru_beyond_periurban_zones | no (0) | degraded | 0 | 0 | 7 | 10 | **FAIL** |
| gweru_chiefdoms | no (0) | degraded | 0 | 0 | 4 | 7 | **FAIL** |
| gweru_health_centres | no (0) | degraded | 0 | 0 | 1 | 2 | **FAIL** |
| gweru_peri_urban_zone | no (0) | degraded | 0 | 0 | 12 | 15 | **FAIL** |
| gweru_rivers | no (0) | degraded | 0 | 0 | 1 | 1 | **FAIL** |
| gweru_rural_farms | no (0) | degraded | 0 | 0 | 4 | 5 | **FAIL** |
| gweru_rural_planning_boundary | no (0) | degraded | 0 | 0 | 1 | 2 | **FAIL** |
| proposed_peri_urban_zones | no (0) | degraded | 0 | 0 | 12 | 15 | **FAIL** |
| roads | no (0) | degraded | 0 | 0 | 27 | 6 | **FAIL** |
| zimbabwe | no (0) | degraded | 0 | 0 | 1 | 2 | **FAIL** |

## How to read a failure

- **Legend PNG = no** — QGIS Server cannot render that layer. Almost always the
  layer's PostGIS source is unreachable from the container: check
  `docker compose -f docker-compose.qgis.yml logs qgis-server` and that
  `qgis-projects/pg_service.docker.conf` points at the right dbname.
- **Via bridge = degraded** — the backend answered JSON instead of a PNG, which is
  its documented behaviour while QGIS Server is down. The web map falls back to
  client-side vector styling; no user-visible breakage, lower fidelity.
- **drift** — QGIS's own SLD names a colour that never reaches the client. This is
  the case that justifies keeping `GetLegendGraphic`: the paint expression is an
  approximation, and the legend is what makes it defensible.
