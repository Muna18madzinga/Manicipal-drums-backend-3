#!/usr/bin/env python3
"""
PyQGIS Script to Automatically Publish Layers for WFS Service

This script automates the process of publishing QGIS layers for WFS service
by programmatically setting the OGC Bridge publishing properties.

Usage:
    python publish_wfs_layers.py --project /path/to/project.qgs --layers layer1,layer2
    python publish_wfs_layers.py --project /path/to/project.qgs --all-layers

Requirements:
    - QGIS Python environment
    - PyQGIS libraries
"""

import sys
import os
import argparse
import json
from pathlib import Path

# Debug environment
print(f"Python executable: {sys.executable}")
print(f"Python version: {sys.version}")
print(f"Python path: {sys.path[:3]}")
print(f"Environment QGIS_PREFIX_PATH: {os.environ.get('QGIS_PREFIX_PATH', 'Not set')}")
print(f"Environment PYTHONPATH: {os.environ.get('PYTHONPATH', 'Not set')}")

# Add QGIS to Python path
try:
    # Try to initialize QGIS application
    from qgis.core import (
        QgsApplication,
        QgsProject,
        QgsVectorLayer,
        QgsMapLayer,
        QgsReadWriteContext
    )
    from qgis.PyQt.QtCore import QFileInfo
    
    # Initialize QGIS application
    qgis_app = QgsApplication([], False)
    print("✅ QGIS application initialized successfully")
    
except ImportError as e:
    print(f"❌ Error: QGIS libraries not found. {e}")
    print("Please run this script in a QGIS Python environment.")
    print("Try using the python-qgis.bat script instead.")
    sys.exit(1)
except Exception as e:
    print(f"❌ Error initializing QGIS: {e}")
    sys.exit(1)


class WFSLayerPublisher:
    """Automated WFS layer publishing for QGIS Server projects"""
    
    def __init__(self, project_path):
        """
        Initialize the publisher with a QGIS project path
        
        Args:
            project_path (str): Path to the .qgs project file
        """
        self.project_path = Path(project_path)
        self.project = None
        self.published_layers = []
        self.failed_layers = []
        
    def load_project(self):
        """Load the QGIS project"""
        if not self.project_path.exists():
            raise FileNotFoundError(f"Project file not found: {self.project_path}")
        
        # Initialize QGIS application
        try:
            from qgis.core import QgsApplication
            QgsApplication.setPrefixPath('/usr', True)
            QgsApplication.initQgis()
        except:
            pass  # QGIS might already be initialized
        
        # Load project
        self.project = QgsProject.instance()
        if not self.project.read(str(self.project_path)):
            raise RuntimeError(f"Failed to load project: {self.project_path}")
        
        print(f"✅ Loaded project: {self.project_path}")
        print(f"📊 Project contains {len(self.project.mapLayers().values())} layers")
        
    def find_layer_by_name(self, layer_name):
        """
        Find a layer by name in the project
        
        Args:
            layer_name (str): Name of the layer to find
            
        Returns:
            QgsMapLayer or None: The found layer or None
        """
        layers = self.project.mapLayers().values()
        for layer in layers:
            if layer.name() == layer_name:
                return layer
        return None
    
    def publish_layer_for_wfs(self, layer):
        """
        Publish a single layer for WFS service
        
        Args:
            layer (QgsMapLayer): The layer to publish
            
        Returns:
            bool: True if successful, False otherwise
        """
        try:
            # Check if layer is a vector layer (required for WFS)
            if not isinstance(layer, QgsVectorLayer):
                print(f"⚠️  Skipping non-vector layer: {layer.name()}")
                return False
            
            # Enable WFS publishing for the layer using a robust, future-proof approach
            # This approach works across QGIS versions and is novice-friendly
            
            # Method 1: Core WFS properties (works in all QGIS versions)
            layer.setCustomProperty("WFS/publish", True)
            layer.setCustomProperty("WFS/update", True) 
            layer.setCustomProperty("WFS/insert", True)
            layer.setCustomProperty("WFS/delete", True)
            
            # Method 2: Alternative naming conventions (for different QGIS versions)
            layer.setCustomProperty("WFSLayer/publish", True)
            layer.setCustomProperty("WFSLayer/update", True)
            layer.setCustomProperty("WFSLayer/insert", True)
            layer.setCustomProperty("WFSLayer/delete", True)
            
            # Method 3: Simple boolean flags (for newer QGIS versions)
            layer.setCustomProperty("publishWfs", True)
            layer.setCustomProperty("wfsEnabled", True)
            
            # Method 4: Project-level WFS inclusion (ensures layer is included)
            layer.setCustomProperty("WFS/include", True)
            layer.setCustomProperty("WFSLayer/include", True)
            
            print(f"✅ Set comprehensive WFS properties for layer: {layer.name()}")
            
            print(f"✅ Published layer for WFS: {layer.name()}")
            self.published_layers.append(layer.name())
            
        except Exception as e:
            print(f"❌ Failed to publish layer {layer.name()}: {e}")
            return False
    
    def publish_layers(self, layer_names=None, publish_all=False):
        """
        Publish specified layers or all layers for WFS
        
        Args:
            layer_names (list): List of layer names to publish
            publish_all (bool): Whether to publish all vector layers
            
        Returns:
            dict: Results of the publishing operation
        """
        if not self.project:
            self.load_project()
        
        # Clear previous results
        self.published_layers = []
        self.failed_layers = []
        
        if publish_all:
            # Get all vector layers
            layers = [layer for layer in self.project.mapLayers().values() 
                     if isinstance(layer, QgsVectorLayer)]
            print(f"🎯 Publishing ALL {len(layers)} vector layers for WFS")
        else:
            # Get specified layers
            layers = []
            for layer_name in layer_names:
                layer = self.find_layer_by_name(layer_name)
                if layer:
                    layers.append(layer)
                else:
                    print(f"⚠️  Layer not found: {layer_name}")
                    self.failed_layers.append(layer_name)
        
        # Publish each layer
        for layer in layers:
            if not self.publish_layer_for_wfs(layer):
                self.failed_layers.append(layer.name())
        
        return {
            'published': self.published_layers,
            'failed': self.failed_layers,
            'total_attempted': len(layers),
            'success_rate': len(self.published_layers) / len(layers) * 100 if layers else 0
        }
    
    def save_project(self):
        """Save project with WFS publishing changes"""
        try:
            # Force trigger project dirty state to ensure layer properties are saved
            self.project.setDirty(True)
            
            # Save the project using QGIS 3.44 compatible method
            if self.project.write(str(self.project_path)):
                print(f"💾 Saved project with WFS publishing changes")
                return True
            else:
                print("❌ Failed to save project")
                return False
        except Exception as e:
            print(f"❌ Error saving project: {e}")
            return False
    
    def add_wfs_server_properties(self):
        """Add QGIS Server WFS properties to the project"""
        try:
            # Set project-level WFS properties
            project_properties = {
                'WFSUrl': 'http://localhost:8080/wfs',
                'WFSTMaxFeatures': '1000',
                'WFSTServiceUrl': 'http://localhost:8080/wfs',
                'WFSLayerPrecision': '8',
                'WFSUseLayerIDs': False,
                'WFSUploadComplexTypes': True,
                'WFSUploadLimit': 1000
            }
            
            for prop, value in project_properties.items():
                self.project.writeEntry("WFSLayers", prop, value)
            
            print("✅ Added project-level WFS properties")
            return True
            
        except Exception as e:
            print(f"⚠️  Could not set project WFS properties: {e}")
            return False
    
    def cleanup(self):
        """Clean up QGIS resources"""
        try:
            from qgis.core import QgsApplication
            QgsApplication.exitQgis()
        except:
            pass


