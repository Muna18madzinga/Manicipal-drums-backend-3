/**
 * Identity / document verification.
 *
 * Same shape as paymentDriver.js — a verifier interface, with a working
 * 'manual' implementation (operator marks pass/fail), an AI verifier
 * ('claude', vision model via src/services/aiClient.js) and provider stubs
 * (Smile ID, Onfido) that throw NOT_IMPLEMENTED until configured.
 *
 * Verifier contract:
 *   verify({ doc, fileBuffer })
 *     → {
 *         status:      'verified' | 'rejected' | 'under_review',
 *         confidence:  number in [0,1] | null,
 *         provider:    string,
 *         payload:     object,
 *         notes:       string | null,   // human-readable reason (shown to citizen)
 *         extracted: { name?, idNumber?, dob?, expiry? }  // optional
 *       }
 *
 * The route layer never inspects the raw provider response except to
 * persist it for audit; downstream business rules read only `status`
 * and the optional `extracted` fields.
 */

const aiClient = require('./aiClient')

const NOT_IMPLEMENTED = (verifier) => {
  const e = new Error(`Document verifier ${verifier} is not implemented yet.`)
  e.code = 'verifier_not_implemented'
  return e
}

// Human-readable description of each document kind, fed to the vision model
// so it can judge whether the uploaded image is the *right* kind of document.
const DOC_KIND_LABELS = {
  national_id:          'a Zimbabwean national identity card (metal/plastic ID)',
  passport:             'a passport identity page',
  drivers_licence:      "a driver's licence card",
  proof_of_residence:   'a proof of residence (utility bill, lease, or council letter)',
  title_deed:           'a property title deed',
  company_registration: 'a company registration certificate',
  tax_clearance:        'a tax clearance certificate',
  other:                'a supporting document',
}

// ════════════════════════════════════════════════════════════════════
// Manual verifier — staff approve through /documents/:id/verify.
// verify() is a no-op that leaves the doc in 'under_review' so a human
// can review.
// ════════════════════════════════════════════════════════════════════
const manualVerifier = {
  name: 'manual',
  async verify({ doc }) {
    return {
      status: 'under_review',
      confidence: null,
      provider: 'manual',
      payload: { note: 'Awaiting staff review' },
      extracted: {},
    }
  },
}

// ════════════════════════════════════════════════════════════════════
// Claude verifier — Anthropic vision model via src/services/aiClient.js.
//
// Workflow (as the council set it): the AI checks the document FIRST, then it
// is always handed to internal staff for further review. The AI is a triage
// assistant, never the final approver — so every uploaded document lands in
// 'under_review' (the staff queue) carrying an AI *recommendation* a human
// can act on:
//
//   recommendation 'pass'      — legible + the expected kind of document
//   recommendation 'fail'      — illegible/blank/blurry, or the wrong document
//   recommendation 'uncertain' — AI low-confidence, unreadable response, PDF,
//                                or the AI is not configured/reachable
//
// A staff member makes the final verified / rejected decision via
// POST /documents/:id/verify. Extracted name / ID number / DOB are surfaced
// so the officer does not have to retype them.
//
// AI_VERIFY_THRESHOLD tunes the confidence floor for a 'pass'
// recommendation (default 0.7).
// ════════════════════════════════════════════════════════════════════
const PASS_FLOOR = Number(process.env.AI_VERIFY_THRESHOLD || 0.7)

