/**
 * Editable public-site content (CMS) for the council pages.
 *
 *   GET    /api/site-content            Public: list every stored page override
 *   GET    /api/site-content/:slug      Public: one stored page override
 *   PUT    /api/site-content/:slug      Admin:  upsert a page override
 *   DELETE /api/site-content/:slug      Admin:  reset a page back to the bundled default
 *
 * The frontend bundles a default ("seed") for every page, so the public site
 * always renders even with this table empty. A row here is an OVERRIDE that the
 * frontend layers on top of its seed. The IT Admin edits these rows to change
 * the static-website content that used to live on vungurdc.org.zw.
 *
 * Body shape stored in site_content.body (JSONB):
 *   { eyebrow?: string, intro?: string, blocks: Block[] }
 * `title` is also stored as a column for cheap listing.
 */

const { requireAdmin } = require('../middleware/jwtAuth')

// Slug: lower-case letters, digits and dashes only. Keeps the key tidy and
// stops anyone smuggling odd characters into the primary key.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

function rowDTO(row) {
  return {
    slug:      row.slug,
    title:     row.title,
    body:      row.body || {},
    updatedAt: row.updated_at,
  }
}

async function siteContentRoutes(fastify) {
  // ── Public: list all stored overrides ────────────────────────────────────
  fastify.get('/site-content', async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT slug, title, body, updated_at
           FROM public.site_content
          ORDER BY slug`
      )
      return rows.map(rowDTO)
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to list site content')
      return reply.code(500).send({ success: false, error: 'Failed to load content' })
    }
  })

  // ── Public: one stored override ──────────────────────────────────────────
  fastify.get('/site-content/:slug', async (request, reply) => {
    const { slug } = request.params
    if (!SLUG_RE.test(slug)) {
      return reply.code(400).send({ success: false, error: 'invalid_slug' })
    }
    try {
      const { rows } = await fastify.pg.query(
        `SELECT slug, title, body, updated_at
           FROM public.site_content
          WHERE slug = $1`,
        [slug]
      )
      if (!rows.length) {
        // No override stored — the frontend uses its bundled default.
        return reply.code(404).send({ success: false, error: 'not_found' })
      }
      return rowDTO(rows[0])
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to fetch site content')
      return reply.code(500).send({ success: false, error: 'Failed to load content' })
    }
  })

  // ── Admin: upsert a page override ────────────────────────────────────────
  fastify.put('/site-content/:slug', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { slug } = request.params
    if (!SLUG_RE.test(slug)) {
      return reply.code(400).send({ success: false, error: 'invalid_slug' })
    }

    const { title, body } = request.body || {}
    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
      return reply.code(400).send({ success: false, error: 'invalid_title' })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ success: false, error: 'invalid_body' })
    }
    // Guard against pathologically large payloads.
    if (JSON.stringify(body).length > 200_000) {
      return reply.code(413).send({ success: false, error: 'body_too_large' })
    }

    try {
      const { rows } = await fastify.pg.query(
        `INSERT INTO public.site_content (slug, title, body, updated_by)
              VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (slug) DO UPDATE
              SET title = EXCLUDED.title,
                  body  = EXCLUDED.body,
                  updated_by = EXCLUDED.updated_by
         RETURNING slug, title, body, updated_at`,
        [slug, title.trim(), JSON.stringify(body), request.user?.id ?? null]
      )
      return rowDTO(rows[0])
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to save site content')
      return reply.code(500).send({ success: false, error: 'Failed to save content' })
    }
  })

  // ── Admin: reset a page back to the bundled default ──────────────────────
  fastify.delete('/site-content/:slug', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { slug } = request.params
    if (!SLUG_RE.test(slug)) {
      return reply.code(400).send({ success: false, error: 'invalid_slug' })
    }
    try {
      await fastify.pg.query('DELETE FROM public.site_content WHERE slug = $1', [slug])
      return { success: true }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to reset site content')
      return reply.code(500).send({ success: false, error: 'Failed to reset content' })
    }
  })
}

module.exports = { siteContentRoutes }
