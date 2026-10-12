-- Which grader rules produced each rule_verdict (v1: stage 2 rules; v2:
-- tuned on 12 hand-labelled pilot answers). Rows before this migration are v1.
ALTER TABLE answers ADD COLUMN grader_version INTEGER NOT NULL DEFAULT 1;
