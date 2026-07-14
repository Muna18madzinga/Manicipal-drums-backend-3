import db from '../config/db.js'
import Feature from '../models/feature.js'
import Layer from '../models/layer.js'
import CoordinatePoint from '../models/coordinatePoint.js'
import LandParcel from '../models/landParcel.js'
import { polarForward, intersectBearingBearing, shoelaceAreaYX, bankersRound, polygonCentroidYX, edgeMetricsYX, bearingSouthBetween, roundBearingSouth, degToDMS } from '../utils/zim-geo.js'
import { computeEdgesWithResiduals } from '../utils/edge-computation.js'
import { computeAreaConsistency } from '../utils/area-computation.js'

export default async function computeRoutes(app) {
  // Polar forward: from P(Y,X), bearing S-oriented, distance -> Q(Y,X)
  app.post('/compute/polar', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['y', 'x', 'distance', 'bearingDeg'],
        properties: {
          y: { type: 'number' },
          x: { type: 'number' },
          distance: { type: 'number', minimum: 0 },
          bearingDeg: { type: 'number' },
          save: { type: 'boolean' },
          layer_id: { type: 'number' },
          properties: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const { y, x, distance, bearingDeg, save, layer_id, properties = {} } = request.body
    const q = polarForward({ y0: y, x0: x, distance, bearingDeg })

    let saved = null
    if (save && layer_id) {
      const layer = await Layer.findById(layer_id)
      if (!layer) return reply.code(404).send({ error: 'Layer not found' })
      try {
        saved = await Feature.create({
          layerId: layer_id,
          projectId: layer.project_id,
          geometry: { type: 'Point', coordinates: [q.y, q.x] },
          properties: { ...properties, system: 'ZIM_P(Y,X)', note: 'polar' }
        })
      } catch (err) {
        return reply.code(400).send({ ok: false, error: 'Save failed', detail: err?.message })
      }
    }

    return { ok: true, point: q, saved }
  })

  // Bearing-Bearing intersection: from two known points with S-oriented bearings
  app.post('/compute/intersections/bearing-bearing', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['p1', 'p2'],
        properties: {
          p1: {
            type: 'object',
            required: ['y', 'x', 'bearingDeg'],
            properties: { y: { type: 'number' }, x: { type: 'number' }, bearingDeg: { type: 'number' } }
          },
          p2: {
            type: 'object',
            required: ['y', 'x', 'bearingDeg'],
            properties: { y: { type: 'number' }, x: { type: 'number' }, bearingDeg: { type: 'number' } }
          },
          save: { type: 'boolean' },
          layer_id: { type: 'number' },
          properties: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const { p1, p2, save, layer_id, properties = {} } = request.body
    const res = intersectBearingBearing({ y1: p1.y, x1: p1.x, bearing1Deg: p1.bearingDeg }, { y2: p2.y, x2: p2.x, bearing2Deg: p2.bearingDeg })
    if (!res.ok) return reply.code(400).send({ ok: false, error: res.reason })

    let saved = null
    if (save && layer_id) {
      const layer = await Layer.findById(layer_id)
      if (!layer) return reply.code(404).send({ error: 'Layer not found' })
      try {
        saved = await Feature.create({
          layerId: layer_id,
          projectId: layer.project_id,
          geometry: { type: 'Point', coordinates: [res.point.y, res.point.x] },
          properties: { ...properties, system: 'ZIM_P(Y,X)', note: 'intersection_bearing_bearing' }
        })
      } catch (err) {
        return reply.code(400).send({ ok: false, error: 'Save failed', detail: err?.message })
      }
    }
    return { ok: true, point: res.point, saved }
  })

  // Area computation using shoelace on P(Y,X) points
  app.post('/compute/area', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['points'],
        properties: {
          // points: array of { y, x }
          points: {
            type: 'array',
            minItems: 3,
            items: { type: 'object', required: ['y', 'x'], properties: { y: { type: 'number' }, x: { type: 'number' } } }
          },
          // Display/policy options
          hectaresThreshold: { type: 'number' }, // default 10000 m^2
          roundMetersDecimals: { type: 'number' }, // default 0 for area < threshold
          roundHectaresDecimals: { type: 'number' }, // default 4 for area >= threshold
          includeResiduals: { type: 'boolean' },
          // Optional persistence
          save: { type: 'boolean' },
          layer_id: { type: 'number' },
          properties: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const {
      points,
      hectaresThreshold = 10000,
      roundMetersDecimals = 0,
      roundHectaresDecimals = 4,
      includeResiduals = true,
      save = false,
      layer_id,
      properties = {}
    } = request.body

    if (!Array.isArray(points) || points.length < 3) {
      return reply.code(400).send({ ok: false, error: 'At least 3 points required' })
    }

    // ⭐ SINGLE SOURCE OF TRUTH: Use shared area computation utility
    // This ensures consistent area/consistency calculations across /compute/area and /geopdf/vector
    const areaData = computeAreaConsistency(points, {
      hectaresThreshold,
      roundMetersDecimals,
      roundHectaresDecimals,
      includeResiduals
    })

    // Ensure closed ring for GeoJSON
    const closed = points[0].y === points[points.length - 1].y && points[0].x === points[points.length - 1].x
      ? points
      : [...points, points[0]]

    let saved = null
    if (save && layer_id) {
      const layer = await Layer.findById(layer_id)
      if (!layer) return reply.code(404).send({ error: 'Layer not found' })
      // GeoJSON Polygon expects coordinates: [ [ [y,x], ... ] ]
      const ring = closed.map(p => [p.y, p.x])
      try {
        saved = await Feature.create({
          layerId: layer_id,
          projectId: layer.project_id,
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { ...properties, system: 'ZIM_P(Y,X)', note: 'area_polygon', area_m2: areaData.area.abs_m2 }
        })
      } catch (err) {
        return reply.code(400).send({ ok: false, error: 'Save failed', detail: err?.message })
      }
    }

    return {
      ok: true,
      area: areaData.area,
      centroid: areaData.centroid,
      residuals: includeResiduals ? {
        sumDy: areaData.residuals.sumDy,
        sumDx: areaData.residuals.sumDx,
        closureError: areaData.residuals.closureError,
        edges: areaData.edges
      } : undefined,
      closure: includeResiduals ? areaData.closure : undefined,
      saved
    }
  })

  // Batch area computation (v2): Using normalized tables
  app.post('/compute/area/batch/v2', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          hectaresThreshold: { type: 'number' },
          roundMetersDecimals: { type: 'number' },
          roundHectaresDecimals: { type: 'number' },
          tolerance: { type: 'number' },
          save_results: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const {
      project_id,
      hectaresThreshold = 10000,
      roundMetersDecimals = 0,
      roundHectaresDecimals = 4,
      tolerance = 0.001,
      save_results = false
    } = request.body

    // Load coordinate points
    const coordPointsRaw = await CoordinatePoint.findByProject(project_id)
    if (coordPointsRaw.length === 0) {
      return reply.code(400).send({ ok: false, error: 'No coordinate points found for project' })
    }

    // Extract coordinates from PostGIS geometry
    const coordPoints = await Promise.all(coordPointsRaw.map(async pt => {
      const coords = await db.query(
        'SELECT ST_X(geom) as y, ST_Y(geom) as x FROM coordinate_points WHERE id = $1',
        [pt.id]
      )
      return {
        id: pt.id,
        name: pt.name,
        y: coords.rows[0].y,
        x: coords.rows[0].x
      }
    }))

    // Load land parcels
    const parcelsRaw = await LandParcel.findByProject(project_id)
    if (parcelsRaw.length === 0) {
      return reply.code(400).send({ ok: false, error: 'No land parcels found for project' })
    }

    // Extract polygon coordinates from PostGIS geometry
    const parcels = await Promise.all(parcelsRaw.map(async parcel => {
      const geomData = await db.query(
        'SELECT ST_AsGeoJSON(geom)::jsonb as geometry FROM land_parcels WHERE id = $1',
        [parcel.id]
      )
      return {
        ...parcel,
        geometry: geomData.rows[0].geometry
      }
    }))

    // Helper: find matching coordinate point within tolerance
    function findMatchingPoint(y, x) {
      for (const pt of coordPoints) {
        const dy = Math.abs(pt.y - y)
        const dx = Math.abs(pt.x - x)
        if (dy < tolerance && dx < tolerance) {
          return pt
        }
      }
      return null
    }

    // Process each parcel
    const results = []
    for (const parcel of parcels) {
      const ring = parcel.geometry.coordinates[0]
      
      if (!Array.isArray(ring) || ring.length < 3) {
        results.push({
          polygon_id: parcel.id,
          designation: parcel.stand,
          success: false,
          error: 'Invalid polygon geometry (less than 3 vertices)'
        })
        continue
      }

      // Remove duplicate closing vertex
      const vertices = ring.length >= 2 && ring[0][0] === ring[ring.length-1][0] && ring[0][1] === ring[ring.length-1][1]
        ? ring.slice(0, -1)
        : ring

      // Match vertices to coordinate list
      const matchedVertices = []
      const unmatchedVertices = []
      
      for (let i = 0; i < vertices.length; i++) {
        const [y, x] = vertices[i]
        const match = findMatchingPoint(y, x)
        if (match) {
          matchedVertices.push({ y, x, name: match.name, index: i })
        } else {
          unmatchedVertices.push({ y, x, index: i })
        }
      }

      // Check if all vertices matched
      if (unmatchedVertices.length > 0) {
        results.push({
          polygon_id: parcel.id,
          designation: parcel.stand,
          success: false,
          error: `${unmatchedVertices.length} vertices not found in coordinate list`,
          matched_count: matchedVertices.length,
          total_vertices: vertices.length,
          unmatched_vertices: unmatchedVertices
        })
        continue
      }

      // Compute area using shoelace formula
      let area = 0
      for (let i = 0; i < vertices.length; i++) {
        const j = (i + 1) % vertices.length
        area += vertices[i][0] * vertices[j][1]
        area -= vertices[j][0] * vertices[i][1]
      }
      area = Math.abs(area) / 2

      // Compute centroid
      let cy = 0, cx = 0
      for (const v of vertices) {
        cy += v[0]
        cx += v[1]
      }
      cy /= vertices.length
      cx /= vertices.length

      // Compute closure error
      let sumDy = 0, sumDx = 0
      for (let i = 0; i < vertices.length; i++) {
        const j = (i + 1) % vertices.length
        sumDy += vertices[j][0] - vertices[i][0]
        sumDx += vertices[j][1] - vertices[i][1]
      }
      const closureError = Math.sqrt(sumDy * sumDy + sumDx * sumDx)

      // Format area
      const areaM2 = area
      const areaHa = area / 10000
      const displayArea = areaM2 >= hectaresThreshold
        ? parseFloat(areaHa.toFixed(roundHectaresDecimals))
        : parseFloat(areaM2.toFixed(roundMetersDecimals))
      const displayUnit = areaM2 >= hectaresThreshold ? 'ha' : 'm²'

      results.push({
        polygon_id: parcel.id,
        designation: parcel.stand,
        success: true,
        vertex_names: matchedVertices.map(v => v.name),
        area: {
          m2: areaM2,
          ha: areaHa,
          display: displayArea,
          unit: displayUnit
        },
        centroid: { y: cy, x: cx },
        closure_error_m: closureError,
        vertex_count: vertices.length
      })
    }

    const successCount = results.filter(r => r.success).length
    const failureCount = results.filter(r => !r.success).length

    return {
      ok: true,
      total_polygons: parcels.length,
      success_count: successCount,
      failure_count: failureCount,
      results
    }
  })

  // Batch area computation (v1): Legacy endpoint using layers/features
  app.post('/compute/area/batch', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['polygon_layer_id', 'coordinate_layer_id'],
        properties: {
          polygon_layer_id: { type: 'number' },
          coordinate_layer_id: { type: 'number' },
          hectaresThreshold: { type: 'number' },
          roundMetersDecimals: { type: 'number' },
          roundHectaresDecimals: { type: 'number' },
          tolerance: { type: 'number' }, // coordinate matching tolerance in meters
          save_results: { type: 'boolean' } // save computed areas back to polygon properties
        }
      }
    }
  }, async (request, reply) => {
    const {
      polygon_layer_id,
      coordinate_layer_id,
      hectaresThreshold = 10000,
      roundMetersDecimals = 0,
      roundHectaresDecimals = 4,
      tolerance = 0.001,
      save_results = false
    } = request.body

    // Load coordinate list layer
    const coordLayer = await Layer.findById(coordinate_layer_id)
    if (!coordLayer) return reply.code(404).send({ ok: false, error: 'Coordinate layer not found' })
    
    const coordFeatures = await Feature.findByLayer(coordinate_layer_id)
    const coordPoints = coordFeatures
      .filter(f => f.geometry?.type === 'Point')
      .map(f => ({
        id: f.id,
        name: f.properties?.name || f.properties?.beacon || f.properties?.point || String(f.id),
        y: f.geometry.coordinates[0],
        x: f.geometry.coordinates[1],
        properties: f.properties
      }))

    if (coordPoints.length === 0) {
      return reply.code(400).send({ ok: false, error: 'No points found in coordinate layer' })
    }

    // Load polygon layer
    const polyLayer = await Layer.findById(polygon_layer_id)
    if (!polyLayer) return reply.code(404).send({ ok: false, error: 'Polygon layer not found' })
    
    const polyFeatures = await Feature.findByLayer(polygon_layer_id)
    const polygons = polyFeatures.filter(f => f.geometry?.type === 'Polygon')

    if (polygons.length === 0) {
      return reply.code(400).send({ ok: false, error: 'No polygons found in polygon layer' })
    }

    // Helper: find matching coordinate point within tolerance
    function findMatchingPoint(y, x) {
      for (const pt of coordPoints) {
        const dy = Math.abs(pt.y - y)
        const dx = Math.abs(pt.x - x)
        if (dy < tolerance && dx < tolerance) {
          return pt
        }
      }
      return null
    }

    // Process each polygon
    const results = []
    for (const poly of polygons) {
      const designation = poly.properties?.designation || poly.properties?.name || poly.properties?.stand || `Polygon ${poly.id}`
      const ring = poly.geometry.coordinates[0] // outer ring
      
      if (!Array.isArray(ring) || ring.length < 3) {
        results.push({
          polygon_id: poly.id,
          designation,
          success: false,
          error: 'Invalid polygon geometry (less than 3 vertices)'
        })
        continue
      }

      // Remove duplicate closing vertex if present
      const vertices = ring.length >= 2 && ring[0][0] === ring[ring.length-1][0] && ring[0][1] === ring[ring.length-1][1]
        ? ring.slice(0, -1)
        : ring

      // Match vertices to coordinate list
      const matchedVertices = []
      const unmatchedVertices = []
      
      for (let i = 0; i < vertices.length; i++) {
        const [y, x] = vertices[i]
        const match = findMatchingPoint(y, x)
        if (match) {
          matchedVertices.push({ y, x, name: match.name, index: i })
        } else {
          unmatchedVertices.push({ y, x, index: i })
        }
      }

      // Validation: all vertices should match
      if (unmatchedVertices.length > 0) {
        results.push({
          polygon_id: poly.id,
          designation,
          success: false,
          error: `${unmatchedVertices.length} vertices not found in coordinate list`,
          unmatched_vertices: unmatchedVertices,
          matched_count: matchedVertices.length,
          total_vertices: vertices.length
        })
        continue
      }

      // Compute area
      const points = matchedVertices.map(v => ({ y: v.y, x: v.x }))
      const signedArea = shoelaceAreaYX(points)
      const absArea = Math.abs(signedArea)
      const centroid = polygonCentroidYX(points)

      const useHectares = absArea >= hectaresThreshold
      const areaMetersRounded = bankersRound(absArea, roundMetersDecimals)
      const areaHectaresRounded = bankersRound(absArea / 10000, roundHectaresDecimals)

      // Compute residuals
      const closed = [...points, points[0]]
      const N = points.length
      const obs = []
      for (let i = 0; i < N; i++) {
        const a = points[i]
        const b = points[(i + 1) % N]
        const dy = b.y - a.y
        const dx = b.x - a.x
        const distance = Math.hypot(dy, dx)
        const brg = bearingSouthBetween({ y1: a.y, x1: a.x }, { y2: b.y, x2: b.x })
        const distRounded = bankersRound(distance, 2)
        const secRes = distance < 6000 ? 10 : 1
        const bearingRoundedDeg = roundBearingSouth(brg, secRes)
        obs.push({ distance, distRounded, bearingDeg: brg, bearingRoundedDeg, secondsResolution: secRes })
      }

      const traversePts = [{ y: points[0].y, x: points[0].x }]
      for (let i = 0; i < obs.length; i++) {
        const last = traversePts[traversePts.length - 1]
        const step = obs[i]
        const next = polarForward({ y0: last.y, x0: last.x, distance: step.distRounded, bearingDeg: step.bearingRoundedDeg })
        traversePts.push(next)
      }

      let residualSumDy = 0, residualSumDx = 0
      for (let i = 0; i < obs.length; i++) {
        const targetIdx = (i + 1) % points.length
        const entered = points[targetIdx]
        const computed = traversePts[i + 1]
        const dY = computed.y - entered.y
        const dX = computed.x - entered.x
        residualSumDy += dY
        residualSumDx += dX
      }

      const closureError = Math.sqrt(residualSumDy ** 2 + residualSumDx ** 2)

      // Save results back to polygon properties if requested
      if (save_results) {
        try {
          const updatedProps = {
            ...poly.properties,
            area_m2: absArea,
            area_display: useHectares ? `${areaHectaresRounded} ha` : `${areaMetersRounded} m²`,
            centroid_y: centroid.y,
            centroid_x: centroid.x,
            closure_error_m: closureError,
            computed_at: new Date().toISOString()
          }
          await Feature.update(poly.id, { geometry: poly.geometry, properties: updatedProps })
        } catch (err) {
          // Continue even if save fails
        }
      }

      results.push({
        polygon_id: poly.id,
        designation,
        success: true,
        vertex_names: matchedVertices.map(v => v.name),
        area: {
          signed_m2: signedArea,
          abs_m2: absArea,
          display: useHectares ? { hectares: areaHectaresRounded, unit: 'ha' } : { square_meters: areaMetersRounded, unit: 'm2' }
        },
        centroid,
        closure_error_m: closureError,
        residuals: { sumDy: residualSumDy, sumDx: residualSumDx }
      })
    }

    const successCount = results.filter(r => r.success).length
    const failureCount = results.filter(r => !r.success).length

    return {
      ok: true,
      total_polygons: polygons.length,
      success_count: successCount,
      failure_count: failureCount,
      results
    }
  })
}
