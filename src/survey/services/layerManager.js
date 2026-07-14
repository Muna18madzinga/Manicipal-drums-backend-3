// Layer Management System for Interactive GeoPDF
// Provides scale-dependent rendering and visibility control

/**
 * Layer Manager for Vector GeoPDF
 * Handles visibility, interactivity, and scale-dependent rendering
 */
class LayerManager {
  constructor() {
    this.layers = new Map();
    this.visibility = new Map();
    this.interactivity = new Map();
    this.scaleDependency = new Map();
    this.currentScale = 1000;
  }

  /**
   * Add layer with configuration options
   */
  addLayer(name, features, options = {}) {
    const layer = {
      name,
      features,
      visible: options.visible !== false,
      interactive: options.interactive !== false,
      scaleDependent: options.scaleDependent || false,
      minScale: options.minScale || 0,
      maxScale: options.maxScale || Infinity,
      style: options.style || this.getDefaultStyle(name),
      zIndex: options.zIndex || this.getNextZIndex(),
      opacity: options.opacity || 1.0,
      labelScale: options.labelScale || 1000
    };

    this.layers.set(name, layer);
    this.visibility.set(name, layer.visible);
    this.interactivity.set(name, layer.interactive);
    this.scaleDependency.set(name, layer.scaleDependent);

    console.log(`[LayerManager] ✅ Added layer '${name}' with ${features.length} features`);
    return layer;
  }

  /**
   * Get default style for layer type
   */
  getDefaultStyle(layerName) {
    const styles = {
      parcels: {
        lineWidth: 0.5,
        strokeColor: '#000000',
        fillColor: 'transparent',
        lineCap: 'round',
        lineJoin: 'round',
        dashPattern: []
      },
      beacons: {
        symbol: 'circle',
        size: 8,
        fillColor: '#FFFFFF',
        strokeColor: '#000000',
        strokeWidth: 1.5,
        lineWidth: 1.5
      },
      roadReserves: {
        lineWidth: 0.3,
        strokeColor: '#666666',
        dashPattern: [2, 2],
        lineCap: 'butt',
        fillColor: 'transparent'
      },
      grid: {
        lineWidth: 0.1,
        strokeColor: '#CCCCCC',
        dashPattern: [1, 2],
        lineCap: 'butt',
        opacity: 0.5
      },
      labels: {
        font: 'Helvetica',
        fontSize: 8,
        color: '#000000',
        backgroundColor: '#FFFFFF',
        backgroundOpacity: 0.8,
        padding: 1,
        haloColor: '#FFFFFF',
        haloWidth: 0.5
      },
      surveyLines: {
        lineWidth: 0.8,
        strokeColor: '#FF0000',
        dashPattern: [5, 3],
        lineCap: 'round'
      }
    };

    return styles[layerName] || styles.parcels;
  }

  /**
   * Get next z-index for layer ordering
   */
  getNextZIndex() {
    let maxIndex = 0;
    for (const layer of this.layers.values()) {
      if (layer.zIndex > maxIndex) {
        maxIndex = layer.zIndex;
      }
    }
    return maxIndex + 1;
  }

  /**
   * Update layer visibility
   */
  setLayerVisibility(layerName, visible) {
    if (this.layers.has(layerName)) {
      this.layers.get(layerName).visible = visible;
      this.visibility.set(layerName, visible);
      console.log(`[LayerManager] 📋 Layer '${layerName}' visibility: ${visible}`);
    }
  }

  /**
   * Get layer visibility
   */
  isLayerVisible(layerName) {
    return this.visibility.get(layerName) || false;
  }

  /**
   * Update current map scale
   */
  setCurrentScale(scale) {
    this.currentScale = scale;
  }

  /**
   * Determine if layer should render at current scale
   */
  shouldRenderLayer(layer, scale = this.currentScale) {
    return layer.visible && 
           scale >= layer.minScale && 
           scale <= layer.maxScale &&
           (!layer.scaleDependent || this.isLabelVisible(scale));
  }

  /**
   * Determine if labels should be visible at scale
   */
  isLabelVisible(scale) {
    // Labels visible at scales larger than 1:5000
    return scale <= 5000;
  }

  /**
   * Get layers sorted by z-index
   */
  getSortedLayers() {
    return Array.from(this.layers.values())
      .sort((a, b) => a.zIndex - b.zIndex);
  }

  /**
   * Get visible layers at current scale
   */
  getVisibleLayers(scale = this.currentScale) {
    return this.getSortedLayers()
      .filter(layer => this.shouldRenderLayer(layer, scale));
  }

