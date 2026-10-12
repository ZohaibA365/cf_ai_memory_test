-- Summary attempts skipped by the retry guard (no model call, no cost).
ALTER TABLE runs ADD COLUMN compaction_skipped INTEGER NOT NULL DEFAULT 0;
