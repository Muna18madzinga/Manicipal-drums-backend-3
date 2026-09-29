/**
 * Generate supervisor review rectification summary as .docx
 * Run: node scripts/generate-supervisor-summary-docx.js
 */
const fs = require('fs')
const path = require('path')
const { Document, Packer, Paragraph, TextRun, HeadingLevel, BulletedList, LevelFormat } = require('docx')

async function main() {
  const doc = new Document({
    styles: {
      default: { document: { styles: [{ id: 'Normal', run: { font: 'Calibri', size: 22 } }] } },
    },
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          heading: HeadingLevel.TITLE,
          children: [new TextRun({ text: 'VunguGIS / SpartialIQ — Supervisor Review Rectification', bold: true })],
        }),
        new Paragraph({
          children: [new TextRun({ text: 'Date: 23 September 2026', italics: true })],
        }),
        new Paragraph({
          children: [new TextRun('Scope: database normalisation (3NF), endpoint auth hardening, migration allowlist drift, SRID/SSOT documentation.')],
        }),

        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('1. Database normalisation (3NF)')] }),
        new Paragraph({ children: [new TextRun('Applied as migration 126_3nf_normalization.sql (renumbered from undocumented 078_3nf to avoid colliding with 078_missing_gist_indexes).')] }),
        new Paragraph({ children: [new TextRun('Delivered:')] }),
        new Paragraph({ children: [new TextRun('• Reference tables: ref_stand_statuses, ref_scale_categories, ref_use_scales, ref_zone_types, ref_application_statuses')] }),
        new Paragraph({ children: [new TextRun('• stands.ward_fid FK to PostGIS wards + status_code / use_scale_code FKs')] }),
        new Paragraph({ children: [new TextRun('• zone_type_cache + view v_stands (3NF-safe)')] }),
        new Paragraph({ children: [new TextRun('• development_applications status CHECK')] }),
        new Paragraph({ children: [new TextRun('• user_profiles (1:1 with users) separating profile from auth')] }),
        new Paragraph({ children: [new TextRun('• Migration 127_zone_id_int_contract.sql — INTEGER zone_id_int FK to proposed_peri_urban_zones (fixes UUID vs serial mismatch)')] }),

        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('2. HIGH security findings (unguarded mutating APIs)')] }),
        new Paragraph({ children: [new TextRun('All of the following now require JWT + role admin or gis_officer (or STAFF_ROLES where noted):')] }),
        new Paragraph({ children: [new TextRun('• WFS: POST /api/wfs/publish, publish-all, publish-and-style; DELETE /api/wfs/cache')] }),
        new Paragraph({ children: [new TextRun('• Dynamic layers: POST /api/dynamic-layers/layers/:layerName/qml-style')] }),
        new Paragraph({ children: [new TextRun('• Spatial: POST /layers, /layers/:id/features, /layers/:id/qml-style; POST /query (staff); GET metadata/coordinate-points (auth)')] }),
        new Paragraph({ children: [new TextRun('• Application status history: GET /api/applications/:appId/status-history → STAFF_ROLES')] }),

        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('3. Migration allowlist drift')] }),
        new Paragraph({ children: [new TextRun('Added to scripts/migrate-render.js so fresh production deploys create runtime-dependent objects:')] }),
        new Paragraph({ children: [new TextRun('• 079_filter_buildings_to_council_buffer.sql')] }),
        new Paragraph({ children: [new TextRun('• 080_stands_tile_view.sql')] }),
        new Paragraph({ children: [new TextRun('• 112_zones_master_view.sql')] }),
        new Paragraph({ children: [new TextRun('• 113_zones_master_columns.sql')] }),
        new Paragraph({ children: [new TextRun('• 126_3nf_normalization.sql')] }),
        new Paragraph({ children: [new TextRun('• 127_zone_id_int_contract.sql')] }),
        new Paragraph({ children: [new TextRun('This prevents silent empty tiles (42P01 → 204) for zones_master / stands on greenfield hosts.')] }),

        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('4. SRID / spatial query')] }),
        new Paragraph({ children: [new TextRun('• spatialLayers.js JSDoc corrected: GEOM_SRID is 4326 (legacy 900914 note only).')] }),
        new Paragraph({ children: [new TextRun('• spatial POST /query validates bbox and documents 4326 storage SRID.')] }),

        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('5. Other supervisor items')] }),
        new Paragraph({ children: [new TextRun('• POST /ogc/cache/clear → admin/gis_officer')] }),
        new Paragraph({ children: [new TextRun('• Planner notification stubs → requireAuth')] }),
        new Paragraph({ children: [new TextRun('• land-use-management zone_id OpenAPI type → integer (aligned with development_matrix)')] }),
        new Paragraph({ children: [new TextRun('• docs/SSOT-database.md — canonical table map')] }),
        new Paragraph({ children: [new TextRun('• docs/DATA-DUMP-REPORT.md — rebuild limits (OSM dump still required)')] }),

        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('6. Residual (honest)')] }),
        new Paragraph({ children: [new TextRun('OSM/ward basemap geometry remains dump/GPKG-sourced (~94% of DB size). Schema rebuilds from migrations; map pixels still need a published basemap restore step.')] }),

        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('7. How to verify')] }),
        new Paragraph({ children: [new TextRun('1. Apply migrations 112–113, 126–127 locally if not applied.')] }),
        new Paragraph({ children: [new TextRun('2. Restart API; confirm unauthenticated POST /api/wfs/publish → 401/403.')] }),
        new Paragraph({ children: [new TextRun('3. Confirm GET /api/applications/:id/status-history without token → 401.')] }),
        new Paragraph({ children: [new TextRun('4. SELECT * FROM ref_stand_statuses; SELECT * FROM user_profiles LIMIT 1; \\d v_stands')] }),
      ],
    }],
  })

  const out = path.join(__dirname, '..', 'docs', 'Supervisor-Review-Rectification-Summary.docx')
  const buf = await Packer.toBuffer(doc)
  fs.writeFileSync(out, buf)
  console.log('Wrote', out)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
