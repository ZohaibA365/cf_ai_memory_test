-- A run may use a variant of its design (e.g. the built-in design with the
-- original memory-block wording), and built-in turns record the memory block
-- after each turn so the pilot can measure when facts are lost.
ALTER TABLE runs ADD COLUMN variant TEXT NOT NULL DEFAULT 'main';
ALTER TABLE turns ADD COLUMN memory_block TEXT;
