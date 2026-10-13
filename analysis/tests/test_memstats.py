import numpy as np
import pandas as pd
import pytest

import memstats as ms


def answers_frame(rows):
    """rows: (conversation, question, scale, repeat, design, right)."""
    df = pd.DataFrame(rows, columns=["conversation_id", "question_id", "scale", "repeat", "design", "right"])
    df["question_type"] = "simple"
    return df


def test_neurons_match_the_typescript_pricing():
    # 1M input tokens = 4,625 neurons; 1M output = 30,475 (src/pricing.ts).
    assert ms.neurons(1_000_000, 0) == pytest.approx(4625)
    assert ms.neurons(0, 1_000_000) == pytest.approx(30475)


def test_accuracy_table():
    df = answers_frame([("c1", "q1", 0.5, 1, "search", 1), ("c1", "q2", 0.5, 1, "search", 0)])
    t = ms.accuracy_table(df, ["design"])
    assert t.loc[0, "right"] == 1 and t.loc[0, "n"] == 2 and t.loc[0, "accuracy"] == 0.5


def test_bootstrap_ci_resamples_whole_conversations():
    # Two conversations: one all right, one all wrong; resampling conversations
    # gives means of 0, 0.5 or 1 only, and the interval brackets 0.5.
    df = pd.DataFrame({"conversation_id": ["a"] * 10 + ["b"] * 10, "v": [1] * 10 + [0] * 10})
    lo, hi = ms.bootstrap_ci(df, "v", n=500, seed=3)
    assert lo <= 0.5 <= hi
    assert lo == 0.0 and hi == 1.0
    assert ms.bootstrap_ci(df, "v", n=500, seed=3) == (lo, hi)


def test_matched_items_keeps_only_items_every_design_answered():
    rows = []
    for d, r in [("cutoff", 0), ("builtin", 1), ("search", 1)]:
        rows.append(("c1", "q1", 0.5, 1, d, r))
    rows.append(("c1", "q2", 0.5, 1, "search", 1))  # not answered by the others
    m = ms.matched_items(answers_frame(rows))
    assert list(m.columns) == ms.DESIGNS
    assert m.to_numpy().tolist() == [[0, 1, 1]]


def test_mcnemar_exact_counts_discordant_pairs():
    a = np.array([1, 1, 1, 0, 0, 1])
    b = np.array([0, 0, 1, 0, 1, 1])
    a_only, b_only, p = ms.mcnemar_exact(a, b)
    assert (a_only, b_only) == (2, 1)
    assert p == pytest.approx(1.0)  # 2 vs 1 of 3 discordant: no evidence
    assert ms.mcnemar_exact(np.ones(5), np.ones(5)) == (0, 0, 1.0)


def test_cochran_and_pairwise_mcnemar_detect_a_clear_difference():
    rng = np.random.default_rng(0)
    n = 200
    m = pd.DataFrame({
        "cutoff": (rng.random(n) < 0.3).astype(int),
        "builtin": (rng.random(n) < 0.85).astype(int),
        "search": (rng.random(n) < 0.9).astype(int),
    })
    q, p = ms.cochran(m)
    assert q > 50 and p < 1e-10
    pw = ms.pairwise_mcnemar(m).set_index(["a", "b"])
    assert pw.loc[("cutoff", "search"), "p_holm"] < 1e-10
    assert (pw["p_holm"] >= pw["p"]).all()


def test_cochran_finds_nothing_when_designs_agree():
    m = pd.DataFrame({d: [1, 0, 1, 1, 0, 1, 0, 1] for d in ms.DESIGNS})
    assert ms.cochran(m) == (0.0, 1.0)


def test_paired_difference_ci():
    m = pd.DataFrame({
        "conversation_id": ["a", "a", "b", "b"], "question_id": ["q1", "q2", "q1", "q2"],
        "scale": 0.5, "repeat": 1,
        "cutoff": [0, 0, 1, 0], "builtin": [1, 1, 1, 1], "search": [1, 1, 1, 1],
    }).set_index(ms.ITEM_KEYS)
    diff, lo, hi = ms.paired_difference_ci(m, "search", "cutoff", n=300)
    assert diff == pytest.approx(0.75)
    assert lo <= diff <= hi


def test_length_effect_pairs_the_same_question_across_lengths():
    rows = []
    for q in range(6):
        rows.append(("c1", f"q{q}", 0.5, 1, "cutoff", 1))
        rows.append(("c1", f"q{q}", 1.0, 1, "cutoff", 1 if q < 1 else 0))
    e = ms.length_effect(answers_frame(rows), "cutoff")
    assert e["n"] == 6 and e["short"] == 1.0 and e["long"] == pytest.approx(1 / 6)
    assert e["short_only_right"] == 5 and e["long_only_right"] == 0


