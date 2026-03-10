# Phase 2 API Testing Guide

## Authentication
First, get a token:
```bash
curl -X POST http://localhost:3001/api/admin/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@vungu.gov.zw","password":"admin123"}'
```

Use the token in subsequent requests:
```bash
curl -H "Authorization: Bearer mock-jwt-token" [URL]
```

## Phase 2 Endpoints to Test

### 1. Data Cleaning API
- GET /api/admin/data-cleaning/jobs
- GET /api/admin/data-cleaning/statistics
- POST /api/admin/data-cleaning/jobs
- GET /api/admin/data-cleaning/jobs/{jobId}
- GET /api/admin/data-cleaning/jobs/{jobId}/issues

### 2. QML Parser API
- GET /api/admin/qml-templates
- GET /api/admin/qml-templates/statistics
- POST /api/admin/qml-templates
- POST /api/admin/qml-templates/validate
- POST /api/admin/qml-templates/parse

### 3. Approval Workflows API
- GET /api/admin/workflows
- GET /api/admin/workflows/statistics
- POST /api/admin/workflows
- GET /api/admin/requests
- GET /api/admin/requests/pending

### 4. Batch Processing API
- GET /api/admin/batch/jobs
- GET /api/admin/batch/statistics
- POST /api/admin/batch/jobs
- POST /api/admin/batch/jobs/{jobId}/start
- GET /api/admin/batch/jobs/{jobId}/items

## Test Commands

### Data Cleaning
```bash
# Get all cleaning jobs
curl -H "Authorization: Bearer mock-jwt-token" http://localhost:3001/api/admin/data-cleaning/jobs

# Create cleaning job
curl -X POST -H "Authorization: Bearer mock-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{"jobId":1,"cleaningType":"duplicate_detection","config":{"layerId":1}}' \
  http://localhost:3001/api/admin/data-cleaning/jobs
```

### QML Parser
```bash
# Get all QML templates
curl -H "Authorization: Bearer mock-jwt-token" http://localhost:3001/api/admin/qml-templates

# Validate QML content
curl -X POST -H "Authorization: Bearer mock-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{"qml_content":"<qml><renderer-v2 type=\"singleSymbol\"><symbols><symbol type=\"marker\" name=\"test\"/></symbols></renderer-v2></qml>"}' \
  http://localhost:3001/api/admin/qml-templates/validate
```

### Approval Workflows
```bash
# Get all workflows
curl -H "Authorization: Bearer mock-jwt-token" http://localhost:3001/api/admin/workflows

# Create workflow
curl -X POST -H "Authorization: Bearer mock-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Workflow","workflow_type":"data_upload","steps":[{"step":1,"name":"Review","role":"data_manager","required":true}]}' \
  http://localhost:3001/api/admin/workflows
```

### Batch Processing
```bash
# Get all batch jobs
curl -H "Authorization: Bearer mock-jwt-token" http://localhost:3001/api/admin/batch/jobs

# Create batch job
curl -X POST -H "Authorization: Bearer mock-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Batch Job","job_type":"data_cleaning","config":{}}' \
  http://localhost:3001/api/admin/batch/jobs
```

## Expected Results

All endpoints should return:
- 200 OK for successful GET requests
- 201 Created for successful POST requests
- Proper JSON responses with data/message fields
- Authentication should work with Bearer token

## Troubleshooting

If endpoints return 404 Not Found:
- Check if routes are properly registered
- Verify no compilation errors in admin server
- Check admin server logs for errors

If endpoints return 500 Internal Server Error:
- Check database connection
- Verify tables exist
- Check admin server logs for detailed errors
