-- Results of the memory experiment. One run = one conversation played through
-- one design once. Writes are idempotent (natural keys + INSERT OR REPLACE)
-- so Workflow step retries never duplicate rows.

CREATE TABLE runs (
  id TEXT PRIMARY KEY,                -- the Workflow instance id
  experiment_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  design TEXT NOT NULL CHECK (design IN ('cutoff', 'builtin', 'search')),
  repeat INTEGER NOT NULL,
  model TEXT NOT NULL,
  budget_tokens INTEGER NOT NULL,
  filler_scale REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'errored')),
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- Compaction happens outside turns (built-in design only), so its cost is
  -- kept per run.
  compaction_calls INTEGER NOT NULL DEFAULT 0,
  compaction_input_tokens INTEGER NOT NULL DEFAULT 0,
  compaction_output_tokens INTEGER NOT NULL DEFAULT 0,
  compaction_errors INTEGER NOT NULL DEFAULT 0,
  compaction_neurons REAL NOT NULL DEFAULT 0
);
CREATE INDEX runs_by_experiment ON runs (experiment_id);

-- Every turn that called the model: planted facts, changes, and questions.
CREATE TABLE turns (
  run_id TEXT NOT NULL REFERENCES runs (id),
  step_index INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('say', 'ask')),
  history_messages INTEGER NOT NULL,  -- conversation length before this turn
  latency_ms INTEGER NOT NULL,        -- wall clock, as a user would wait
  model_latency_ms INTEGER,           -- from turn start to reply saved
  model_calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  estimated_tokens INTEGER,           -- the budget estimate for this turn
  neurons REAL NOT NULL,
  status TEXT NOT NULL,
  recovered INTEGER NOT NULL DEFAULT 0, -- 1 if rebuilt after a step retry
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step_index)
);

CREATE TABLE answers (
  id TEXT PRIMARY KEY,                -- opaque hash, safe to show labelers
  run_id TEXT NOT NULL REFERENCES runs (id),
  question_id TEXT NOT NULL,
  question_type TEXT NOT NULL CHECK (question_type IN ('simple', 'changed', 'exact', 'combine', 'never')),
  question TEXT NOT NULL,
  expected TEXT NOT NULL,             -- JSON: groups of accepted alternatives
  outdated TEXT NOT NULL,             -- JSON: outdated or confusable values
  answer TEXT NOT NULL,
  rule_verdict TEXT NOT NULL CHECK (rule_verdict IN ('right', 'wrong', 'unclear')),
  rule_reasons TEXT NOT NULL,         -- JSON array
  needs_review INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, question_id)
);

CREATE TABLE human_labels (
  answer_id TEXT NOT NULL REFERENCES answers (id),
  labeler TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('right', 'wrong', 'unclear')),
  note TEXT,
  batch TEXT NOT NULL,
  labeled_at TEXT NOT NULL,
  PRIMARY KEY (answer_id, labeler)
);

-- The verdict used in results: a human label when there is one, otherwise
-- the rule-based grade.
CREATE VIEW answer_verdicts AS
SELECT
  a.*,
  r.experiment_id,
  r.conversation_id,
  r.design,
  r.repeat,
  (SELECT h.label FROM human_labels h WHERE h.answer_id = a.id ORDER BY h.labeled_at DESC LIMIT 1) AS human_label,
  COALESCE(
    (SELECT h.label FROM human_labels h WHERE h.answer_id = a.id ORDER BY h.labeled_at DESC LIMIT 1),
    a.rule_verdict
  ) AS verdict
FROM answers a
JOIN runs r ON r.id = a.run_id;
