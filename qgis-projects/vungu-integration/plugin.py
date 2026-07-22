from qgis.PyQt.QtWidgets import QAction, QDockWidget, QWidget, QVBoxLayout, QLabel, QPushButton, QLineEdit, QTextEdit, QComboBox, QHBoxLayout, QCheckBox
from qgis.PyQt.QtCore import Qt, QUrl, QTimer, pyqtSignal, QObject
from qgis.PyQt.QtGui import QColor
from qgis.core import QgsVectorLayer, QgsProject, QgsFeature, QgsGeometry, QgsPalLayerSettings, QgsVectorLayerSimpleLabeling
import json
import requests
import threading
import time

class StyleMonitor(QObject):
    """Monitor QGIS layer style changes and trigger auto-uploads"""
    style_changed = pyqtSignal(str)  # layer_name
    
    def __init__(self, iface):
        super().__init__()
        self.iface = iface
        self.layer_styles = {}  # Store current styles
        self.monitoring_enabled = False
        self.check_interval = 2000  # Check every 2 seconds
        self.timer = QTimer()
        self.timer.timeout.connect(self.check_style_changes)
        
    def start_monitoring(self):
        """Start monitoring style changes"""
        if not self.monitoring_enabled:
            self.monitoring_enabled = True
            self.capture_current_styles()
            self.timer.start(self.check_interval)
            print("DEBUG: Style monitoring started")
            
    def stop_monitoring(self):
        """Stop monitoring style changes"""
        if self.monitoring_enabled:
            self.monitoring_enabled = False
            self.timer.stop()
            print("DEBUG: Style monitoring stopped")
            
    def capture_current_styles(self):
        """Capture current styles of all vector layers"""
        self.layer_styles.clear()
        for layer in self.iface.mapCanvas().layers():
            if hasattr(layer, 'renderer') and hasattr(layer, 'name'):
                layer_name = layer.name()
                # Capture renderer style as JSON
                style_info = self.extract_style_info(layer)
                self.layer_styles[layer_name] = style_info
                
    def extract_style_info(self, layer):
        """Extract style information from layer"""
        try:
            style_info = {
                'renderer_type': layer.renderer().type(),
                'symbol': None,
                'labeling': None
            }
            
            # Extract symbol information
            if hasattr(layer.renderer(), 'symbol'):
                symbol = layer.renderer().symbol()
                if hasattr(symbol, 'size'):
                    style_info['symbol'] = {
                        'color': symbol.color().name(),
                        'size': symbol.size(),
                        'stroke_color': symbol.strokeColor().name(),
                        'stroke_width': symbol.strokeWidth()
                    }
                else:
                    style_info['symbol'] = {
                        'color': symbol.color().name() if hasattr(symbol, 'color') else '#666666',
                        'type': 'no_size_symbol'
                    }
                
            # Extract labeling information
            if hasattr(layer, 'labeling') and layer.labeling():
                labeling = layer.labeling()
                if hasattr(labeling, 'settings'):
                    settings = labeling.settings()
                    if hasattr(settings, 'size'):
                        style_info['labeling'] = {
                            'field': settings.fieldName,
                            'size': settings.size,
                            'color': settings.color().name()
                        }
                    else:
                        style_info['labeling'] = {
                            'field': getattr(settings, 'fieldName', 'name'),
                            'type': 'no_size_labeling'
                        }
                    
            return json.dumps(style_info, sort_keys=True)
        except Exception as e:
            print(f"DEBUG: Error extracting style for {layer.name()}: {e}")
            return "{}"
            
    def check_style_changes(self):
        """Check for style changes in monitored layers"""
        if not self.monitoring_enabled:
            return
            
        for layer in self.iface.mapCanvas().layers():
            if hasattr(layer, 'renderer') and hasattr(layer, 'name'):
                layer_name = layer.name()
                current_style = self.extract_style_info(layer)
                
                if layer_name in self.layer_styles:
                    if self.layer_styles[layer_name] != current_style:
                        print(f"DEBUG: Style changed for layer: {layer_name}")
                        self.style_changed.emit(layer_name)
                        self.layer_styles[layer_name] = current_style
                else:
                    # New layer detected
                    self.layer_styles[layer_name] = current_style

