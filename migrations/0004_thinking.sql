-- Reply thinking per run ("off" adds Qwen3's /no_think), for the stage 4 pilot.
ALTER TABLE runs ADD COLUMN thinking TEXT NOT NULL DEFAULT 'on';
