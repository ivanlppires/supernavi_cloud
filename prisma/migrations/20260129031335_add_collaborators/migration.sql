-- AlterTable
ALTER TABLE "cases_read" ADD COLUMN     "owner_id" UUID;

-- CreateTable
CREATE TABLE "case_collaborators" (
    "id" UUID NOT NULL,
    "case_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'collaborator',
    "invited_by" UUID,
    "invited_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "case_collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "case_collaborators_user_id_idx" ON "case_collaborators"("user_id");

-- CreateIndex
CREATE INDEX "case_collaborators_status_idx" ON "case_collaborators"("status");

-- CreateIndex
CREATE UNIQUE INDEX "case_collaborators_case_id_user_id_key" ON "case_collaborators"("case_id", "user_id");

-- CreateIndex
CREATE INDEX "cases_read_owner_id_idx" ON "cases_read"("owner_id");

-- AddForeignKey
ALTER TABLE "case_collaborators" ADD CONSTRAINT "case_collaborators_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases_read"("case_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_collaborators" ADD CONSTRAINT "case_collaborators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
