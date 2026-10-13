"""Smoke test: the report and figures build from a small synthetic export."""

import numpy as np
import pandas as pd

import run_analysis

DESIGNS = ["cutoff", "builtin", "search"]
TYPES = ["simple", "exact", "changed", "combine", "never"]


def synthetic_export(d):
    rng = np.random.default_rng(0)
    runs, turns, answers, losses = [], [], [], []
    for c in range(4):
        for scale in (0.5, 1.0):
            for rep in (1, 2):
                for design in DESIGNS:
                    run_id = f"x--c{c}--{design}--{scale}--r{rep}"
                    runs.append({"run_id": run_id, "conversation_id": f"c{c}", "design": design, "variant": "main",
                                 "thinking": "on", "scale": scale, "repeat": rep, "model": "m", "budget_tokens": 2000,
                                 "compaction_calls": 0, "compaction_input_tokens": 100 if design == "builtin" else 0,
                                 "compaction_output_tokens": 10 if design == "builtin" else 0,
                                 "compaction_errors": 0, "compaction_skipped": 0})
                    for i in range(4):
                        turns.append({"run_id": run_id, "step_index": i, "step_id": f"s{i}", "kind": "ask",
                                      "history_messages": i, "latency_ms": int(rng.integers(1000, 5000)),
                                      "model_latency_ms": 900, "model_calls": 1, "input_tokens": 1000,
                                      "output_tokens": 100, "estimated_tokens": 1000})
                    p = {"cutoff": 0.4, "builtin": 0.8, "search": 0.9}[design]
                    for q, qt in enumerate(TYPES):
                        right = bool(rng.random() < p)
                        answers.append({"answer_id": f"{run_id}-{q}", "run_id": run_id, "question_id": f"q{q}",
                                        "question_type": qt, "question": f"Question {q}?", "answer": "an answer",
                                        "rule_verdict": "right" if right else "wrong", "grader_version": 3,
                                        "human_label": None, "verdict": "right" if right else "wrong"})
                    if design == "builtin":
                        losses.append({"run_id": run_id, "fact_id": "q0:0", "outdated_later": False,
                                       "saved": True, "lost": rep == 2, "missing_at_end": rep == 2})
    a = pd.DataFrame(answers)
    labels = a.head(10).assign(batch="full-1-sample-001", label=lambda x: x["verdict"])
    labels = labels.merge(pd.DataFrame(runs)[["run_id", "design", "scale"]], on="run_id")
    judge = a[["answer_id"]].assign(judge_verdict=np.where(rng.random(len(a)) < 0.95, a["verdict"], "wrong"))
    for name, df in [("runs", pd.DataFrame(runs)), ("turns", pd.DataFrame(turns)), ("answers", a), ("judge", judge),
                     ("labels", labels[["answer_id", "batch", "label", "rule_verdict", "question_type", "design", "scale"]]),
                     ("fact_loss", pd.DataFrame(losses))]:
        df.to_csv(d / f"{name}.csv", index=False)


def test_report_and_figures_build(tmp_path):
    src = tmp_path / "export"
    src.mkdir()
    synthetic_export(src)
    out = tmp_path / "out"
    out.mkdir()
    run_analysis.main(src, out)
    report = (out / "report.md").read_text()
    for heading in ["## Accuracy", "## Are the designs different?", "## Forgetting", "## Reply time", "## Cost",
                    "## Built-in memory block", "## Grader agreement", "## Second opinion: AI judge"]:
        assert heading in report
    assert sorted(p.name for p in (out / "figures").glob("*.png")) == [
        "accuracy_by_type.png", "cost.png", "forgetting_curve.png", "reply_time.png"]
