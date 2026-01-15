# SuperNavi Cloud

Cloud Sync v1 for SuperNavi - digital pathology preview service.

This service receives events from edge devices, stores them in an append-only event store, projects them to read models, and provides signed URLs for remote preview access via Wasabi (S3-compatible storage).

## Architecture

```
Edge Device                          Cloud
┌─────────────┐                   ┌─────────────────────┐
│  Sync Engine │ ───events───▶   │  POST /sync/v1/events│
│  (Outbox)    │                  │        │            │
└─────────────┘                   │        ▼            │
                                  │  ┌──────────────┐   │
                                  │  │ Event Store  │   │
                                  │  │ (append-only)│   │
                                  │  └──────┬───────┘   │
                                  │         │           │
                                  │         ▼           │
                                  │  ┌──────────────┐   │
                                  │  │ Projections  │   │
                                  │  │ (sync)       │   │
                                  │  └──────┬───────┘   │
                                  │         │           │
                                  │         ▼           │
                                  │  ┌──────────────┐   │
                                  │  │ Read Models  │   │
                                  │  │ cases_read   │   │
                                  │  │ slides_read  │   │
                                  │  │ preview_assets│  │
                                  │  └──────────────┘   │
                                  └─────────────────────┘
```

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for local development)
- Wasabi or S3-compatible storage credentials

### Running with Docker

1. Copy environment file:
```bash
cp .env.example .env
```

2. Edit `.env` with your Wasabi credentials:
```env
S3_ENDPOINT=https://s3.us-east-1.wasabisys.com
S3_REGION=us-east-1
S3_BUCKET=supernavi
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
```

3. Start services:
```bash
docker compose up -d
```

4. Check health:
```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

### Running with Hot Reload (Development)

```bash
docker compose --profile dev up supernavi_cloud_dev
```

### Local Development (without Docker)

1. Start PostgreSQL:
```bash
docker compose up -d postgres
```

2. Install dependencies:
```bash
npm install
```

3. Run migrations:
```bash
cp .env.example .env
# Edit .env with DATABASE_URL=postgresql://supernavi:supernavi_dev@localhost:5432/supernavi_cloud
npm run migrate:dev
```

4. Start dev server:
```bash
npm run dev
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `3000` |
| `HOST` | Server host | `0.0.0.0` |
| `DATABASE_URL` | PostgreSQL connection string | - |
| `S3_ENDPOINT` | S3/Wasabi endpoint URL | - |
| `S3_REGION` | S3 region | - |
| `S3_BUCKET` | S3 bucket name | - |
| `S3_ACCESS_KEY` | S3 access key | - |
| `S3_SECRET_KEY` | S3 secret key | - |
| `S3_FORCE_PATH_STYLE` | Use path-style URLs | `true` |
| `SIGNED_URL_TTL_SECONDS` | Signed URL expiration | `120` |

## API Endpoints

### Sync API

#### POST /sync/v1/events
Ingest events from edge devices.

```bash
curl -X POST http://localhost:3000/sync/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "edge_id": "edge-001",
    "cursor": "cursor-123",
    "events": [
      {
        "event_id": "550e8400-e29b-41d4-a716-446655440001",
        "edge_id": "edge-001",
        "aggregate_type": "case",
        "aggregate_id": "case-001",
        "type": "CaseUpserted",
        "occurred_at": "2024-01-15T10:30:00Z",
        "payload": {
          "case_id": "case-001",
          "title": "Case #001",
          "patient_ref": "patient-abc",
          "status": "active",
          "created_at": "2024-01-15T10:30:00Z",
          "updated_at": "2024-01-15T10:30:00Z"
        }
      }
    ]
  }'
```

Response:
```json
{
  "accepted": 1,
  "duplicated": 0,
  "rejected": [],
  "last_cursor": "cursor-123"
}
```

### Read API

#### GET /api/v1/cases
List cases with pagination.

```bash
curl "http://localhost:3000/api/v1/cases?limit=10&offset=0"
```

Response:
```json
{
  "cases": [
    {
      "case_id": "case-001",
      "title": "Case #001",
      "patient_ref": "patient-abc",
      "status": "active",
      "updated_at": "2024-01-15T10:30:00.000Z",
      "slides_count": 2
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0
}
```

#### GET /api/v1/cases/:case_id
Get case details with slides.

```bash
curl http://localhost:3000/api/v1/cases/case-001
```

Response:
```json
{
  "case_id": "case-001",
  "title": "Case #001",
  "patient_ref": "patient-abc",
  "status": "active",
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z",
  "slides": [
    {
      "slide_id": "slide-001",
      "svs_filename": "sample.svs",
      "width": 100000,
      "height": 80000,
      "mpp": 0.25,
      "scanner": "Aperio GT450",
      "has_preview": true,
      "updated_at": "2024-01-15T10:35:00.000Z"
    }
  ]
}
```

