-- CreateTable
CREATE TABLE "user_edges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "edge_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_edges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_edges_user_id_idx" ON "user_edges"("user_id");

-- CreateIndex
CREATE INDEX "user_edges_edge_id_idx" ON "user_edges"("edge_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_edges_user_id_edge_id_key" ON "user_edges"("user_id", "edge_id");

-- AddForeignKey
ALTER TABLE "user_edges" ADD CONSTRAINT "user_edges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
