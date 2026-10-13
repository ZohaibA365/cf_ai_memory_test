"""Statistics for the memory experiment (analysis of results/<experiment>/*.csv).

Every function here is pure and tested (analysis/tests). run_analysis.py
calls them to write the report and the figures.

Units of analysis
- Accuracy: each test question was answered by all three designs in the same
  conversation, length and repeat, so designs are compared on matched items
  (Cochran's Q, then pairwise exact McNemar). Items within a conversation are
  correlated, so intervals come from a bootstrap that resamples whole
  conversations rather than single answers.
- Reply time and cost: one value per run (median reply time; neurons), matched
  on (conversation, length, repeat): Friedman, then pairwise Wilcoxon.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from statsmodels.stats.contingency_tables import cochrans_q
from statsmodels.stats.multitest import multipletests

DESIGNS = ["cutoff", "builtin", "search"]
DESIGN_LABEL = {"cutoff": "Cut-off", "builtin": "Built-in memory", "search": "Search"}
# Workers AI prices for the experiment model (src/pricing.ts, 2026-10-12).
INPUT_NEURONS_PER_M = 4_625
OUTPUT_NEURONS_PER_M = 30_475
USD_PER_1000_NEURONS = 0.011
ITEM_KEYS = ["conversation_id", "question_id", "scale", "repeat"]
RUN_KEYS = ["conversation_id", "scale", "repeat"]


def neurons(input_tokens, output_tokens):
    return (np.asarray(input_tokens) * INPUT_NEURONS_PER_M + np.asarray(output_tokens) * OUTPUT_NEURONS_PER_M) / 1e6


# ---- Loading ----------------------------------------------------------------


@dataclass
class Data:
    runs: pd.DataFrame
    turns: pd.DataFrame
    answers: pd.DataFrame
    labels: pd.DataFrame
    fact_loss: pd.DataFrame
    # The AI judge's second opinion (judge.csv), when exported.
    judge: pd.DataFrame | None = None


def load(directory: str | Path) -> Data:
    """Reads the exported CSVs; answers and turns get their run's columns.

    Only main-variant, thinking-on runs (the experiment as reported).
    """
    d = Path(directory)
    runs = pd.read_csv(d / "runs.csv")
    runs = runs[(runs["variant"] == "main") & (runs["thinking"] == "on")].copy()
    cols = ["run_id", "conversation_id", "design", "scale", "repeat"]
    answers = pd.read_csv(d / "answers.csv").merge(runs[cols], on="run_id")
    turns = pd.read_csv(d / "turns.csv").merge(runs[cols], on="run_id")
    labels = pd.read_csv(d / "labels.csv")
    fact_loss = pd.read_csv(d / "fact_loss.csv").merge(runs[cols], on="run_id")
    answers["right"] = (answers["verdict"] == "right").astype(int)
    judge = pd.read_csv(d / "judge.csv") if (d / "judge.csv").exists() else None
    return Data(runs, turns, answers, labels, fact_loss, judge)


# ---- Accuracy -------------------------------------------------------------


def accuracy_table(answers: pd.DataFrame, by: list[str]) -> pd.DataFrame:
    """Right / total per group (unclear counts as not right)."""
    g = answers.groupby(by)["right"].agg(right="sum", n="count").reset_index()
    g["accuracy"] = g["right"] / g["n"]
    return g


def bootstrap_ci(
    df: pd.DataFrame, value: str, cluster: str = "conversation_id", n: int = 2000, seed: int = 1, level: float = 0.95
) -> tuple[float, float]:
    """CI for the mean of `value`, resampling whole clusters with replacement."""
    rng = np.random.default_rng(seed)
    sums = df.groupby(cluster)[value].agg(["sum", "count"])
    s, c = sums["sum"].to_numpy(), sums["count"].to_numpy()
    idx = rng.integers(0, len(s), size=(n, len(s)))
    means = s[idx].sum(axis=1) / c[idx].sum(axis=1)
    lo, hi = np.quantile(means, [(1 - level) / 2, 1 - (1 - level) / 2])
    return float(lo), float(hi)


def matched_items(answers: pd.DataFrame) -> pd.DataFrame:
    """One row per item answered by every design; columns = designs (1 = right)."""
    m = answers.pivot_table(index=ITEM_KEYS, columns="design", values="right", aggfunc="first")
    return m.dropna()[DESIGNS].astype(int)


def cochran(matrix: pd.DataFrame) -> tuple[float, float]:
    """Cochran's Q across the designs on matched binary outcomes: (Q, p)."""
    x = matrix.to_numpy()
    if (x.min(axis=1) == x.max(axis=1)).all():
        return 0.0, 1.0  # every item answered alike by all designs: no difference
    r = cochrans_q(x)
    return float(r.statistic), float(r.pvalue)