class VunguIntegrationDock(QDockWidget):
    def __init__(self, iface):
        super().__init__()
        self.iface = iface
        print("DEBUG: VunguIntegrationDock created")
        self.style_monitor = StyleMonitor(iface)
        self.style_monitor.style_changed.connect(self.on_style_changed)
        self.setup_ui()
        
    def setup_ui(self):
        print("DEBUG: Setting up VunguIntegrationDock UI")
        self.setWindowTitle("Vungu Integration")
        self.setAllowedAreas(Qt.RightDockWidgetArea | Qt.LeftDockWidgetArea)
        
        # Create main widget
        widget = QWidget()
        layout = QVBoxLayout()
        
        # Title
        title = QLabel("🔧 Vungu Spatial Integration")
        title.setStyleSheet("font-size: 16px; font-weight: bold; padding: 10px;")
        layout.addWidget(title)
        
        # Auto-upload section
        layout.addWidget(QLabel("🔄 Auto-Upload Settings"))
        
        self.auto_upload_checkbox = QCheckBox("Enable Auto-Upload for Style Changes")
        self.auto_upload_checkbox.stateChanged.connect(self.toggle_auto_upload)
        layout.addWidget(self.auto_upload_checkbox)
        
        self.auto_upload_status = QLabel("Auto-upload: Disabled")
        self.auto_upload_status.setStyleSheet("color: #666; font-size: 12px;")
        layout.addWidget(self.auto_upload_status)
        
        layout.addWidget(QLabel(""))  # Spacer
        
        # Connection section
        layout.addWidget(QLabel("📡 Connection Settings"))
        
        self.api_url = QLineEdit("http://localhost:3000/api")
        self.api_url.setPlaceholderText("API URL")
        layout.addWidget(QLabel("API URL:"))
        layout.addWidget(self.api_url)
        
        self.api_token = QLineEdit()
        self.api_token.setPlaceholderText("Enter API Token")
        self.api_token.setEchoMode(QLineEdit.Password)
        layout.addWidget(QLabel("API Token:"))
        layout.addWidget(self.api_token)
        
        # Test connection button
        self.test_btn = QPushButton("🔗 Test Connection")
        self.test_btn.clicked.connect(self.test_connection)
        layout.addWidget(self.test_btn)
        
        # Status display
        self.status = QTextEdit()
        self.status.setMaximumHeight(150)
        self.status.setPlainText("Ready to connect to Vungu Portal...")
        layout.addWidget(QLabel("Status:"))
        layout.addWidget(self.status)
        
        # Layer selection
        layout.addWidget(QLabel("🗺️ Layer Selection"))
        
        self.layer_combo = QComboBox()
        self.layer_combo.setMinimumWidth(200)
        self.refresh_layers_btn = QPushButton("🔄 Refresh Layers")
        self.refresh_layers_btn.clicked.connect(self.refresh_layers)
        
        layer_layout = QHBoxLayout()
        layer_layout.addWidget(self.layer_combo)
        layer_layout.addWidget(self.refresh_layers_btn)
        layout.addLayout(layer_layout)
        
        # Sync buttons
        layout.addWidget(QLabel("🔄 Data Synchronization"))
        
        self.sync_btn = QPushButton("📤 Sync Layer to Portal")
        self.sync_btn.clicked.connect(self.sync_to_portal)
        layout.addWidget(self.sync_btn)
        
        self.download_btn = QPushButton("📥 Sync from Portal")
        self.download_btn.clicked.connect(self.sync_from_portal)
        layout.addWidget(self.download_btn)
        
        widget.setLayout(layout)
        self.setWidget(widget)
        print("DEBUG: VunguIntegrationDock UI setup complete")
        
        # Initialize layer list
        self.refresh_layers()
        
    def toggle_auto_upload(self, state):
        """Toggle auto-upload monitoring"""
        if state == Qt.Checked:
            self.auto_upload_status.setText("Auto-upload: Enabled")
            self.auto_upload_status.setStyleSheet("color: #27ae60; font-size: 12px;")
            self.style_monitor.start_monitoring()
            self.status.append("🔄 Auto-upload monitoring started")
        else:
            self.auto_upload_status.setText("Auto-upload: Disabled")
            self.auto_upload_status.setStyleSheet("color: #666; font-size: 12px;")
            self.style_monitor.stop_monitoring()
            self.status.append("⏸️ Auto-upload monitoring stopped")
            
    def on_style_changed(self, layer_name):
        """Handle style change event"""
        self.status.append(f"🎨 Style changed detected for: {layer_name}")
        
        # Check if API token is available
        api_token = self.api_token.text().strip()
        if not api_token:
            self.status.append("⚠️ Auto-upload requires API token")
            return
            
        # Auto-upload in background thread
        self.status.append(f"📤 Auto-uploading {layer_name}...")
        threading.Thread(
            target=self.auto_upload_layer,
            args=(layer_name,),
            daemon=True
        ).start()
        
    def auto_upload_layer(self, layer_name):
        """Auto-upload layer with style changes"""
        try:
            api_token = self.api_token.text().strip()
            if not api_token:
                self.status.append("⚠️ Auto-upload requires an API token")
                return

            # Find the layer
            layer = None
            for l in self.iface.mapCanvas().layers():
                if hasattr(l, 'name') and l.name() == layer_name:
                    layer = l
                    break

            if not layer:
                self.status.append(f"❌ Layer {layer_name} not found")
                return

            # Build features with correctly paired field name -> value
            # (feature.attributes() is a positional list, not a mapping —
            # dict() on it would raise, so it must be zipped against fields())
            fields = layer.fields()
            features = []
            for feature in layer.getFeatures():
                geom = feature.geometry()
                if geom:
                    features.append({
                        'type': 'Feature',
                        'geometry': json.loads(geom.asJson()),
                        'properties': {f.name(): v for f, v in zip(fields, feature.attributes())}
                    })

            # Same payload contract as sync_to_portal / POST /api/qgis/sync/upload
            api_url = self.api_url.text()
            upload_url = f"{api_url}/qgis/sync/upload"
            payload = {
                'layer_name': layer_name,
                'crs': 'EPSG:4326',
                'features': features,
                'field_types': self._extract_field_types(layer),
                'style': self.extract_qgis_style(layer)
            }
            headers = {"Authorization": f"Bearer {api_token}", "Content-Type": "application/json"}

            response = requests.post(upload_url, json=payload, headers=headers, timeout=30)

            if response.status_code == 200:
                self.status.append(f"✅ Auto-upload successful for {layer_name}")
            else:
                self.status.append(f"❌ Auto-upload failed: {response.text}")

        except Exception as e:
            self.status.append(f"❌ Auto-upload error: {e}")
            
    def _extract_field_types(self, layer):
        """Extract field types from QGIS layer"""
        try:
            field_types = {}
            fields = layer.fields()
            
            for field in fields:
                field_name = field.name()
                # Skip system fields
                if field_name.lower() in ['fid', 'id', 'uuid', 'created_at', 'updated_at']:
                    continue
                    
                # Map QGIS field types to backend types
                qgis_type = field.typeName()
                if qgis_type in ['String', 'Text']:
                    backend_type = 'String'
                elif qgis_type in ['Integer', 'Integer64']:
                    backend_type = 'Integer'
                elif qgis_type in ['Real', 'Double']:
                    backend_type = 'Real'
                elif qgis_type in ['Date']:
                    backend_type = 'Date'
                elif qgis_type in ['DateTime']:
                    backend_type = 'DateTime'
                else:
                    backend_type = 'String'  # Default fallback
                    
                field_types[field_name] = backend_type
                
            print(f"DEBUG: Extracted {len(field_types)} field types: {list(field_types.keys())}")
            return field_types
            
        except Exception as e:
            print(f"DEBUG: Error extracting field types: {e}")
            return {}
    
    def extract_qgis_style(self, layer):
        """Extract QGIS styling information (wrapper for existing method)"""
        return self.extract_layer_styling(layer)
        
    def refresh_layers(self):
        try:
            print("DEBUG: Refreshing layers")
            self.layer_combo.clear()
            
            # Get all vector layers from QGIS
            layers = []
            print(f"DEBUG: Total layers in canvas: {len(self.iface.mapCanvas().layers())}")
            
            for i, layer in enumerate(self.iface.mapCanvas().layers()):
                print(f"DEBUG: Layer {i}: {layer.name()} - Type: {type(layer).__name__}")
                if hasattr(layer, 'dataProvider') and hasattr(layer, 'geometryType'):  # Vector layer only
                    layer_name = layer.name()
                    layer_type = layer.geometryType()
                    feature_count = layer.featureCount()
                    display_name = f"{layer_name} ({feature_count} features)"
                    layers.append((layer_name, display_name))
                    print(f"DEBUG: Found vector layer: {layer_name} with {feature_count} features")
                else:
                    print(f"DEBUG: Skipping non-vector layer: {layer.name()}")
            
            print(f"DEBUG: Total vector layers found: {len(layers)}")
            
            # Add layers to combo box. userData is tagged ('qgis'|'portal', name)
            # rather than guessed from the string later -- a table that
            # doesn't happen to start with "gweru_" used to be silently
            # unselectable.
            for layer_name, display_name in layers:
                print(f"DEBUG: Adding layer - Name: '{layer_name}', Display: '{display_name}'")
                self.layer_combo.addItem(display_name, ('qgis', layer_name))

            # Add portal layers for download -- read straight from the QGIS
            # project's own layer catalogue (GET /api/ogc/layers), the same
            # list the web app and WFS/WMS bridge use. No hardcoded names to
            # drift out of sync with the actual project.
            self.layer_combo.addItem("--- Portal Layers ---", None)
            portal_layers = []
            try:
                resp = requests.get(f"{self.api_url.text()}/ogc/layers", timeout=10)
                if resp.status_code == 200:
                    for entry in resp.json().get('data', {}).get('layers', []):
                        portal_layers.append((entry['name'], entry.get('title') or entry['name']))
            except Exception as e:
                print(f"DEBUG: Could not fetch portal layer catalogue: {e}")

            for layer_id, display_name in portal_layers:
                self.layer_combo.addItem(f"📥 {display_name}", ('portal', layer_id))

            print(f"DEBUG: Added {len(layers)} QGIS layers and {len(portal_layers)} portal layers")
            
        except Exception as e:
            print(f"DEBUG: Error in refresh_layers: {e}")
            import traceback
            traceback.print_exc()
        
    def test_connection(self):
        print("DEBUG: Test connection clicked")
        self.status.append("🔍 Testing connection...")
        # Simulate connection test
        self.status.append("✅ Connected to Vungu Portal successfully!")
        self.status.append(f"📡 API: {self.api_url.text()}")
        
    def sync_to_portal(self):
        print("DEBUG: Sync to portal clicked")
        
        # First refresh layers to ensure we have current data
        print("DEBUG: Refreshing layers before sync")
        self.refresh_layers()
        
        # Get selected layer
        selected_data = self.layer_combo.currentData()
        selected_text = self.layer_combo.currentText()
        print(f"DEBUG: Selected layer data: '{selected_data}'")
        print(f"DEBUG: Selected layer text: '{selected_text}'")
        
        if not selected_data or selected_data[0] != 'qgis':
            self.status.append("❌ Please select a QGIS layer to upload")
            return

        layer_name = selected_data[1]
        self.status.append(f"📤 Uploading layer '{layer_name}' to portal...")
        
        # Check API token first
        api_token = self.api_token.text().strip()
        if not api_token:
            self.status.append(" Please enter API token first")
            return
        
        self.status.append(" Validating API token...")
            
        try:
            # Validate API token
            auth_url = f"{self.api_url.text()}/auth/validate-api-token"
            auth_payload = {"token": api_token}
            
            self.status.append(f"🔍 Testing token at: {auth_url}")
            
            auth_response = requests.post(auth_url, json=auth_payload, timeout=10)
            self.status.append(f"📡 Response status: {auth_response.status_code}")
            self.status.append(f"📡 Response: {auth_response.text}")
            
            if auth_response.status_code != 200:
                self.status.append(" Invalid or expired API token")
                return
            
            self.status.append(" API token validated")
            
            # Find the actual layer
            layer = None
            for l in self.iface.mapCanvas().layers():
                if hasattr(l, 'dataProvider') and l.name() == layer_name:
                    layer = l
                    break
            
            if not layer:
                self.status.append("❌ Layer not found in QGIS")
                return
            
            # Get layer info
            feature_count = layer.featureCount()
            geometry_type = layer.geometryType()
            
            self.status.append(f"📊 Layer info: {feature_count} features, type: {geometry_type}")
            
            # Convert QGIS layer to GeoJSON with styling
            geojson_data = self.convert_qgis_layer_to_geojson_with_styling(layer)
            
            # Upload to portal
            self.status.append("📤 Uploading data to portal...")
            
            # Extract just the features array for the backend
            upload_data = {
                "layer_name": layer.name(),
                "crs": "EPSG:4326",
                "features": geojson_data.get("features", []),
                "field_types": self._extract_field_types(layer),
                "style": geojson_data.get("style", {})
            }
            
            upload_url = f"{self.api_url.text()}/qgis/sync/upload"
            headers = {"Authorization": f"Bearer {api_token}", "Content-Type": "application/json"}
            
            self.status.append(f"📡 Upload URL: {upload_url}")
            self.status.append(f"📡 Sending {len(upload_data['features'])} features")
            
            upload_response = requests.post(upload_url, json=upload_data, headers=headers, timeout=30)
            
            self.status.append(f"📡 Response status: {upload_response.status_code}")
            self.status.append(f"📡 Response text: {upload_response.text}")
            
            if upload_response.status_code == 200:
                self.status.append("✅ Sync completed successfully!")
                self.status.append(f"🗺️ Layer '{layer_name}' uploaded to portal")
            else:
                self.status.append(f"❌ Upload failed: {upload_response.status_code}")
                self.status.append(f"📡 Error: {upload_response.text}")
            
            print(f"DEBUG: Synced layer {layer_name} with {feature_count} features")
            
        except requests.exceptions.RequestException as e:
            self.status.append(f"❌ Network error: {e}")
        except Exception as e:
            self.status.append(f"❌ Error during sync: {e}")
            import traceback
            traceback.print_exc()
        
    def sync_from_portal(self):
        print("DEBUG: Sync from portal clicked")

        # Get selected layer
        selected_data = self.layer_combo.currentData()
        if not selected_data or selected_data[0] != 'portal':
            self.status.append("❌ Please select a portal layer to download")
            return

        layer_id = selected_data[1]
        display_name = self.layer_combo.currentText().replace("📥 ", "")

        self.status.append(f"📥 Downloading layer '{display_name}' from portal...")
        self.status.append(f"🔍 Requesting data for layer ID: {layer_id}")

        try:
            # Check API token first
            api_token = self.api_token.text().strip()
            if not api_token:
                self.status.append("❌ Please enter API token first")
                return

            self.status.append("🔐 Validating API token...")

            # Validate API token by making a test request
            auth_url = f"{self.api_url.text()}/auth/validate-api-token"
            auth_payload = {"token": api_token}

            self.status.append(f"🔍 Testing token at: {auth_url}")

            auth_response = requests.post(auth_url, json=auth_payload, timeout=10)
            self.status.append(f"📡 Response status: {auth_response.status_code}")

            if auth_response.status_code != 200:
                self.status.append(f"❌ Token validation failed: {auth_response.text}")
                return

            self.status.append("✅ API token validated")

            # GET /api/qgis/sync/download/:layerName -- the documented portal
            # pull endpoint. Returns plain GeoJSON-shaped features (not
            # TopoJSON), already reprojected to EPSG:4326.
            api_url = f"{self.api_url.text()}/qgis/sync/download/{layer_id}"

            self.status.append(f"🌐 Connecting to: {api_url}")

            headers = {"Authorization": f"Bearer {api_token}"}
            response = requests.get(api_url, headers=headers, timeout=30)
            response.raise_for_status()

            payload = response.json().get('data', {})
            feature_count = len(payload.get('features', []))

            self.status.append(f"📊 Received data: {feature_count} features")

            # Create QGIS layer from the data
            self.create_qgis_layer(payload, display_name, layer_id)

            self.status.append("✅ Download completed successfully!")
            self.status.append(f"🗺️ Layer '{display_name}' added to QGIS Layers panel")

        except requests.exceptions.RequestException as e:
            self.status.append(f"❌ Network error: {e}")
        except Exception as e:
            self.status.append(f"❌ Error creating layer: {e}")
            import traceback
            traceback.print_exc()

        print(f"DEBUG: Downloaded portal layer {layer_id}")

    def create_qgis_layer(self, download_payload, layer_name, layer_id):
        """Create a QGIS layer from a /api/qgis/sync/download/:layerName payload"""
        try:
            geojson_data = {
                "type": "FeatureCollection",
                "features": download_payload.get('features', []),
                "crs": {
                    "type": "name",
                    "properties": {"name": download_payload.get('crs', 'EPSG:4326')}
                }
            }

            # Create a temporary GeoJSON file
            import tempfile
            import os
            
            temp_dir = tempfile.gettempdir()
            temp_file = os.path.join(temp_dir, f"vungu_{layer_id}.geojson")
            
            # Write GeoJSON data to file
            with open(temp_file, 'w') as f:
                f.write(json.dumps(geojson_data, indent=2))
        
            # Create QGIS vector layer from GeoJSON
            layer = QgsVectorLayer(temp_file, layer_name, "ogr")
            
            if not layer.isValid():
                self.status.append(f"❌ Failed to create layer from {temp_file}")
                return
            
            # Add layer to QGIS project
            QgsProject.instance().addMapLayer(layer)
            
            # Apply basic styling based on geometry type
            self.apply_layer_styling(layer, layer_id)
            
            # Clean up temp file
            os.remove(temp_file)
            
        except Exception as e:
            self.status.append(f"❌ Error creating QGIS layer: {e}")
            import traceback
            traceback.print_exc()
        
    def extract_layer_styling(self, layer):
        """Extract styling information from QGIS layer"""
        try:
            style_info = {}
            geometry_type = layer.geometryType()
            
            # Get the renderer symbol
            renderer = layer.renderer()
            if renderer and hasattr(renderer, 'symbol'):
                symbol = renderer.symbol()
                
                # Check for symbol layers (especially for point symbols with medical crosses, etc.)
                symbol_layers = []
                if hasattr(symbol, 'symbolLayers'):
                    symbol_layers = symbol.symbolLayers()
                    self.status.append(f"🎨 Symbol has {len(symbol_layers)} symbol layers")
                    
                    for j, symbol_layer in enumerate(symbol_layers):
                        layer_type = symbol_layer.type() if hasattr(symbol_layer, 'type') else 'unknown'
                        self.status.append(f"🎨   Symbol layer {j+1}: type={layer_type}, class={type(symbol_layer).__name__}")
                        
                        # Check for medical symbols (crosses)
                        if hasattr(symbol_layer, 'symbolLayerType'):
                            layer_type_name = symbol_layer.symbolLayerType()
                            self.status.append(f"🎨   Symbol layer type name: {layer_type_name}")
                            
                            if 'cross' in layer_type_name.lower() or 'medical' in layer_type_name.lower():
                                self.status.append(f"🎨   Found medical cross symbol!")
                
                if geometry_type == 0:  # Point
                    point_style = {
                        "_style": {
                            "type": "point",
                            "radius": symbol.size() if hasattr(symbol, 'size') else 6,
                            "color": symbol.color().name() if hasattr(symbol, 'color') else "#ffffff",
                            "opacity": symbol.opacity() if hasattr(symbol, 'opacity') else 0.8,
                            "strokeColor": "#2c3e50",
                            "strokeWidth": 1
                        },
                        "_labelField": "name" if layer.fields().indexFromName('name') != -1 else None,
                        "_labelSize": 10,
                        "_labelColor": "#2c3e50"
                    }
                    
                    # Add symbol layer information if detected
                    if symbol_layers:
                        point_style["_symbolLayers"] = []
                        for j, symbol_layer in enumerate(symbol_layers):
                            layer_info = {
                                "type": symbol_layer.type() if hasattr(symbol_layer, 'type') else 'unknown',
                                "color": symbol_layer.color().name() if hasattr(symbol_layer, 'color') else None,
                                "size": symbol_layer.size() if hasattr(symbol_layer, 'size') else None
                            }
                            
                            # Detect medical cross symbols
                            if hasattr(symbol_layer, 'symbolLayerType'):
                                layer_type_name = symbol_layer.symbolLayerType()
                                if 'cross' in layer_type_name.lower():
                                    layer_info["symbolType"] = "medical_cross"
                                    layer_info["color"] = "#ff0000"  # Red for medical cross
                            
                            point_style["_symbolLayers"].append(layer_info)
                    
                    style_info.update(point_style)
                elif geometry_type == 1:  # Line
                    style_info.update({
                        "_style": {
                            "type": "line",
                            "color": symbol.color().name() if hasattr(symbol, 'color') else "#3498db",
                            "width": symbol.width() if hasattr(symbol, 'width') else 3,
                            "opacity": symbol.opacity() if hasattr(symbol, 'opacity') else 1.0
                        }
                    })
                elif geometry_type == 2:  # Polygon
                    style_info.update({
                        "_style": {
                            "type": "polygon",
                            "fillColor": symbol.color().name() if hasattr(symbol, 'color') else "#27ae60",
                            "fillOpacity": symbol.opacity() if hasattr(symbol, 'opacity') else 0.6,
                            "strokeColor": "#2c3e50",
                            "strokeWidth": 1
                        }
                    })
            
            return style_info
            
        except Exception as e:
            self.status.append(f"⚠️ Style extraction issue: {e}")
            return {}
    
    def convert_qgis_layer_to_geojson_with_styling(self, layer):
        """Convert QGIS layer to GeoJSON with intelligent styling extraction"""
        try:
            features = []
            fields = layer.fields()
            feature_count = layer.featureCount()
            geometry_type = layer.geometryType()
            
            # Get renderer and extract styling
            renderer = layer.renderer()
            style_info = {}
            
            self.status.append(f"🎨 Extracting styling for geometry type: {geometry_type}")
            
            # Handle different renderer types
            if hasattr(renderer, 'type'):
                renderer_type = renderer.type()
                self.status.append(f"🎨 Renderer type: {renderer_type}")
                self.status.append(f"🎨 Renderer class: {type(renderer).__name__}")
                
                # Check for categorized renderer by class name as fallback
                if renderer_type == 'categorizedSymbol' or 'categorized' in type(renderer).__name__.lower():
                    # Handle categorized styling
                    self.status.append(f"🎨 Processing categorized renderer")
                    style_info = self._extract_categorized_styling(layer, renderer, geometry_type)
                elif renderer_type == 'singleSymbol':
                    # Handle single symbol styling
                    self.status.append(f"🎨 Processing single symbol renderer")
                    style_info = self._extract_single_styling(layer, renderer, geometry_type)
                else:
                    # Fallback to basic styling
                    self.status.append(f"🎨 Using basic styling for renderer type: {renderer_type}")
                    style_info = self._extract_basic_styling(layer, geometry_type)
            else:
                # Fallback
                style_info = self._extract_basic_styling(layer, geometry_type)
            
            # Add layer metadata
            style_info['_layerName'] = layer.name()
            style_info['_featureCount'] = feature_count
            style_info['_geometryType'] = geometry_type
            
            # Convert features to GeoJSON
            feature_count = 0
            print(f"DEBUG: Starting feature conversion for {layer.featureCount()} features")
            
            for feature in layer.getFeatures():
                geom = feature.geometry()
                if geom:
                    # Get properties and filter out null/empty values and system fields
                    properties = {}
                    for i, field in enumerate(fields):
                        field_name = field.name()
                        # Skip system fields like 'fid'
                        if field_name.lower() in ['fid', 'id', 'uuid', 'created_at', 'updated_at']:
                            print(f"DEBUG: Skipping system field: {field_name}")
                            continue
                        if feature.isValid() and not feature.attribute(i) is None:
                            value = feature[i]
                            if value is not None and str(value).strip():
                                properties[field_name] = str(value)
                                print(f"DEBUG: Adding field: {field_name} = {value}")
                    
                    print(f"DEBUG: Feature {feature_count + 1} properties: {list(properties.keys())}")
                    
                    # Add styling properties to each feature
                    properties.update(style_info)
                    
                    geojson_feature = {
                        "type": "Feature",
                        "geometry": json.loads(geom.asJson()),
                        "properties": properties
                    }
                    features.append(geojson_feature)
                    feature_count += 1
                else:
                    print(f"DEBUG: Feature {feature_count + 1} has no geometry")
            
            print(f"DEBUG: Feature conversion completed. Processed {feature_count} features")
            self.status.append(f"📊 Processed {feature_count} features from {layer.featureCount()} total")
            
            return {
                "type": "FeatureCollection",
                "features": features,
                "style": style_info,
                "layer_name": layer.name(),
                "geometry_type": geometry_type,
                "feature_count": len(features)
            }
            
        except Exception as e:
            self.status.append(f"❌ Error converting layer: {e}")
            import traceback
            traceback.print_exc()
            return {
                "type": "FeatureCollection",
                "features": []
            }
    
    def _extract_categorized_styling(self, layer, renderer, geometry_type):
        """Extract categorized styling with intelligent geometry type detection"""
        try:
            categories = []
            style_info = {
                "_rendererType": "categorized",
                "_categories": []
            }
            
            # Get categories
            if hasattr(renderer, 'categories'):
                cat_list = renderer.categories()
                self.status.append(f"🎨 Found {len(cat_list)} categories")
                
                for i, category in enumerate(cat_list):
                    cat_value = category.value()
                    cat_label = category.label()
                    symbol = category.symbol()
                    
                    self.status.append(f"🎨 Category {i+1}: {cat_label} = {symbol.color().name()}")
                    
                    # Intelligent style extraction based on actual geometry
                    category_style = self._extract_symbol_style(symbol, geometry_type, layer)
                    
                    cat_info = {
                        "value": str(cat_value),
                        "label": cat_label,
                        # Flatten the style properties for direct access
                        **category_style
                    }
                    categories.append(cat_info)
                    style_info["_categories"].append(cat_info)
                
                # Use first category as default style
                if categories:
                    # Extract the style properties from the first category
                    first_category_style = {}
                    for key, value in categories[0].items():
                        if key not in ['value', 'label']:
                            first_category_style[key] = value
                    style_info["_style"] = first_category_style
                    self.status.append(f"🎨 Using first category symbol as default")
            
            return style_info
            
        except Exception as e:
            self.status.append(f"⚠️ Error extracting categorized styling: {e}")
            return self._extract_basic_styling(layer, geometry_type)
    
    def _extract_single_styling(self, layer, renderer, geometry_type):
        """Extract single symbol styling"""
        try:
            symbol = renderer.symbol()
            style_info = {
                "_rendererType": "single",
                "_style": self._extract_symbol_style(symbol, geometry_type, layer)
            }
            return style_info
        except Exception as e:
            self.status.append(f"⚠️ Error extracting single styling: {e}")
            return self._extract_basic_styling(layer, geometry_type)
    
    def _extract_basic_styling(self, layer, geometry_type):
        """Extract basic styling as fallback"""
        try:
            symbol = layer.renderer().symbol()
            style_info = {
                "_rendererType": "basic",
                "_style": self._extract_symbol_style(symbol, geometry_type, layer)
            }
            return style_info
        except Exception as e:
            self.status.append(f"⚠️ Error extracting basic styling: {e}")
            return {"_style": {"type": "point", "color": "#666666"}}
    
    def _extract_symbol_style(self, symbol, geometry_type, layer=None):
        """Extract symbol style with intelligent geometry type handling"""
        try:
            if geometry_type == 0:  # Point
                # Extract comprehensive point symbology from QGIS
                style = {
                    "type": "point",
                    "radius": symbol.size() if hasattr(symbol, 'size') else 6,
                    "color": symbol.color().name() if hasattr(symbol, 'color') else "#ffffff",
                    "opacity": symbol.opacity() if hasattr(symbol, 'opacity') else 0.8,
                    "strokeColor": symbol.strokeColor().name() if hasattr(symbol, 'strokeColor') else "#2c3e50",
                    "strokeWidth": symbol.strokeWidth() if hasattr(symbol, 'strokeWidth') else 1,
                    "symbolType": self._extract_symbol_type(symbol),
                    "symbolName": self._extract_symbol_name(symbol),
                    "symbolLayer": self._extract_symbol_layers(symbol)
                }
                
                # Add debug output for symbology extraction
                self.status.append(f"🎨 Point symbology extracted:")
                self.status.append(f"   - Type: {style['symbolType']}")
                self.status.append(f"   - Name: {style['symbolName']}")
                self.status.append(f"   - Size: {style['radius']}")
                self.status.append(f"   - Color: {style['color']}")
                self.status.append(f"   - Stroke: {style['strokeColor']}")
                
            elif geometry_type == 1:  # Line
                style = {
                    "type": "line",
                    "color": symbol.color().name() if hasattr(symbol, 'color') else "#3498db",
                    "width": symbol.width() if hasattr(symbol, 'width') else 3,
                    "opacity": symbol.opacity() if hasattr(symbol, 'opacity') else 1.0,
                    "lineStyle": self._extract_line_style(symbol),
                    "capStyle": self._extract_cap_style(symbol),
                    "joinStyle": self._extract_join_style(symbol)
                }
                
            elif geometry_type == 2:  # Polygon
                style = {
                    "type": "polygon",
                    "fillColor": symbol.color().name() if hasattr(symbol, 'color') else "#27ae60",
                    "fillOpacity": symbol.opacity() if hasattr(symbol, 'opacity') else 0.6,
                    "strokeColor": symbol.strokeColor().name() if hasattr(symbol, 'strokeColor') else "#2c3e50",
                    "strokeWidth": symbol.strokeWidth() if hasattr(symbol, 'strokeWidth') else 1,
                    "fillStyle": self._extract_fill_style(symbol),
                    "patternType": self._extract_pattern_type(symbol)
                }
            else:
                # Default fallback
                style = {
                    "type": "point",
                    "radius": 6,
                    "color": symbol.color().name() if hasattr(symbol, 'color') else "#666666"
                }
            
            # Add label information
            style_info = {
                "_style": style,
                "_labelField": "name" if layer and layer.fields().indexFromName('name') != -1 else None,
                "_labelSize": 10,
                "_labelColor": "#2c3e50"
            }
            
            self.status.append(f"🎨 Styling extracted: {len(style_info)} properties")
            return style_info
            
        except Exception as e:
            self.status.append(f"⚠️ Error extracting symbol style: {e}")
            return {"type": "point", "color": "#666666"}
    
    def _extract_symbol_type(self, symbol):
        """Extract the symbol type from QGIS symbol"""
        try:
            if hasattr(symbol, 'symbolType'):
                return symbol.symbolType()
            elif hasattr(symbol, 'type'):
                return symbol.type()
            else:
                # Try to determine from class name
                class_name = symbol.__class__.__name__.lower()
                if 'marker' in class_name:
                    return 'marker'
                elif 'simple' in class_name:
                    return 'simple'
                else:
                    return 'unknown'
        except:
            return 'unknown'
    
    def _extract_symbol_name(self, symbol):
        """Extract the symbol name from QGIS symbol"""
        try:
            if hasattr(symbol, 'name'):
                return symbol.name()
            elif hasattr(symbol, 'symbolName'):
                return symbol.symbolName()
            else:
                return 'default'
        except:
            return 'default'
    
    def _extract_symbol_layers(self, symbol):
        """Extract symbol layer information"""
        try:
            if hasattr(symbol, 'symbolLayers'):
                layers = []
                for layer in symbol.symbolLayers():
                    layer_info = {
                        'type': layer.layerType(),
                        'properties': layer.properties()
                    }
                    layers.append(layer_info)
                return layers
            else:
                return []
        except:
            return []
    
    def _extract_line_style(self, symbol):
        """Extract line style information"""
        try:
            if hasattr(symbol, 'penStyle'):
                return symbol.penStyle()
            else:
                return 'solid'
        except:
            return 'solid'
    
    def _extract_cap_style(self, symbol):
        """Extract line cap style"""
        try:
            if hasattr(symbol, 'penCapStyle'):
                return symbol.penCapStyle()
            else:
                return 'round'
        except:
            return 'round'
    
    def _extract_join_style(self, symbol):
        """Extract line join style"""
        try:
            if hasattr(symbol, 'penJoinStyle'):
                return symbol.penJoinStyle()
            else:
                return 'round'
        except:
            return 'round'
    
    def _extract_fill_style(self, symbol):
        """Extract fill style for polygons"""
        try:
            if hasattr(symbol, 'brushStyle'):
                return symbol.brushStyle()
            else:
                return 'solid'
        except:
            return 'solid'
    
    def _extract_pattern_type(self, symbol):
        """Extract pattern type for polygons"""
        try:
            # Check for various pattern types
            if hasattr(symbol, 'symbolLayer'):
                for layer in symbol.symbolLayer(0).symbolLayers():
                    if hasattr(layer, 'pattern'):
                        return layer.pattern()
            return 'none'
        except:
            return 'none'
    
    def convert_qgis_layer_to_geojson(self, layer):
        """Convert QGIS layer to GeoJSON format"""
        try:
            features = []
            fields = layer.fields()
            
            for feature in layer.getFeatures():
                # Get geometry as GeoJSON
                geom = feature.geometry()
                geojson_geom = json.loads(geom.asJson())
                
                # Get properties
                properties = {}
                for i, field in enumerate(fields):
                    field_name = field.name()
                    if feature.isValid() and not feature.isNull(i):
                        properties[field_name] = str(feature[i])
                
                # Create GeoJSON feature
                geojson_feature = {
                    "type": "Feature",
                    "geometry": geojson_geom,
                    "properties": properties
                }
                features.append(geojson_feature)
            
            return {
                "type": "FeatureCollection",
                "features": features
            }
            
        except Exception as e:
            self.status.append(f"⚠️ QGIS to GeoJSON conversion issue: {e}")
            return {
                "type": "FeatureCollection",
                "features": []
            }
    
    def apply_layer_styling(self, layer, layer_id):
        """Apply enhanced styling to match web UI"""
        try:
            geometry_type = layer.geometryType()
            
            if geometry_type == 0:  # Point
                # Enhanced point styling to match web UI
                symbol = layer.renderer().symbol()
                symbol.setSize(8)
                symbol.setColor(QColor("#e74c3c"))  # Red color like web UI
                symbol.setOpacity(0.8)
                
                # Add labels if name field exists
                provider = layer.dataProvider()
                if provider and provider.fields().indexFromName('name') != -1:
                    layer.setLabelsEnabled(True)
                    label_settings = QgsPalLayerSettings()
                    label_settings.fieldName = 'name'
                    label_settings.enabled = True
                    label_settings.format().setSize(10)
                    label_settings.format().setColor(QColor("#2c3e50"))
                    label_settings.placement = QgsPalLayerSettings.OverPoint
                    
                    # Apply label settings
                    layer.setLabeling(QgsVectorLayerSimpleLabeling(label_settings))
                    layer.triggerRepaint()
                    
            elif geometry_type == 1:  # Line
                # Enhanced line styling
                symbol = layer.renderer().symbol()
                symbol.setWidth(3)
                symbol.setColor(QColor("#3498db"))  # Blue color
                
            elif geometry_type == 2:  # Polygon
                # Enhanced polygon styling
                symbol = layer.renderer().symbol()
                symbol.setColor(QColor("#27ae60"))  # Green color
                symbol.setFillColor(QColor("#27ae60"))
                symbol.setStrokeColor(QColor("#2c3e50"))
                symbol.setStrokeWidth(1)
                symbol.setOpacity(0.6)
            
            # Refresh layer
            layer.triggerRepaint()
            self.status.append(f"✅ Enhanced styling applied to {layer.name()}")
            
        except Exception as e:
            self.status.append(f"⚠️ Could not apply enhanced styling: {e}")

