-- The AI judge's second opinion on each answer. Kept apart from the rule
-- grader and the hand labels: it never feeds answer_verdicts or the
-- headline results.
CREATE TABLE judge_verdicts (
  answer_id TEXT NOT NULL REFERENCES answers (id),
  model TEXT NOT NULL,
  job_id TEXT NOT NULL,
  verdict TEXT CHECK (verdict IN ('right', 'wrong')),  -- NULL: unparsed
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  neurons REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (answer_id, model)
);
