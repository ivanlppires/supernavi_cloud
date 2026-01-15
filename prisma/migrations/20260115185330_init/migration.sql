-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "edge_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cases_read" (
    "case_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "patient_ref" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "last_event_id" TEXT,
    "last_occurred_at" TIMESTAMPTZ,

    CONSTRAINT "cases_read_pkey" PRIMARY KEY ("case_id")
);

-- CreateTable
CREATE TABLE "slides_read" (
    "slide_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "svs_filename" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "mpp" DOUBLE PRECISION NOT NULL,
    "scanner" TEXT,
    "has_preview" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "last_event_id" TEXT,
    "last_occurred_at" TIMESTAMPTZ,

    CONSTRAINT "slides_read_pkey" PRIMARY KEY ("slide_id")
);

-- CreateTable
CREATE TABLE "preview_assets" (
    "slide_id" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "wasabi_bucket" TEXT NOT NULL,
    "wasabi_region" TEXT NOT NULL,
    "wasabi_endpoint" TEXT NOT NULL,
    "wasabi_prefix" TEXT NOT NULL,
    "thumb_key" TEXT NOT NULL,
    "manifest_key" TEXT NOT NULL,
    "low_tiles_prefix" TEXT NOT NULL,
    "max_preview_level" INTEGER NOT NULL,
    "tile_size" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_event_id" TEXT,
    "last_occurred_at" TIMESTAMPTZ,

    CONSTRAINT "preview_assets_pkey" PRIMARY KEY ("slide_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_event_id_key" ON "events"("event_id");

-- CreateIndex
CREATE INDEX "events_edge_id_idx" ON "events"("edge_id");

-- CreateIndex
CREATE INDEX "events_aggregate_type_aggregate_id_idx" ON "events"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "events_occurred_at_idx" ON "events"("occurred_at");

-- CreateIndex
CREATE INDEX "cases_read_status_idx" ON "cases_read"("status");

-- CreateIndex
CREATE INDEX "cases_read_updated_at_idx" ON "cases_read"("updated_at");

-- CreateIndex
CREATE INDEX "slides_read_case_id_idx" ON "slides_read"("case_id");

-- CreateIndex
CREATE INDEX "slides_read_has_preview_idx" ON "slides_read"("has_preview");

-- CreateIndex
CREATE INDEX "preview_assets_case_id_idx" ON "preview_assets"("case_id");

-- AddForeignKey
ALTER TABLE "slides_read" ADD CONSTRAINT "slides_read_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases_read"("case_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_assets" ADD CONSTRAINT "preview_assets_slide_id_fkey" FOREIGN KEY ("slide_id") REFERENCES "slides_read"("slide_id") ON DELETE CASCADE ON UPDATE CASCADE;
