#!/usr/bin/env node
/**
 * Make the Ed25519 key pair VunGIS uses to sign SurveyPro launch tokens, and check one.
 *
 *   node scripts/generate-launch-keys.js                 write .launch-key.pem (private, git-ignored) and print the PUBLIC key
 *   node scripts/generate-launch-keys.js --check         sign a token with the configured key and verify it with the matching public key
 *
 * The private key stays here and is never printed. The public key is what SurveyPro is given (its VUNGIS_LAUNCH_PUBLIC_KEY); it
 * cannot be used to make a token, only to check one. Point VunGIS at the private key with
 * SURVEYPRO_LAUNCH_KEY_FILE=.launch-key.pem (or SURVEYPRO_LAUNCH_PRIVATE_KEY for a host that keeps secrets in its environment).
 * To rotate: generate a new pair, give SurveyPro the new public key, change SURVEYPRO_LAUNCH_KEY_ID.
 */
require('dotenv').config({ quiet: true })
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const launch = require('../src/lib/launchToken')

const FILE = path.join(__dirname, '..', '.launch-key.pem')

if (process.argv.includes('--check')) {
  const priv = launch.loadPrivateKey({ ...process.env, SURVEYPRO_LAUNCH_KEY_FILE: process.env.SURVEYPRO_LAUNCH_KEY_FILE || FILE })
  if (!priv) { console.error('no private key: run this without --check first, or set SURVEYPRO_LAUNCH_KEY_FILE'); process.exit(1) }
  const pub = crypto.createPublicKey(priv)
  const { token } = launch.sign({ sub: 'check@example.org' }, { privateKey: priv, kid: launch.keyId() })
  const claims = launch.verify(token, { publicKey: pub })
  console.log(`ok: signed and verified a token (kid ${launch.keyId()}, expires in ${claims.exp - claims.iat} s)`)
  process.exit(0)
}

if (fs.existsSync(FILE)) { console.error(`${path.basename(FILE)} already exists: not overwriting it (delete it to rotate)`); process.exit(1) }
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
fs.writeFileSync(FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
console.log(`private key written to ${path.basename(FILE)} (not printed)`)
console.log('\npublic key, to give to SurveyPro (VUNGIS_LAUNCH_PUBLIC_KEY):\n')
console.log(publicKey.export({ type: 'spki', format: 'pem' }))