function clampConfidence(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

const claudeVerifier = {
  name: 'claude',
  async verify({ doc, fileBuffer }) {
    const kindLabel = DOC_KIND_LABELS[doc.doc_kind] || 'a supporting document'

    // The vision model cannot read PDFs — hand straight to a human.
    if (!/^image\//.test(doc.mime_type || '')) {
      return {
        status: 'under_review',
        confidence: null,
        provider: 'claude',
        payload: { recommendation: 'uncertain', skipped: 'non_image', mime: doc.mime_type },
        notes: 'Document received. A council officer will review this file type.',
        extracted: {},
      }
    }

    const prompt = [
      `You are a document-verification assistant for a municipal planning office.`,
      `The applicant uploaded an image that is supposed to be ${kindLabel}.`,
      `Look at the image and respond with ONLY a JSON object, no prose, using this exact shape:`,
      `{"legible": boolean, "is_expected_document": boolean, "document_seen": string,`,
      ` "name": string|null, "id_number": string|null, "date_of_birth": string|null,`,
      ` "confidence": number, "reason": string}`,
      `Rules:`,
      `- "legible" is true only if the image is clear enough to read the key details (not blank, blurry, cropped or too dark).`,
      `- "is_expected_document" is true only if what you see really is ${kindLabel}.`,
      `- "confidence" is between 0 and 1.`,
      `- Put any holder name, ID/registration number and date of birth (YYYY-MM-DD) you can read into the matching fields, else null.`,
      `- "reason" is one short sentence a citizen can understand.`,
    ].join('\n')

    let raw
    try {
      raw = await aiClient.analyzeImage({
        buffer: fileBuffer,
        mimeType: doc.mime_type,
        prompt,
        maxTokens: 400,
      })
    } catch {
      raw = null
    }

    const parsed = aiClient.extractJson(raw)
    if (!parsed) {
      // AI unconfigured, unreachable, or returned something we can't parse —
      // still goes to staff, flagged as uncertain.
      return {
        status: 'under_review',
        confidence: null,
        provider: 'claude',
        payload: { recommendation: 'uncertain', ai_raw: raw || null, parsed: false, model: 'claude' },
        notes: 'Document received and queued for a council officer to review.',
        extracted: {},
      }
    }

    const confidence = clampConfidence(parsed.confidence)
    const extracted = {
      name:     typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : null,
      idNumber: typeof parsed.id_number === 'string' && parsed.id_number.trim() ? parsed.id_number.trim() : null,
      dob:      /^\d{4}-\d{2}-\d{2}$/.test(parsed.date_of_birth || '') ? parsed.date_of_birth : null,
    }
    const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : null

    // The AI only *recommends*; staff make the final call. Status is always
    // under_review so the document reaches the officer queue.
    let recommendation
    let notes
    if (parsed.legible === false) {
      recommendation = 'fail'
      notes = `Automatic check: the image looks hard to read${reason ? ' — ' + reason : ''}. ` +
              'A council officer will review it; you may also upload a clearer copy.'
    } else if (parsed.is_expected_document === false) {
      recommendation = 'fail'
      notes = `Automatic check: this may not be ${kindLabel}${reason ? ' — ' + reason : ''}. ` +
              'A council officer will review it.'
    } else if (confidence == null || confidence >= PASS_FLOOR) {
      recommendation = 'pass'
      notes = 'Automatic check passed. Your document is now with a council officer for final review.'
    } else {
      recommendation = 'uncertain'
      notes = 'Automatic check complete. A council officer will confirm your document shortly.'
    }

    return {
      status: 'under_review',
      confidence,
      provider: 'claude',
      payload: { recommendation, reason, ai: parsed },
      notes,
      extracted,
    }
  },
}

const smileIdVerifier = {
  name: 'smile_id',
  async verify() { throw NOT_IMPLEMENTED('smile_id') },
}
const onfidoVerifier = {
  name: 'onfido',
  async verify() { throw NOT_IMPLEMENTED('onfido') },
}

const VERIFIERS = {
  manual:    manualVerifier,
  claude:    claudeVerifier,
  smile_id:  smileIdVerifier,
  onfido:    onfidoVerifier,
}

function getVerifier(name) {
  const v = VERIFIERS[String(name || 'manual').toLowerCase()]
  if (!v) {
    const e = new Error(`Unknown verifier: ${name}`)
    e.code = 'unknown_verifier'
    throw e
  }
  return v
}

module.exports = { VERIFIERS, getVerifier, NOT_IMPLEMENTED }