def test_friedman_and_wilcoxon_on_per_run_values():
    rows = []
    for c in range(12):
        for d, base in [("cutoff", 2000), ("builtin", 5000), ("search", 2100)]:
            rows.append({"conversation_id": f"c{c}", "scale": 0.5, "repeat": 1, "design": d, "median_ms": base + c * 10 + (d == "search") * 3})
    df = pd.DataFrame(rows)
    stat, p, n = ms.friedman(df, "median_ms")
    assert n == 12 and p < 0.001
    pw = ms.pairwise_wilcoxon(df, "median_ms").set_index(["a", "b"])
    assert pw.loc[("cutoff", "builtin"), "p_holm"] < 0.01


def test_cohen_kappa():
    # Agreement 0.75, chance agreement 0.5 -> kappa 0.5.
    assert ms.cohen_kappa(["right", "right", "wrong", "wrong"], ["right", "right", "wrong", "right"]) == pytest.approx(0.5)
    assert ms.cohen_kappa(["right", "wrong"], ["right", "wrong"]) == pytest.approx(1.0)


def test_grader_agreement_uses_only_the_named_batch():
    labels = pd.DataFrame({
        "batch": ["tuning", "blind", "blind", "blind"],
        "label": ["wrong", "right", "right", "wrong"],
        "rule_verdict": ["right", "right", "wrong", "wrong"],
    })
    g = ms.grader_agreement(labels, "blind")
    assert g["n"] == 3 and g["agree"] == 2
    assert len(g["disagreements"]) == 1


def test_fact_loss_table():
    fl = pd.DataFrame({"scale": [0.5] * 4, "fact_id": list("abcd"), "saved": [True, True, True, False],
                       "lost": [True, False, False, False], "missing_at_end": [True, False, False, False]})
    t = ms.fact_loss_table(fl).iloc[0]
    assert t["saved_rate"] == 0.75 and t["lost_rate_of_saved"] == pytest.approx(1 / 3)


def test_judge_answers_swaps_the_grader_but_hand_labels_still_override():
    answers = pd.DataFrame({"answer_id": ["a", "b", "c"], "human_label": ["wrong", None, None],
                            "rule_verdict": ["right", "right", "wrong"], "verdict": ["wrong", "right", "wrong"]})
    judge = pd.DataFrame({"answer_id": ["a", "b", "c"], "judge_verdict": ["right", "wrong", None]})
    out = ms.judge_answers(answers, judge)
    assert out["verdict"].tolist() == ["wrong", "wrong", "unclear"]  # label wins; unparsed is not right
    assert out["right"].tolist() == [0, 0, 0]
    with pytest.raises(ValueError):
        ms.judge_answers(answers, judge.head(2))


def test_judge_vs_rule_counts_both_directions_and_sets_unclear_apart():
    answers = pd.DataFrame({"answer_id": list("abcd"), "design": "search", "question_type": "simple",
                            "rule_verdict": ["right", "wrong", "right", "unclear"]})
    judge = pd.DataFrame({"answer_id": list("abcd"), "judge_verdict": ["wrong", "right", "right", "right"]})
    r = ms.judge_vs_rule(answers, judge).iloc[0]
    assert (r.n, r.differ, r.judge_right_rule_wrong, r.rule_right_judge_wrong, r.rule_unclear) == (3, 2, 1, 1, 1)


def test_robustness_table_flags_a_changed_conclusion():
    rows = []
    for c in range(6):
        for q in range(10):
            for scale in (0.5, 1.0):
                for d, right in [("cutoff", 0), ("builtin", int(q < 9)), ("search", 1)]:
                    rows.append((f"c{c}", f"q{q}", scale, 1, d, right))
    rule = answers_frame(rows)
    same = ms.robustness_table(rule, rule)
    assert same.loc[same.kind == "p", "same"].all()
    # Under the "judge", cut-off is right everywhere: it no longer loses to anything.
    judged = rule.assign(right=np.where(rule.design == "cutoff", 1, rule.right))
    t = ms.robustness_table(rule, judged)
    changed = t[(t.kind == "p") & ~t.same.astype(bool)]["claim"].tolist()
    assert "Search beats Cut-off, ×0.5" in changed
    assert "Built-in memory beats Cut-off, ×0.5" in changed


def test_judge_without_artifacts_falls_back_only_for_format_and_unparsed():
    answers = pd.DataFrame({"answer_id": list("abc"), "rule_verdict": ["right", "right", "right"]})
    judge = pd.DataFrame({"answer_id": list("abc"), "judge_verdict": ["wrong", None, "wrong"],
                          "judge_reason": ["Uses a hyphen (552-019), not an accepted format.", "unparsed judge output",
                                           "Names the old city."]})
    assert ms.judge_without_artifacts(answers, judge)["judge_verdict"].tolist() == ["right", "right", "wrong"]

