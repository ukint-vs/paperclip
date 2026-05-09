ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_idempotency_key_uq"
  ON "issue_comments" ("company_id", "issue_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
