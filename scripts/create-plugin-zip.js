const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

async function createPluginZip() {
  const pluginPath = path.join(__dirname, '../../vungu-integration');
  const zipPath = path.join(__dirname, '../vungu-qgis-plugin.zip');
  
  console.log('Plugin path:', pluginPath);
  console.log('Zip path:', zipPath);
  
  // Check if plugin directory exists
  if (!fs.existsSync(pluginPath)) {
    throw new Error(`Plugin directory not found: ${pluginPath}`);
  }
  
  // Create a write stream
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  
  return new Promise((resolve, reject) => {
    output.on('close', () => {
      console.log(`Plugin zip created: ${archive.pointer()} bytes`);
      resolve();
    });
    
    archive.on('error', (err) => {
      reject(err);
    });
    
    // Pipe archive to output
    archive.pipe(output);
    
    // Add the entire vungu-integration directory as 'vungu-integration' root
    console.log('Adding plugin directory to archive...');
    archive.directory(pluginPath, 'vungu-integration');
    
    // Finalize the archive
    archive.finalize();
  });
}

// Run if called directly
if (require.main === module) {
  createPluginZip()
    .then(() => {
      console.log('Plugin zip created successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error creating plugin zip:', error);
      process.exit(1);
    });
}

module.exports = { createPluginZip };
