-- Cloud-First Pivot: add labs, edge_keys, case_bindings tables + slides_read cloud fields

-- Labs (tenants)
CREATE TABLE "labs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "labs_pkey" PRIMARY KEY ("id")
);

-- Edge device authentication keys
CREATE TABLE "edge_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lab_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "edge_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "edge_keys_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "labs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "edge_keys_key_hash_idx" ON "edge_keys"("key_hash");
CREATE INDEX "edge_keys_lab_id_idx" ON "edge_keys"("lab_id");

-- Case bindings (pathoweb_ref <-> slide)
CREATE TABLE "case_bindings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lab_id" UUID NOT NULL,
    "pathoweb_ref" TEXT NOT NULL,
    "slide_id" TEXT NOT NULL,
    "bound_by_user_id" UUID,
    "bound_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "case_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "case_bindings_pathoweb_ref_slide_id_key" UNIQUE ("pathoweb_ref", "slide_id")
);

CREATE INDEX "case_bindings_lab_id_idx" ON "case_bindings"("lab_id");
CREATE INDEX "case_bindings_pathoweb_ref_idx" ON "case_bindings"("pathoweb_ref");
CREATE INDEX "case_bindings_slide_id_idx" ON "case_bindings"("slide_id");

-- Add cloud-first fields to slides_read
ALTER TABLE "slides_read" ADD COLUMN "lab_id" UUID;
ALTER TABLE "slides_read" ADD COLUMN "cloud_status" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "slides_read" ADD COLUMN "dzi_url" TEXT;
ALTER TABLE "slides_read" ADD COLUMN "tile_count" INTEGER;
ALTER TABLE "slides_read" ADD COLUMN "s3_prefix" TEXT;

CREATE INDEX "slides_read_lab_id_cloud_status_idx" ON "slides_read"("lab_id", "cloud_status");
