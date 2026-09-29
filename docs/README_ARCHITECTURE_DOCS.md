# Architecture & Zimbabwe expectations docs

| # | File | Contents |
|---|------|----------|
| 1 | `01_Conceptual_Model.docx` | Business concepts & relationships (RTCP/RDC/health/survey context) |
| 2 | `02_Logical_Model.docx` | Entities, keys, 3NF, permit states, security logic |
| 3 | `03_Physical_Model.docx` | Postgres/PostGIS schemas, migrations, indexes, probes |
| 4 | `04_Expected_Needed_And_Delivered_Zimbabwe.docx` | Zim sources → needs → what we built |
| — | `DATABASE.md` / `DATABASE_Data_Dictionary.docx` | **Data dictionary** — every schema, table, column, key and lookup, generated from the live catalogue |
| — | `SSOT-database.md` | Which table is canonical for each concept (after migrations 130–132) |
| — | `Vungu_Zimbabwe_Role_Expectations.docx` | ≥5 paragraphs per role vs Zimbabwe law/practice |
| — | `Vungu_Council_Flows_Manual_Plain_English.docx` | Full flows + narrations |

Regenerate:

- `npm run db:dictionary` — data dictionary (Markdown + Word) from `DATABASE_URL`
- `node scripts/generate-four-architecture-docs.js` and `node scripts/generate-zimbabwe-role-expectations-docx.js`

Note: documents 01–03 were written before migrations 130–132 (they still describe
`user_profiles` and the `public.ref_*` tables). The data dictionary is the current
physical model.
