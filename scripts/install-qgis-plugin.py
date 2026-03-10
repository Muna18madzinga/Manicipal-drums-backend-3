#!/usr/bin/env python3
"""
QGIS Plugin Installation Script
This script helps install the Vungu QGIS plugin properly
"""

import os
import sys
import zipfile
import shutil
from pathlib import Path

def find_qgis_plugin_paths():
    """Find possible QGIS plugin paths"""
    paths = []
    
    # Common QGIS plugin locations
    home = Path.home()
    
    # Windows paths
    if os.name == 'nt':
        paths.extend([
            home / "AppData" / "Roaming" / "QGIS" / "QGIS3" / "profiles" / "default" / "python" / "plugins",
            home / "AppData" / "Roaming" / "QGIS" / "QGIS3" / "profiles" / "default" / "python" / "plugins",
        ])
    # Linux/Mac paths
    else:
        paths.extend([
            home / ".local" / "share" / "QGIS" / "QGIS3" / "profiles" / "default" / "python" / "plugins",
            home / ".qgis3" / "python" / "plugins",
        ])
    
    # Filter existing paths
    existing_paths = [p for p in paths if p.exists()]
    return existing_paths

def install_plugin(zip_path, plugin_name="qgis-plugin"):
    """Install plugin from zip to QGIS plugins directory"""
    
    # Find QGIS plugin directories
    plugin_paths = find_qgis_plugin_paths()
    
    if not plugin_paths:
        print("❌ No QGIS plugin directories found!")
        print("Please make sure QGIS is installed and has been run at least once.")
        return False
    
    print(f"Found {len(plugin_paths)} QGIS plugin directory/ies:")
    for i, path in enumerate(plugin_paths):
        print(f"  {i+1}. {path}")
    
    # Use the first available path
    target_dir = plugin_paths[0]
    plugin_dir = target_dir / plugin_name
    
    print(f"\n📦 Installing plugin to: {plugin_dir}")
    
    # Remove existing plugin if it exists
    if plugin_dir.exists():
        print(f"🗑️  Removing existing plugin...")
        shutil.rmtree(plugin_dir)
    
    # Extract zip file
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(target_dir)
        
        print(f"✅ Plugin installed successfully!")
        print(f"📍 Location: {plugin_dir}")
        print(f"\n🔄 Please restart QGIS to see the plugin.")
        print(f"   The plugin should appear in:")
        print(f"   Plugins → Vungu Portal")
        
        return True
        
    except Exception as e:
        print(f"❌ Error installing plugin: {e}")
        return False

def main():
    if len(sys.argv) < 2:
        print("Usage: python install-qgis-plugin.py <path-to-zip>")
        sys.exit(1)
    
    zip_path = sys.argv[1]
    
    if not os.path.exists(zip_path):
        print(f"❌ Zip file not found: {zip_path}")
        sys.exit(1)
    
    print(f"🔧 Installing QGIS plugin from: {zip_path}")
    success = install_plugin(zip_path)
    
    if success:
        print("\n🎉 Installation completed!")
    else:
        print("\n💥 Installation failed!")
        sys.exit(1)

if __name__ == "__main__":
    main()
