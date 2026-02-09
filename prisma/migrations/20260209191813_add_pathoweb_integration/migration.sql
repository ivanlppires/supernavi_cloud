-- AlterTable
ALTER TABLE "slides_read" ADD COLUMN     "confirmed_case_link" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "external_case_base" TEXT,
ADD COLUMN     "external_case_id" TEXT,
ADD COLUMN     "external_slide_label" TEXT,
ADD COLUMN     "ready_for_review_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "viewer_audit_log" (
    "id" UUID NOT NULL,
    "slide_id" TEXT NOT NULL,
    "external_case_id" TEXT,
    "action" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "viewer_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "viewer_audit_log_slide_id_idx" ON "viewer_audit_log"("slide_id");

-- CreateIndex
CREATE INDEX "viewer_audit_log_external_case_id_idx" ON "viewer_audit_log"("external_case_id");

-- CreateIndex
CREATE INDEX "viewer_audit_log_created_at_idx" ON "viewer_audit_log"("created_at");

-- CreateIndex
CREATE INDEX "slides_read_external_case_id_idx" ON "slides_read"("external_case_id");

-- CreateIndex
CREATE INDEX "slides_read_external_case_base_idx" ON "slides_read"("external_case_base");
