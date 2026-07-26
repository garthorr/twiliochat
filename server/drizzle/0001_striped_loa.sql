ALTER TABLE "conversations" ADD COLUMN "opted_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Message search uses ILIKE '%term%', which cannot use a btree index. A GIN
-- trigram index makes it indexable while keeping substring semantics.
-- Wrapped so the migration still succeeds where pg_trgm is unavailable
-- (e.g. the in-memory PGlite instance used by the test suite).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS messages_body_trgm_idx
    ON messages USING gin (body gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'skipping pg_trgm index: %', SQLERRM;
END $$;