def mcnemar_exact(a: np.ndarray, b: np.ndarray) -> tuple[int, int, float]:
    """Exact McNemar: (a right & b wrong, a wrong & b right, two-sided p)."""
    a_only = int(((a == 1) & (b == 0)).sum())
    b_only = int(((a == 0) & (b == 1)).sum())
    n = a_only + b_only
    p = 1.0 if n == 0 else float(stats.binomtest(a_only, n, 0.5).pvalue)
    return a_only, b_only, p


def pairwise_mcnemar(matrix: pd.DataFrame) -> pd.DataFrame:
    """All design pairs, with Holm-adjusted p-values."""
    rows = []
    for i, x in enumerate(DESIGNS):
        for y in DESIGNS[i + 1 :]:
            x_only, y_only, p = mcnemar_exact(matrix[x].to_numpy(), matrix[y].to_numpy())
            rows.append({"a": x, "b": y, "accuracy_a": matrix[x].mean(), "accuracy_b": matrix[y].mean(),
                         "a_only_right": x_only, "b_only_right": y_only, "p": p})
    out = pd.DataFrame(rows)
    out["p_holm"] = multipletests(out["p"], method="holm")[1]
    return out


def paired_difference_ci(matrix: pd.DataFrame, a: str, b: str, n: int = 2000, seed: int = 1) -> tuple[float, float, float]:
    """Accuracy difference a - b with a conversation-level bootstrap CI."""
    df = matrix.reset_index()
    df["diff"] = df[a] - df[b]
    lo, hi = bootstrap_ci(df, "diff", n=n, seed=seed)
    return float(df["diff"].mean()), lo, hi


def length_effect(answers: pd.DataFrame, design: str, short: float = 0.5, long: float = 1.0) -> dict:
    """Same design, same question and repeat, short vs long conversation."""
    d = answers[answers["design"] == design]
    m = d.pivot_table(index=["conversation_id", "question_id", "repeat"], columns="scale", values="right", aggfunc="first").dropna()
    s_only, l_only, p = mcnemar_exact(m[short].to_numpy(), m[long].to_numpy())
    return {"design": design, "short": m[short].mean(), "long": m[long].mean(), "drop": m[short].mean() - m[long].mean(),
            "short_only_right": s_only, "long_only_right": l_only, "p": p, "n": len(m)}


# ---- Reply time and cost ----------------------------------------------------


def per_run(data: Data) -> pd.DataFrame:
    """Median and p90 reply time, and neurons (turns + summaries), per run."""
    t = data.turns.groupby("run_id").agg(
        median_ms=("latency_ms", "median"),
        p90_ms=("latency_ms", lambda x: float(np.quantile(x, 0.9))),
        input_tokens=("input_tokens", "sum"),
        output_tokens=("output_tokens", "sum"),
    ).reset_index()
    r = data.runs.merge(t, on="run_id")
    r["neurons"] = neurons(r["input_tokens"] + r["compaction_input_tokens"], r["output_tokens"] + r["compaction_output_tokens"])
    return r


def friedman(per_run_df: pd.DataFrame, value: str) -> tuple[float, float, int]:
    """Friedman test across designs, blocks = (conversation, length, repeat)."""
    m = per_run_df.pivot_table(index=RUN_KEYS, columns="design", values=value).dropna()[DESIGNS]
    r = stats.friedmanchisquare(*[m[d] for d in DESIGNS])
    return float(r.statistic), float(r.pvalue), len(m)