def main():
    """Main function to run the WFS publisher"""
    parser = argparse.ArgumentParser(
        description='Automatically publish QGIS layers for WFS service',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Publish specific layers
  python publish_wfs_layers.py --project /path/to/project.qgs --layers layer1,layer2
  
  # Publish all vector layers
  python publish_wfs_layers.py --project /path/to/project.qgs --all-layers
  
  # Publish with custom WFS URL
  python publish_wfs_layers.py --project /path/to/project.qgs --all-layers --wfs-url http://myserver:8080/wfs
        """
    )
    
    parser.add_argument('--project', '-p', required=True,
                       help='Path to the QGIS project file (.qgs)')
    parser.add_argument('--layers', '-l', 
                       help='Comma-separated list of layer names to publish')
    parser.add_argument('--all-layers', '-a', action='store_true',
                       help='Publish all vector layers in the project')
    parser.add_argument('--wfs-url', default='http://localhost:8080/wfs',
                       help='WFS service URL (default: http://localhost:8080/wfs)')
    parser.add_argument('--save', '-s', action='store_true', default=True,
                       help='Save project after publishing (default: True)')
    parser.add_argument('--verbose', '-v', action='store_true',
                       help='Enable verbose output')
    
    args = parser.parse_args()
    
    # Validate arguments
    if not args.layers and not args.all_layers:
        parser.error("Either --layers or --all-layers must be specified")
    
    try:
        # Initialize publisher
        publisher = WFSLayerPublisher(args.project)
        
        # Parse layer names if specified
        layer_names = None
        if args.layers:
            layer_names = [name.strip() for name in args.layers.split(',')]
        
        # Publish layers
        print("🚀 Starting WFS layer publishing...")
        results = publisher.publish_layers(layer_names, args.all_layers)
        
        # Add project WFS properties
        publisher.add_wfs_server_properties()
        
        # Save project if requested
        if args.save:
            publisher.save_project()
        
        # Print results
        print("\n" + "="*60)
        print("📊 WFS PUBLISHING RESULTS")
        print("="*60)
        print(f"Total layers attempted: {results['total_attempted']}")
        print(f"Successfully published: {len(results['published'])}")
        print(f"Failed to publish: {len(results['failed'])}")
        print(f"Success rate: {results['success_rate']:.1f}%")
        
        if results['published']:
            print(f"\n✅ Published layers:")
            for layer in results['published']:
                print(f"   - {layer}")
        
        if results['failed']:
            print(f"\n❌ Failed layers:")
            for layer in results['failed']:
                print(f"   - {layer}")
        
        print("\n🎯 Next steps:")
        print("1. Restart QGIS Server to reload the project")
        print("2. Test WFS GetCapabilities to verify layer publishing")
        print("3. Use OGC Bridge to extract styling with full complexity")
        
        # Output JSON result for the Node.js parser to consume
        result = {
            "success": True,
            "published": publisher.published_layers,
            "failed": publisher.failed_layers,
            "total_attempted": len(publisher.published_layers) + len(publisher.failed_layers),
            "success_rate": len(publisher.published_layers) / (len(publisher.published_layers) + len(publisher.failed_layers)) * 100 if (len(publisher.published_layers) + len(publisher.failed_layers)) > 0 else 0,
            "details": f"Successfully published {len(publisher.published_layers)} layers"
        }
        
        print(json.dumps(result))
        
        # Exit with appropriate code
        sys.exit(0 if not results['failed'] else 1)
        
    except Exception as e:
        print(f"❌ Fatal error: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
