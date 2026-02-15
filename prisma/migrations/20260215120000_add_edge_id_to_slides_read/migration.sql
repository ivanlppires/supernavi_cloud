-- AlterTable
ALTER TABLE "slides_read" ADD COLUMN "edge_id" TEXT;

-- CreateIndex
CREATE INDEX "slides_read_edge_id_idx" ON "slides_read"("edge_id");

-- Backfill edge_id from events table
UPDATE slides_read sr
SET edge_id = e.edge_id
FROM events e
WHERE e.type = 'SlideRegistered'
  AND e.aggregate_id = sr.slide_id
  AND sr.edge_id IS NULL;
