#!/usr/bin/env python3
"""
Mock WFS Layer Publisher Script
For testing when QGIS is not available
"""

import sys
import json
import argparse
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description='Mock WFS layer publisher for testing')
    parser.add_argument('--project', required=True, help='Path to QGIS project file')
    parser.add_argument('--layers', help='Comma-separated list of layer names')
    parser.add_argument('--all-layers', action='store_true', help='Publish all vector layers')
    parser.add_argument('--verbose', action='store_true')
    
    args = parser.parse_args()
    
    project_path = Path(args.project)
    
    if not project_path.exists():
        print(f"❌ Project file not found: {project_path}")
        sys.exit(1)
    
    print(f"✅ Loaded project: {project_path}")
    
    # Mock layer publishing
    if args.all_layers:
        # Mock publishing all layers
        published_layers = ['gweru_rural_planning_boundary', 'zimbabwe', 'gcc_boundary']
        print(f"🎯 Publishing ALL {len(published_layers)} vector layers for WFS")
    else:
        # Mock publishing specific layers
        if args.layers:
            published_layers = [layer.strip() for layer in args.layers.split(',')]
        else:
            published_layers = []
        print(f"🎯 Publishing {len(published_layers)} specific layers for WFS")
    
    # Simulate publishing process
    for layer_name in published_layers:
        print(f"✅ Published layer for WFS: {layer_name}")
    
    # Add project-level WFS properties
    print("✅ Added project-level WFS properties")
    
    # Save project (mock)
    print("💾 Saved project with WFS publishing changes")
    
    # Output results
    print("\n" + "="*60)
    print("📊 WFS PUBLISHING RESULTS")
    print("="*60)
    print(f"Total layers attempted: {len(published_layers)}")
    print(f"Successfully published: {len(published_layers)}")
    print(f"Failed to publish: 0")
    print(f"Success rate: 100.0%")
    
    if published_layers:
        print(f"\n✅ Published layers:")
        for layer in published_layers:
            print(f"   - {layer}")
    
    # Output JSON result for the Node.js parser to consume
    result = {
        "success": True,
        "published": published_layers,
        "failed": [],
        "total_attempted": len(published_layers),
        "success_rate": 100.0,
        "details": f"Successfully published {len(published_layers)} layers"
    }
    
    print(json.dumps(result))
    sys.exit(0)

if __name__ == '__main__':
    main()