def pairwise_wilcoxon(per_run_df: pd.DataFrame, value: str) -> pd.DataFrame:
    m = per_run_df.pivot_table(index=RUN_KEYS, columns="design", values=value).dropna()[DESIGNS]
    rows = []
    for i, x in enumerate(DESIGNS):
        for y in DESIGNS[i + 1 :]:
            # Identical values in every block: no difference to test.
            p = 1.0 if (m[x] == m[y]).all() else float(stats.wilcoxon(m[x], m[y]).pvalue)
            rows.append({"a": x, "b": y, "median_a": m[x].median(), "median_b": m[y].median(), "p": p})
    out = pd.DataFrame(rows)
    out["p_holm"] = multipletests(out["p"], method="holm")[1]
    return out


# ---- Grader agreement -------------------------------------------------------


def cohen_kappa(a: list[str], b: list[str]) -> float:
    a, b = np.asarray(a), np.asarray(b)
    cats = sorted(set(a) | set(b))
    po = float((a == b).mean())
    pe = sum(float((a == c).mean()) * float((b == c).mean()) for c in cats)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def grader_agreement(labels: pd.DataFrame, batch: str) -> dict:
    """Grader vs human on one label batch (the blind sample, not the tuning set)."""
    d = labels[labels["batch"] == batch]
    confusion = pd.crosstab(d["rule_verdict"], d["label"], rownames=["grader"], colnames=["human"])
    return {
        "n": len(d),
        "agree": int((d["rule_verdict"] == d["label"]).sum()),
        "agreement": float((d["rule_verdict"] == d["label"]).mean()),
        "kappa": cohen_kappa(d["rule_verdict"].tolist(), d["label"].tolist()),
        "confusion": confusion,
        "disagreements": d[d["rule_verdict"] != d["label"]],
    }


# ---- Built-in fact loss ----------------------------------------------------------


def fact_loss_table(fact_loss: pd.DataFrame) -> pd.DataFrame:
    """Per length: facts saved to the memory block, and saved facts later lost."""
    g = fact_loss.groupby("scale").agg(facts=("fact_id", "count"), saved=("saved", "sum"), lost=("lost", "sum"),
                                       missing_at_end=("missing_at_end", "sum")).reset_index()
    g["saved_rate"] = g["saved"] / g["facts"]
    g["lost_rate_of_saved"] = g["lost"] / g["saved"]
    return g


# ---- AI judge (second opinion) ----------------------------------------------------


def judge_answers(answers: pd.DataFrame, judge: pd.DataFrame) -> pd.DataFrame:
    """The answers with the AI judge in place of the rule grader; hand labels still override.

    An unparsed judge verdict counts as not right, like the grader's unclear.
    """
    j = judge.set_index("answer_id")["judge_verdict"]
    missing = set(answers["answer_id"]) - set(j.index)
    if missing:
        raise ValueError(f"{len(missing)} answers have no judge verdict")
    out = answers.copy()
    judged = out["answer_id"].map(j).fillna("unclear")
    out["verdict"] = out["human_label"].where(out["human_label"].notna(), judged)
    out["right"] = (out["verdict"] == "right").astype(int)
    return out


def judge_agreement(labels: pd.DataFrame, judge: pd.DataFrame, batch: str) -> dict:
    """Judge vs human on one label batch."""
    d = labels[labels["batch"] == batch].merge(judge[["answer_id", "judge_verdict"]], on="answer_id")
    j = d["judge_verdict"].fillna("unparsed")
    return {"n": len(d), "agree": int((j == d["label"]).sum()), "agreement": float((j == d["label"]).mean()),
            "kappa": cohen_kappa(j.tolist(), d["label"].tolist()), "disagreements": d[j != d["label"]]}


