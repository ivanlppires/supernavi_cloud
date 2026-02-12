-- CreateTable
CREATE TABLE "extension_devices" (
    "id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "last_seen_at" TIMESTAMPTZ,

    CONSTRAINT "extension_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pairing_codes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "clinic_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "device_id" UUID,

    CONSTRAINT "pairing_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "extension_devices_clinic_id_idx" ON "extension_devices"("clinic_id");

-- CreateIndex
CREATE INDEX "extension_devices_token_hash_idx" ON "extension_devices"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "pairing_codes_code_key" ON "pairing_codes"("code");

-- CreateIndex
CREATE INDEX "pairing_codes_code_idx" ON "pairing_codes"("code");