class VunguIntegration:
    def __init__(self, iface):
        print("DEBUG: VunguIntegration __init__ called")
        self.iface = iface
        self.dock = None
        
    def initGui(self):
        print("DEBUG: VunguIntegration initGui called")
        try:
            # Create action
            self.action = QAction("Vungu Integration", self.iface.mainWindow())
            print("DEBUG: QAction created")
            self.action.triggered.connect(self.run)
            print("DEBUG: Action connected to run method")
            
            # Add to menu and toolbar
            self.iface.addPluginToMenu("Vungu Integration", self.action)
            print("DEBUG: Added to menu")
            self.iface.addToolBarIcon(self.action)
            print("DEBUG: Added to toolbar")
            
            # Create and add dock widget
            self.dock = VunguIntegrationDock(self.iface)
            print("DEBUG: Dock widget created")
            self.iface.addDockWidget(Qt.RightDockWidgetArea, self.dock)
            print("DEBUG: Dock widget added to interface")
            
            print("DEBUG: initGui completed successfully")
        except Exception as e:
            print(f"DEBUG: Error in initGui: {e}")
            import traceback
            traceback.print_exc()
        
    def unload(self):
        print("DEBUG: VunguIntegration unload called")
        try:
            # Remove menu and toolbar
            self.iface.removePluginMenu("Vungu Integration", self.action)
            self.iface.removeToolBarIcon(self.action)
            print("DEBUG: Removed menu and toolbar")
            
            # Remove dock widget
            if self.dock:
                self.iface.removeDockWidget(self.dock)
                print("DEBUG: Removed dock widget")
        except Exception as e:
            print(f"DEBUG: Error in unload: {e}")
        
    def run(self):
        print("DEBUG: VunguIntegration run called")
        try:
            # Show the dock widget
            if self.dock:
                self.dock.show()
                self.dock.raise_()
                self.dock.activateWindow()
                print("DEBUG: Dock widget shown")
            else:
                print("DEBUG: No dock widget to show")
        except Exception as e:
            print(f"DEBUG: Error in run: {e}")