#### GET /api/v1/slides/:slide_id/preview
Get preview info with signed URLs.

```bash
curl http://localhost:3000/api/v1/slides/slide-001/preview
```

Response:
```json
{
  "slide_id": "slide-001",
  "case_id": "case-001",
  "thumb_url": "https://s3.us-east-1.wasabisys.com/supernavi/previews/slide-001/thumb.jpg?...",
  "manifest_url": "https://s3.us-east-1.wasabisys.com/supernavi/previews/slide-001/manifest.json?...",
  "tiles": {
    "strategy": "signed-per-tile",
    "max_preview_level": 6,
    "tile_size": 256,
    "format": "jpg",
    "endpoint": "/api/v1/tiles/sign"
  }
}
```

#### POST /api/v1/tiles/sign
Sign a tile URL.

```bash
curl -X POST http://localhost:3000/api/v1/tiles/sign \
  -H "Content-Type: application/json" \
  -d '{
    "key": "previews/slide-001/tiles/0/0_0.jpg",
    "expires_seconds": 120
  }'
```

Response:
```json
{
  "url": "https://s3.us-east-1.wasabisys.com/supernavi/previews/slide-001/tiles/0/0_0.jpg?..."
}
```

### Health Endpoints

```bash
# Liveness check
curl http://localhost:3000/health

# Readiness check (includes DB)
curl http://localhost:3000/ready
```

## End-to-End Flow Example

1. **Register a case**:
```bash
curl -X POST http://localhost:3000/sync/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "edge_id": "edge-001",
    "events": [{
      "event_id": "550e8400-e29b-41d4-a716-446655440001",
      "edge_id": "edge-001",
      "aggregate_type": "case",
      "aggregate_id": "case-001",
      "type": "CaseUpserted",
      "occurred_at": "2024-01-15T10:30:00Z",
      "payload": {
        "case_id": "case-001",
        "title": "Biopsy Case #001",
        "patient_ref": "P-12345",
        "status": "active",
        "created_at": "2024-01-15T10:30:00Z",
        "updated_at": "2024-01-15T10:30:00Z"
      }
    }]
  }'
```

2. **Register a slide**:
```bash
curl -X POST http://localhost:3000/sync/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "edge_id": "edge-001",
    "events": [{
      "event_id": "550e8400-e29b-41d4-a716-446655440002",
      "edge_id": "edge-001",
      "aggregate_type": "slide",
      "aggregate_id": "slide-001",
      "type": "SlideRegistered",
      "occurred_at": "2024-01-15T10:31:00Z",
      "payload": {
        "slide_id": "slide-001",
        "case_id": "case-001",
        "svs_filename": "biopsy_sample.svs",
        "width": 98304,
        "height": 73728,
        "mpp": 0.25,
        "scanner": "Aperio GT450"
      }
    }]
  }'
```

3. **Publish preview** (after edge uploads files to Wasabi):
```bash
curl -X POST http://localhost:3000/sync/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "edge_id": "edge-001",
    "events": [{
      "event_id": "550e8400-e29b-41d4-a716-446655440003",
      "edge_id": "edge-001",
      "aggregate_type": "preview",
      "aggregate_id": "slide-001",
      "type": "PreviewPublished",
      "occurred_at": "2024-01-15T10:35:00Z",
      "payload": {
        "slide_id": "slide-001",
        "case_id": "case-001",
        "wasabi_bucket": "supernavi",
        "wasabi_region": "us-east-1",
        "wasabi_endpoint": "https://s3.us-east-1.wasabisys.com",
        "wasabi_prefix": "previews/slide-001/",
        "thumb_key": "previews/slide-001/thumb.jpg",
        "manifest_key": "previews/slide-001/manifest.json",
        "low_tiles_prefix": "previews/slide-001/tiles/",
        "max_preview_level": 6,
        "tile_size": 256,
        "format": "jpg"
      }
    }]
  }'
```

4. **Get preview with signed URLs**:
```bash
curl http://localhost:3000/api/v1/slides/slide-001/preview
```

5. **Sign individual tile URLs as needed**:
```bash
curl -X POST http://localhost:3000/api/v1/tiles/sign \
  -H "Content-Type: application/json" \
  -d '{"key": "previews/slide-001/tiles/0/0_0.jpg"}'
```

## Event Types

| Event | Aggregate | Description |
|-------|-----------|-------------|
| `CaseUpserted` | case | Create or update a case |
| `SlideRegistered` | slide | Register a slide with metadata |
| `PreviewPublished` | preview | Mark preview as available in Wasabi |

## Scripts

```bash
npm run dev          # Start with hot reload
npm run build        # Build TypeScript
npm run start        # Start production server
npm run migrate      # Run migrations (deploy)
npm run migrate:dev  # Run migrations (dev)
npm run test         # Run tests
npm run test:watch   # Run tests in watch mode
npm run lint         # Lint code
npm run typecheck    # Type check
```

## License

Proprietary - SuperNavi
