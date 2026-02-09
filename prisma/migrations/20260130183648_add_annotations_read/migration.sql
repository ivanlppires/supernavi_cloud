-- CreateTable
CREATE TABLE "annotations_read" (
    "id" SERIAL NOT NULL,
    "slide_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#FF0000',
    "type" TEXT NOT NULL DEFAULT 'rectangle',
    "coordinates" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "annotations_read_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "annotations_read_slide_id_idx" ON "annotations_read"("slide_id");

-- CreateIndex
CREATE INDEX "annotations_read_created_by_idx" ON "annotations_read"("created_by");

-- CreateIndex
CREATE INDEX "annotations_read_status_idx" ON "annotations_read"("status");
