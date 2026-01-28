-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'pathologist',
    "avatar_url" TEXT,
    "crm" TEXT,
    "specialization" TEXT,
    "google_id" TEXT,
    "apple_id" TEXT,
    "password_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "last_login_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "user_id" UUID NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'light',
    "language" TEXT NOT NULL DEFAULT 'pt-BR',
    "default_zoom" INTEGER NOT NULL DEFAULT 1,
    "show_navigator" BOOLEAN NOT NULL DEFAULT true,
    "show_scale" BOOLEAN NOT NULL DEFAULT true,
    "auto_rotate" BOOLEAN NOT NULL DEFAULT false,
    "annotation_color" TEXT NOT NULL DEFAULT '#FF0000',
    "notifications_email" BOOLEAN NOT NULL DEFAULT true,
    "notifications_browser" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_apple_id_key" ON "users"("apple_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
