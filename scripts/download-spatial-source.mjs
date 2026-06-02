#!/usr/bin/env node
// scripts/download-spatial-source.mjs
//
// Fetches the two GeoPackage source files used by setup-spatial.mjs.
// Run this BEFORE setup-spatial.mjs on a fresh machine that needs to
// (re-)import the spatial layers into PostGIS.
//
//   node scripts/download-spatial-source.mjs
//
// The files are NOT in git (they total ~1.47 GB). Host them wherever
// you like — GitHub Release attachment, S3, Cloudflare R2, OneDrive
// shareable link — and set these env vars:
//
//   ZIMBABWE_GPKG_URL  https://.../zimbabwe.gpkg          (~1.47 GB)
//   VUNGU_GPKG_URL     https://.../Vungu_RDC_Master_Plan.gpkg (~2.7 MB)
//
// Skip a file by leaving its URL unset and the script will print a
// reminder rather than fail.
//
// Re-running is safe: if the destination file already exists with a
// non-zero size, the download is skipped. Pass --force to redownload.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request } from 'node:https'
import { request as httpRequest } from 'node:http'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DATA = join(ROOT, 'data')
const FORCE = process.argv.includes('--force')

const TARGETS = [
  { name: 'zimbabwe.gpkg',              url: process.env.ZIMBABWE_GPKG_URL },
  { name: 'Vungu_RDC_Master_Plan.gpkg', url: process.env.VUNGU_GPKG_URL },
]

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function downloadOne(url, dest, maxRedirects = 5) {
  return new Promise((resolveDl, rejectDl) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? request : httpRequest
    const req = lib(url, { method: 'GET' }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (maxRedirects <= 0) {
          rejectDl(new Error(`Too many redirects for ${url}`))
          return
        }
        const next = new URL(res.headers.location, url).toString()
        res.resume()
        downloadOne(next, dest, maxRedirects - 1).then(resolveDl, rejectDl)
        return
      }
      if (res.statusCode !== 200) {
        rejectDl(new Error(`HTTP ${res.statusCode} for ${url}`))
        res.resume()
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let got = 0
      let lastTick = Date.now()
      const tmp = dest + '.part'
      const out = createWriteStream(tmp)
      res.on('data', (chunk) => {
        got += chunk.length
        const now = Date.now()
        if (now - lastTick > 500) {
          const pct = total ? `${((got / total) * 100).toFixed(1)}%` : ''
          process.stdout.write(`\r  ${fmtBytes(got)} / ${fmtBytes(total)} ${pct}     `)
          lastTick = now
        }
      })
      res.pipe(out)
      out.on('finish', () => {
        out.close()
        process.stdout.write(`\r  done: ${fmtBytes(got)}              \n`)
        try {
          if (existsSync(dest)) unlinkSync(dest)
          renameSync(tmp, dest)
        } catch (e) {
          rejectDl(e)
          return
        }
        resolveDl()
      })
      out.on('error', rejectDl)
    })
    req.on('error', rejectDl)
    req.end()
  })
}

async function main() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true })

  let downloaded = 0
  let skipped = 0
  let missing = 0

  for (const t of TARGETS) {
    const dest = join(DATA, t.name)
    if (!t.url) {
      console.log(`SKIP ${t.name}: no URL set (export ZIMBABWE_GPKG_URL or VUNGU_GPKG_URL)`)
      missing++
      continue
    }
    if (existsSync(dest) && !FORCE) {
      const size = statSync(dest).size
      if (size > 0) {
        console.log(`SKIP ${t.name}: exists (${fmtBytes(size)}). Pass --force to redownload.`)
        skipped++
        continue
      }
    }
    console.log(`GET  ${t.name}\n  ${t.url}`)
    try {
      await downloadOne(t.url, dest)
      downloaded++
    } catch (err) {
      console.error(`FAIL ${t.name}: ${err.message}`)
      process.exitCode = 1
    }
  }

  console.log('')
  console.log(`Summary: downloaded=${downloaded} skipped=${skipped} missing-url=${missing}`)
  if (missing > 0) {
    console.log('To configure the URLs, host the files (GitHub Release / S3 / etc.) and run again with:')
    console.log('  ZIMBABWE_GPKG_URL=https://... VUNGU_GPKG_URL=https://... node scripts/download-spatial-source.mjs')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
