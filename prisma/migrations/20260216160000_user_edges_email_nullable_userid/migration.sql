-- AlterTable: make user_id nullable and add email column
ALTER TABLE "user_edges" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "user_edges" ADD COLUMN "email" TEXT;

-- Backfill email from existing users
UPDATE "user_edges" ue
SET email = u.email
FROM "users" u
WHERE ue.user_id = u.id AND ue.email IS NULL;

-- Now make email NOT NULL
ALTER TABLE "user_edges" ALTER COLUMN "email" SET NOT NULL;

-- Drop old unique constraint (user_id, edge_id) and create new one (email, edge_id)
ALTER TABLE "user_edges" DROP CONSTRAINT IF EXISTS "user_edges_user_id_edge_id_key";

CREATE UNIQUE INDEX "user_edges_email_edge_id_key" ON "user_edges"("email", "edge_id");

-- Add index on email
CREATE INDEX "user_edges_email_idx" ON "user_edges"("email");
