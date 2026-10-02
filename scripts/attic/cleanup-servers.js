/**
 * Cleanup old server files
 * Run this script to remove redundant server files after consolidating to server.js
 */

const fs = require('fs')
const path = require('path')

const oldServerFiles = [
  'src/index.js',
  'src/server.ts', 
  'src/server-minimal.ts',
  'src/server-simple.js',
  'src/server-working.js',
  'fixed-server.js',
  'minimal-server.js'
]

console.log('🧹 Cleaning up old server files...')

oldServerFiles.forEach(file => {
  const filePath = path.join(__dirname, file)
  
  if (fs.existsSync(filePath)) {
    try {
      // Create backup directory if it doesn't exist
      const backupDir = path.join(__dirname, 'server-backups')
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true })
      }
      
      // Move file to backup directory instead of deleting
      const backupPath = path.join(backupDir, path.basename(file))
      fs.renameSync(filePath, backupPath)
      console.log(`✅ Moved ${file} to server-backups/`)
    } catch (error) {
      console.error(`❌ Error moving ${file}:`, error.message)
    }
  } else {
    console.log(`⚠️  File not found: ${file}`)
  }
})

console.log('\n🎉 Server cleanup completed!')
console.log('📁 Old files moved to: server-backups/')
console.log('🚀 New unified server: server.js')
console.log('\nTo run the server:')
console.log('  npm run dev')
console.log('  npm start')