  /**
   * Get features for layer at current scale
   */
  getLayerFeatures(layerName, scale = this.currentScale) {
    const layer = this.layers.get(layerName);
    if (!layer) return [];

    if (!this.shouldRenderLayer(layer, scale)) {
      return [];
    }

    // Apply scale-dependent filtering
    if (layer.scaleDependent && layer.name === 'labels') {
      return this.getScaleDependentFeatures(layer, scale);
    }

    return layer.features;
  }

  /**
   * Get scale-dependent features (e.g., labels)
   */
  getScaleDependentFeatures(layer, scale) {
    const features = [];
    
    layer.features.forEach(feature => {
      if (this.shouldShowFeatureLabel(feature, scale)) {
        features.push({
          ...feature,
          style: this.getScaleDependentStyle(feature, scale)
        });
      }
    });

    return features;
  }

  /**
   * Determine if feature label should show at scale
   */
  shouldShowFeatureLabel(feature, scale) {
    if (!feature.properties || !feature.properties.area_m2) {
      return scale <= 2000; // Default threshold
    }

    const area = feature.properties.area_m2;
    const minScaleForLabel = this.calculateMinLabelScale(area);
    
    return scale <= minScaleForLabel;
  }

  /**
   * Calculate minimum scale for label visibility based on feature area
   */
  calculateMinLabelScale(area) {
    if (area < 100) return 500;      // Very small parcels
    if (area < 500) return 1000;     // Small parcels
    if (area < 2000) return 2000;    // Medium parcels
    if (area < 10000) return 3000;   // Large parcels
    return 5000;                        // Very large parcels
  }

  /**
   * Get scale-dependent style for feature
   */
  getScaleDependentStyle(feature, scale) {
    const baseStyle = feature.style || this.getDefaultStyle(feature.layer);
    const area = feature.properties.area_m2 || 0;

    // Calculate optimal font size
    let fontSize = Math.max(6, Math.min(14, Math.sqrt(area) / 8));
    
    // Scale adjustment
    const scaleFactor = Math.log10(scale) / 3;
    const adjustedSize = fontSize * scaleFactor;
    
    // Minimum readable size
    fontSize = Math.max(4, adjustedSize);

    return {
      ...baseStyle,
      fontSize,
      showBackground: scale <= 2000,
      showHalo: scale <= 1000
    };
  }

  /**
   * Toggle layer visibility
   */
  toggleLayer(layerName) {
    const currentVisibility = this.isLayerVisible(layerName);
    this.setLayerVisibility(layerName, !currentVisibility);
    return !currentVisibility;
  }

  /**
   * Get layer statistics
   */
  getLayerStats(layerName) {
    const layer = this.layers.get(layerName);
    if (!layer) return null;

    const visibleFeatures = this.getLayerFeatures(layerName);
    const totalFeatures = layer.features.length;

    return {
      name: layerName,
      totalFeatures,
      visibleFeatures: visibleFeatures.length,
      visibility: layer.visible,
      interactive: layer.interactive,
      scaleDependent: layer.scaleDependent,
      zIndex: layer.zIndex
    };
  }

  /**
   * Get all layer statistics
   */
  getAllStats() {
    const stats = {};
    
    for (const layerName of this.layers.keys()) {
      stats[layerName] = this.getLayerStats(layerName);
    }

    return stats;
  }

  /**
   * Export layer configuration for persistence
   */
  exportConfiguration() {
    const config = {
      layers: {},
      visibility: {},
      currentScale: this.currentScale
    };

    for (const [name, layer] of this.layers) {
      config.layers[name] = {
        visible: layer.visible,
        interactive: layer.interactive,
        opacity: layer.opacity,
        zIndex: layer.zIndex
      };
      config.visibility[name] = this.visibility.get(name);
    }

    return config;
  }

  /**
   * Import layer configuration
   */
  importConfiguration(config) {
    if (config.layers) {
      for (const [name, layerConfig] of Object.entries(config.layers)) {
        const layer = this.layers.get(name);
        if (layer) {
          layer.visible = layerConfig.visible;
          layer.interactive = layerConfig.interactive;
          layer.opacity = layerConfig.opacity;
          layer.zIndex = layerConfig.zIndex;
          this.visibility.set(name, layerConfig.visible);
          this.interactivity.set(name, layerConfig.interactive);
        }
      }
    }

    if (config.currentScale) {
      this.setCurrentScale(config.currentScale);
    }

    console.log('[LayerManager] 📥 Imported layer configuration');
  }

  /**
   * Clear all layers
   */
  clearLayers() {
    this.layers.clear();
    this.visibility.clear();
    this.interactivity.clear();
    this.scaleDependency.clear();
    console.log('[LayerManager] 🗑️ Cleared all layers');
  }
}

export { LayerManager };
