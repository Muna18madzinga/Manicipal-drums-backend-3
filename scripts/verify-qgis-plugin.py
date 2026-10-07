"""Verify the Vungu PyQGIS plugin inside a real QGIS (3.x/Qt5 or 4.x/Qt6), headless.

Run with QGIS's own Python, e.g. on Windows:

    "C:\\Program Files\\QGIS 4.2.3\\bin\\python-qgis.bat" scripts\\verify-qgis-plugin.py

What it proves (exit code 0 only if all of it holds):
  * the dock widget builds (it crashed on QGIS 4: unscoped Qt enums);
  * single / categorized / graduated / rule-based renderers each produce the
    right style payload (graduated and rule-based used to degrade to a grey point);
  * the style-change monitor notices a class colour edit on every renderer type
    (it used to fingerprint only renderer.symbol());
  * a real push - manual sync and auto-upload - sends that style to
    POST /qgis/sync/upload, checked against a local stub of the portal.
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import MagicMock
import importlib.util

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from qgis.core import (  # noqa: E402
    QgsApplication, QgsVectorLayer, QgsFeature, QgsGeometry, QgsSymbol,
    QgsSingleSymbolRenderer, QgsCategorizedSymbolRenderer, QgsRendererCategory,
    QgsGraduatedSymbolRenderer, QgsRendererRange, QgsRuleBasedRenderer,
)
from qgis.PyQt.QtGui import QColor  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.environ.get("VUNGU_PLUGIN_DIR") or os.path.join(HERE, "..", "qgis-projects", "vungu-integration")

failures = []


def check(cond, msg):
    print(("  ok    " if cond else "  FAIL  ") + msg)
    if not cond:
        failures.append(msg)


# --- a stub of the portal: records what the plugin sends -------------------
received = []


class Portal(BaseHTTPRequestHandler):
    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send({"data": {"layers": []}})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        received.append((self.path, self.headers.get("Authorization"), json.loads(raw or b"{}")))
        self._send({"success": True})

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Portal)
threading.Thread(target=server.serve_forever, daemon=True).start()
base_url = f"http://127.0.0.1:{server.server_port}"

app = QgsApplication([], True)
app.initQgis()

spec = importlib.util.spec_from_file_location("vungu_plugin", os.path.join(PLUGIN, "plugin.py"))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


def sym(layer, colour):
    s = QgsSymbol.defaultSymbol(layer.geometryType())
    s.setColor(QColor(colour))
    return s


def new_layer(name="zones"):
    layer = QgsVectorLayer("Polygon?crs=EPSG:4326&field=zone:string&field=area:double", name, "memory")
    for z, a in (("A", 1.0), ("B", 5.0), ("C", 9.0)):
        f = QgsFeature(layer.fields())
        f.setAttributes([z, a])
        f.setGeometry(QgsGeometry.fromWkt("POLYGON((0 0,1 0,1 1,0 1,0 0))"))
        layer.dataProvider().addFeature(f)
    return layer


def single():
    l = new_layer()
    l.setRenderer(QgsSingleSymbolRenderer(sym(l, "#ff0000")))
    return l


def categorized():
    l = new_layer()
    l.setRenderer(QgsCategorizedSymbolRenderer("zone", [
        QgsRendererCategory(v, sym(l, c), v) for v, c in (("A", "#ff0000"), ("B", "#00ff00"), ("C", "#0000ff"))]))
    return l


def graduated():
    l = new_layer()
    l.setRenderer(QgsGraduatedSymbolRenderer("area", [
        QgsRendererRange(lo, hi, sym(l, c), lbl)
        for lo, hi, c, lbl in ((0, 4, "#ffeeee", "low"), (4, 8, "#ff8888", "mid"), (8, 12, "#aa0000", "high"))]))
    return l


def rule_based():
    l = new_layer()
    root = QgsRuleBasedRenderer.Rule(None)
    parent = QgsRuleBasedRenderer.Rule(None, 0, 0, '"area" > 0', "any")  # group rule: no symbol
    parent.appendChild(QgsRuleBasedRenderer.Rule(sym(l, "#123456"), 0, 0, '"area" > 4', "big"))
    parent.appendChild(QgsRuleBasedRenderer.Rule(sym(l, "#abcdef"), 0, 0, '"area" <= 4', "small"))
    root.appendChild(parent)
    l.setRenderer(QgsRuleBasedRenderer(root))
    return l


def recolour(layer, kind):
    """Edit one class colour in place, as a user would in the Layer Styling panel."""
    r = layer.renderer()
    if kind == "single":
        r.symbol().setColor(QColor("#000001"))
    elif kind == "categorized":
        r.updateCategorySymbol(0, sym(layer, "#000001"))
    elif kind == "graduated":
        r.updateRangeSymbol(0, sym(layer, "#000001"))
    else:
        r.rootRule().children()[0].children()[0].setSymbol(sym(layer, "#000001"))


print("== dock builds (Qt enums)")
canvas_layers = []
iface = MagicMock()
iface.mapCanvas.return_value.layers.side_effect = lambda: canvas_layers
try:
    dock = plugin.VunguIntegrationDock(iface)
    built = True
except Exception as e:  # noqa: BLE001
    built = False
    print("   ", type(e).__name__, e)
check(built, "VunguIntegrationDock constructs")
if not built:
    sys.exit(1)
dock.api_url.setText(base_url)
dock.api_token.setText("test-token")
dock.auto_upload_checkbox.setChecked(True)
check(dock.style_monitor.monitoring_enabled, "ticking Auto-Upload starts the style monitor")
dock.auto_upload_checkbox.setChecked(False)
check(not dock.style_monitor.monitoring_enabled, "unticking it stops the monitor")

print("== style payload per renderer")
style = {}
for kind, make in (("single", single), ("categorized", categorized), ("graduated", graduated), ("rule", rule_based)):
    layer = make()
    style[kind] = dock.convert_qgis_layer_to_geojson_with_styling(layer)["style"]
    json.dumps(style[kind])  # must be serialisable for the upload
    check(style[kind].get("_rendererType") == ("single" if kind == "single" else kind), f"{kind}: _rendererType = {style[kind].get('_rendererType')}")
    d = style[kind].get("_style", {})
    inner = d.get("_style", d)
    check(inner.get("type") == "polygon", f"{kind}: default style is a polygon, not a grey point ({inner.get('type')})")

check(style["categorized"].get("_attribute") == "zone", "categorized: _attribute = zone")
check(len(style["categorized"]["_categories"]) == 3, "categorized: 3 classes")
g = style["graduated"]
check(g.get("_attribute") == "area", "graduated: _attribute = area")
check([(r["lower"], r["upper"], r["label"]) for r in g["_ranges"]] == [(0, 4, "low"), (4, 8, "mid"), (8, 12, "high")], "graduated: bounds and labels")
check([r["_style"]["fillColor"] for r in g["_ranges"]] == ["#ffeeee", "#ff8888", "#aa0000"], "graduated: class colours")
r = style["rule"]["_rules"]
check([x["label"] for x in r] == ["big", "small"], "rule: the two symbol-bearing rules, group rule skipped")
check(r[0]["filter"] == '("area" > 0) AND ("area" > 4)', f"rule: nested filter combined ({r[0]['filter']})")
check(r[1]["_style"]["fillColor"] == "#abcdef", "rule: class colour")

print("== style-change monitor sees a class colour edit")
monitor = plugin.StyleMonitor(MagicMock())
for kind, make in (("single", single), ("categorized", categorized), ("graduated", graduated), ("rule", rule_based)):
    layer = make()
    before = monitor.extract_style_info(layer)
    same = monitor.extract_style_info(layer)
    recolour(layer, kind)
    after = monitor.extract_style_info(layer)
    check(before == same, f"{kind}: unchanged style -> same fingerprint")
    check(before != after, f"{kind}: recolouring a class -> fingerprint changes")

print("== real push to the (stub) portal")
for kind, make in (("graduated", graduated), ("rule", rule_based), ("categorized", categorized)):
    del received[:]
    layer = make()
    canvas_layers[:] = [layer]
    dock.sync_to_portal()
    uploads = [p for p in received if p[0].endswith("/qgis/sync/upload")]
    check(len(uploads) == 1, f"{kind}: manual sync posted one upload")
    if uploads:
        path, auth, body = uploads[0]
        check(auth == "Bearer test-token", f"{kind}: bearer token sent")
        check(body["style"].get("_rendererType") == kind, f"{kind}: uploaded style _rendererType = {body['style'].get('_rendererType')}")
        check(len(body["features"]) == 3, f"{kind}: 3 features uploaded")
    del received[:]
    dock.auto_upload_layer(layer.name())
    uploads = [p for p in received if p[0].endswith("/qgis/sync/upload")]
    check(bool(uploads) and uploads[0][2]["style"].get("_rendererType") == kind,
          f"{kind}: auto-upload sends the same style (was empty for non-single renderers)")

server.shutdown()
app.exitQgis()
print()
print("FAILED: %d" % len(failures) if failures else "ALL CHECKS PASSED")
sys.exit(1 if failures else 0)
