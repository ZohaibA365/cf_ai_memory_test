-- The grading coordinator records the rule grader's verdict next to the
-- judge's, from the same call. NULL for rows written before the coordinator.
ALTER TABLE judge_verdicts ADD COLUMN rule_verdict TEXT CHECK (rule_verdict IN ('right', 'wrong', 'unclear'));
ALTER TABLE judge_verdicts ADD COLUMN grader_version INTEGER;
