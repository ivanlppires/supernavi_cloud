-- CreateTable
CREATE TABLE "messages_read" (
    "id" UUID NOT NULL,
    "annotation_id" INTEGER NOT NULL,
    "author_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "ai_confidence" DOUBLE PRECISION,
    "ai_findings" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "messages_read_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_read_annotation_id_idx" ON "messages_read"("annotation_id");

-- CreateIndex
CREATE INDEX "messages_read_author_id_idx" ON "messages_read"("author_id");

-- CreateIndex
CREATE INDEX "messages_read_created_at_idx" ON "messages_read"("created_at");

-- AddForeignKey
ALTER TABLE "messages_read" ADD CONSTRAINT "messages_read_annotation_id_fkey" FOREIGN KEY ("annotation_id") REFERENCES "annotations_read"("id") ON DELETE CASCADE ON UPDATE CASCADE;
