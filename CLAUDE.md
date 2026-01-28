# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SuperNavi Cloud is the cloud component of a digital pathology system. It receives events from edge devices via an append-only event store pattern, projects them to read models, and provides signed URLs for remote preview access via Wasabi (S3-compatible).

**Key architectural decisions:**
- Edge-first: The SVS (whole slide image) files stay on edge. Cloud only stores preview data (thumb, manifest, low-res tiles).
- Event sourcing: All mutations come as events from edge via `POST /sync/v1/events`. Events are stored append-only with idempotency by `event_id`.
- Synchronous projections: After storing events, projections to read models happen in the same request transaction.
- Signed URLs: All S3/Wasabi access uses short-lived signed URLs with validation against known preview prefixes.

## Common Commands

```bash
# Development
npm run dev                    # Start with hot reload (requires DATABASE_URL)
docker compose --profile dev up supernavi_cloud_dev  # Full dev environment

# Database
npm run migrate:dev            # Create/run migrations in dev
npm run migrate                # Deploy migrations (production)
npm run db:studio              # Open Prisma Studio

# Testing
npm run test                   # Run all tests
npm run test:watch             # Watch mode
npm run test -- schemas        # Run single test file (by name filter)

# Build
npm run build                  # Compile TypeScript
npm run typecheck              # Type check without emit

# Docker
docker compose up -d           # Start production stack
docker compose up -d postgres  # Start only postgres for local dev
```

## Architecture

```
src/
├── config/         # Environment config with Zod validation
├── db/             # Prisma client and DB utilities
├── server/         # Fastify server setup and health routes
├── sync/           # Event ingestion (schemas, eventStore, projections, routes)
└── modules/
    ├── read/       # Read API (cases, slides, preview, tile proxy endpoints)
    └── wasabi/     # S3 signed URL generation
tests/              # Test files (vitest, mirrors src/ structure)
```

### Data Flow

1. Edge sends batch of events to `POST /sync/v1/events`
2. `eventStore.ts` deduplicates by `event_id`, inserts new events
3. `projections.ts` updates read models (`cases_read`, `slides_read`, `preview_assets`)
4. Read API serves data with signed URLs generated on-demand

### Key Files

- `prisma/schema.prisma` - Database schema (events table + read models)
- `src/sync/schemas.ts` - Zod schemas for all event types and payloads
- `src/sync/projections.ts` - Event-to-read-model projection logic
- `src/modules/wasabi/wasabiSigner.ts` - S3 URL signing with key validation

## Database Schema

- `events` - Append-only event log (source of truth)
- `cases_read` - Projected case data
- `slides_read` - Projected slide metadata
- `preview_assets` - Wasabi keys/prefixes for signed URL generation

## Event Types Handled

- `CaseUpserted` → upserts `cases_read`
- `SlideRegistered` → upserts `slides_read`
- `PreviewPublished` → upserts `preview_assets`, sets `slides_read.has_preview = true`

## Security Considerations

- Tile signing validates that requested key belongs to a known preview prefix
- Rate limiting: 100 req/min default
- CORS disabled by default
- Request body limit: 10MB
