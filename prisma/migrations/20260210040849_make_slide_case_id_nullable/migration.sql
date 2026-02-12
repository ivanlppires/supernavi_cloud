-- AlterTable
ALTER TABLE "preview_assets" ALTER COLUMN "case_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "slides_read" ALTER COLUMN "case_id" DROP NOT NULL;