def judge_vs_rule(answers: pd.DataFrame, judge: pd.DataFrame) -> pd.DataFrame:
    """Per design and question type: answers where the judge and the rule grader differ.

    The rule grader's unclear (left for review) is counted apart, not as a disagreement.
    """
    d = answers.merge(judge[["answer_id", "judge_verdict"]], on="answer_id")
    d["judge_verdict"] = d["judge_verdict"].fillna("unparsed")
    graded = d[d["rule_verdict"] != "unclear"]
    g = graded.groupby(["design", "question_type"]).apply(
        lambda x: pd.Series({
            "n": len(x),
            "differ": int((x["judge_verdict"] != x["rule_verdict"]).sum()),
            "judge_right_rule_wrong": int(((x["judge_verdict"] == "right") & (x["rule_verdict"] == "wrong")).sum()),
            "rule_right_judge_wrong": int(((x["judge_verdict"] != "right") & (x["rule_verdict"] == "right")).sum()),
        }), include_groups=False).reset_index()
    unclear = d[d["rule_verdict"] == "unclear"].groupby(["design", "question_type"]).size().rename("rule_unclear")
    return g.merge(unclear.reset_index(), on=["design", "question_type"], how="left").fillna({"rule_unclear": 0})


def conclusions(fact: pd.DataFrame, alpha: float = 0.05) -> list[dict]:
    """The headline claims on fact questions, each as (claim, value, holds?).

    Per length: each design's accuracy, Cochran's Q, and every pairwise
    McNemar (Holm); per design: the drop from the shorter to the longer length.
    """
    out = []
    for s in sorted(fact["scale"].unique()):
        m = matched_items(fact[fact["scale"] == s])
        for d in DESIGNS:
            out.append({"claim": f"{DESIGN_LABEL[d]} accuracy, ×{s:g}", "value": float(m[d].mean()), "holds": None})
        _, p = cochran(m)
        out.append({"claim": f"Designs differ, ×{s:g}", "value": p, "holds": p < alpha})
        for r in pairwise_mcnemar(m).itertuples():
            better, worse = (r.a, r.b) if r.accuracy_a >= r.accuracy_b else (r.b, r.a)
            out.append({"claim": f"{DESIGN_LABEL[better]} beats {DESIGN_LABEL[worse]}, ×{s:g}", "value": r.p_holm,
                        "holds": r.p_holm < alpha, "order": (better, worse)})
    for d in DESIGNS:
        e = length_effect(fact, d)
        out.append({"claim": f"{DESIGN_LABEL[d]} gets worse when longer", "value": e["p"],
                    "holds": bool(e["p"] < alpha and e["drop"] > 0)})
    return out


def robustness_table(rule_fact: pd.DataFrame, judge_fact: pd.DataFrame, alpha: float = 0.05) -> pd.DataFrame:
    """The headline claims under the rule grader and under the AI judge, side by side."""
    rows = []
    for a, b in zip(conclusions(rule_fact, alpha), conclusions(judge_fact, alpha)):
        if a["holds"] is None:
            rows.append({"claim": a["claim"], "rule": a["value"], "judge": b["value"], "kind": "accuracy", "same": None})
        else:
            # A pairwise claim also needs the same winner.
            same = a["holds"] == b["holds"] and a.get("order") == b.get("order")
            rows.append({"claim": a["claim"], "rule": a["value"], "judge": b["value"], "kind": "p",
                         "rule_holds": a["holds"], "judge_holds": b["holds"], "same": same})
    return pd.DataFrame(rows)


# The judge's two known failure modes in the full run: rejecting an exact
# value only for its punctuation ("552-019" when "552019" or "552 019" is
# accepted), and running out of output tokens (no verdict).
FORMAT_ONLY = r"hyphen|accepted formats?|allowed formats?|required formats?|accepted forms"


def judge_without_artifacts(answers: pd.DataFrame, judge: pd.DataFrame) -> pd.DataFrame:
    """Sensitivity check: the judge's verdicts, except that format-only rejections
    and unparsed outputs fall back to the rule grader's verdict."""
    j = judge.copy()
    fix = j["judge_reason"].fillna("").str.contains(FORMAT_ONLY, case=False, regex=True) | j["judge_verdict"].isna()
    j.loc[fix, "judge_verdict"] = j.loc[fix, "answer_id"].map(answers.set_index("answer_id")["rule_verdict"])
    return j

