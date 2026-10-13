"""Writes analysis/report.md and analysis/figures/*.png from results/<id>/*.csv.

    analysis/.venv/bin/python analysis/run_analysis.py [results/full-1]
"""

from __future__ import annotations

import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import memstats as ms  # noqa: E402

HERE = Path(__file__).parent

# Dataviz reference palette (light): categorical slots 1-3, ink and chrome.
COLOR = {"cutoff": "#2a78d6", "builtin": "#eb6834", "search": "#1baf7a"}
SURFACE, INK, INK2, MUTED, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
LENGTH = {0.5: "Shorter (×0.5)", 1.0: "Longer (×1)"}
TYPES = ["simple", "exact", "changed", "combine", "never"]

plt.rcParams.update({
    "font.family": "sans-serif", "font.size": 10, "axes.edgecolor": AXIS, "axes.labelcolor": INK2,
    "xtick.color": MUTED, "ytick.color": MUTED, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8,
    "axes.axisbelow": True, "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "axes.spines.top": False, "axes.spines.right": False, "axes.spines.left": False, "text.color": INK,
})


def pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def p_fmt(p: float) -> str:
    return "< 0.001" if p < 0.001 else f"{p:.3f}"


def md_table(df: pd.DataFrame) -> str:
    head = "| " + " | ".join(df.columns) + " |"
    sep = "| " + " | ".join("---" for _ in df.columns) + " |"
    rows = ["| " + " | ".join(str(v) for v in r) + " |" for r in df.itertuples(index=False)]
    return "\n".join([head, sep, *rows])


def legend(target, kind: str, **where):
    """Legend for the three designs, on an axes or (for small multiples) the figure."""
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch
    handles = [Line2D([0], [0], color=COLOR[d], lw=2) if kind == "line" else Patch(color=COLOR[d]) for d in ms.DESIGNS]
    target.legend(handles, [ms.DESIGN_LABEL[d] for d in ms.DESIGNS], ncol=3, frameon=False, fontsize=9,
                  labelcolor=INK2, handlelength=1.4, **(where or {"loc": "lower left", "bbox_to_anchor": (0, 1.02)}))


def main(source: Path, out_dir: Path) -> None:
    data = ms.load(source)
    figures_dir = out_dir / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)
    out: list[str] = []
    fact = data.answers[data.answers["question_type"] != "never"]
    never = data.answers[data.answers["question_type"] == "never"]
    scales = sorted(data.answers["scale"].unique())

    out.append("# Results: memory experiment\n")
    out.append(
        f"Source: `{source.relative_to(HERE.parent) if source.resolve().is_relative_to(HERE.parent.resolve()) else source}` · "
        f"{data.runs['conversation_id'].nunique()} conversations × {data.runs['design'].nunique()} designs × "
        f"{data.runs['repeat'].nunique()} repeats × {len(scales)} lengths = {len(data.runs)} runs · "
        f"{len(data.answers)} answers. Verdicts are final: a hand label overrides the grader "
        f"({data.answers['human_label'].notna().sum()} answers carry one). Unclear counts as not right "
        f"({(data.answers['verdict'] == 'unclear').sum()} answers).\n"
    )

    # ---- Accuracy with CIs -------------------------------------------------
    rows = []
    for s in scales:
        for d in ms.DESIGNS:
            f = fact[(fact.design == d) & (fact.scale == s)]
            n_ = never[(never.design == d) & (never.scale == s)]
            lo, hi = ms.bootstrap_ci(f, "right")
            rows.append({"Length": LENGTH[s], "Design": ms.DESIGN_LABEL[d],
                         "Fact questions right": f"{pct(f.right.mean())} ({f.right.sum()}/{len(f)})",
                         "95% CI": f"{pct(lo)} to {pct(hi)}",
                         "Never-said right": f"{pct(n_.right.mean())} ({n_.right.sum()}/{len(n_)})"})
    out.append("## Accuracy\n")
    out.append("Fact questions exclude the \"never said\" questions. Intervals resample whole conversations (2,000 draws).\n")
    out.append(md_table(pd.DataFrame(rows)) + "\n")

    # ---- Significance: designs within each length ---------------------------
    out.append("## Are the designs different? (fact questions)\n")
    out.append("Matched items: the same question, conversation, length and repeat answered by all three designs. "
               "Cochran's Q across the three, then pairwise exact McNemar with Holm correction. The accuracy "
               "difference has a conversation-level bootstrap interval, because answers within a conversation are correlated.\n")
    for s in scales:
        m = ms.matched_items(fact[fact.scale == s])
        q, p = ms.cochran(m)
        out.append(f"**{LENGTH[s]}** · {len(m)} matched items · Cochran's Q = {q:.1f}, p {p_fmt(p)}\n")
        pw = ms.pairwise_mcnemar(m)
        rows = []
        for r in pw.itertuples():
            diff, lo, hi = ms.paired_difference_ci(m, r.a, r.b)
            rows.append({"Comparison": f"{ms.DESIGN_LABEL[r.a]} vs {ms.DESIGN_LABEL[r.b]}",
                         "Difference": f"{100 * diff:+.1f} pts ({100 * lo:+.1f} to {100 * hi:+.1f})",
                         "Only first right / only second right": f"{r.a_only_right} / {r.b_only_right}",
                         "p (Holm)": p_fmt(r.p_holm)})
        out.append(md_table(pd.DataFrame(rows)) + "\n")

    # ---- Forgetting: length effect per design ---------------------------------
    out.append("## Forgetting: shorter vs longer conversations (fact questions)\n")
    out.append("Same design, question and repeat at both lengths; exact McNemar.\n")
    rows = []
    for d in ms.DESIGNS:
        e = ms.length_effect(fact, d)
        rows.append({"Design": ms.DESIGN_LABEL[d], "×0.5": pct(e["short"]), "×1": pct(e["long"]),
                     "Drop": f"{100 * e['drop']:.1f} pts", "Pairs": e["n"], "p": p_fmt(e["p"])})
    out.append(md_table(pd.DataFrame(rows)) + "\n")

    # ---- By question type ------------------------------------------------------
    out.append("## By question type\n")
    t = ms.accuracy_table(data.answers, ["scale", "question_type", "design"])
    rows = []
    for s in scales:
        for qt in TYPES:
            r = {"Length": LENGTH[s], "Type": qt}
            for d in ms.DESIGNS:
                x = t[(t.scale == s) & (t.question_type == qt) & (t.design == d)].iloc[0]
                r[ms.DESIGN_LABEL[d]] = f"{pct(x.accuracy)} ({x.right}/{x.n})"
            rows.append(r)
    out.append(md_table(pd.DataFrame(rows)) + "\n")

    # ---- Reply time and cost ---------------------------------------------------
    pr = ms.per_run(data)
    out.append("## Reply time\n")
    out.append("Wall-clock time per reply, as a user would wait. Per run: median and 90th percentile of its turns; "
               "tests use each run's median, matched on (conversation, length, repeat): Friedman, then Wilcoxon with Holm.\n")
    turn_rows = []
    for s in scales:
        for d in ms.DESIGNS:
            lat = data.turns[(data.turns.design == d) & (data.turns.scale == s)]["latency_ms"]
            turn_rows.append({"Length": LENGTH[s], "Design": ms.DESIGN_LABEL[d], "Median": f"{lat.median() / 1000:.2f} s",
                              "p90": f"{np.quantile(lat, 0.9) / 1000:.2f} s", "Turns": len(lat)})
    out.append(md_table(pd.DataFrame(turn_rows)) + "\n")
    stat, p, n = ms.friedman(pr, "median_ms")
    out.append(f"Friedman χ² = {stat:.1f}, p {p_fmt(p)} ({n} matched blocks).\n")
    out.append(md_table(pd.DataFrame([{"Comparison": f"{ms.DESIGN_LABEL[r.a]} vs {ms.DESIGN_LABEL[r.b]}",
                                       "Median of run medians": f"{r.median_a / 1000:.2f} s vs {r.median_b / 1000:.2f} s",
                                       "p (Holm)": p_fmt(r.p_holm)} for r in ms.pairwise_wilcoxon(pr, "median_ms").itertuples()])) + "\n")

    out.append("## Cost\n")
    out.append("Workers AI neurons per run: every model call in the run's turns plus built-in's compaction summaries "
               f"(Qwen3-30B prices: {ms.INPUT_NEURONS_PER_M:,} neurons per million input tokens, {ms.OUTPUT_NEURONS_PER_M:,} per million output).\n")
    rows = []
    for s in scales:
        for d in ms.DESIGNS:
            x = pr[(pr.design == d) & (pr.scale == s)]
            rows.append({"Length": LENGTH[s], "Design": ms.DESIGN_LABEL[d], "Neurons per run": f"{x.neurons.mean():.0f}",
                         "Of which summaries": f"{ms.neurons(x.compaction_input_tokens, x.compaction_output_tokens).mean():.0f}",
                         "USD per 1,000 runs": f"${x.neurons.mean() * ms.USD_PER_1000_NEURONS:.2f}"})
    out.append(md_table(pd.DataFrame(rows)) + "\n")
    total = pr.neurons.sum()
    out.append(f"Whole experiment: {total:,.0f} neurons (${total / 1000 * ms.USD_PER_1000_NEURONS:.2f}).\n")
    stat, p, n = ms.friedman(pr, "neurons")
    out.append(f"Friedman χ² = {stat:.1f}, p {p_fmt(p)} ({n} matched blocks).\n")
    out.append(md_table(pd.DataFrame([{"Comparison": f"{ms.DESIGN_LABEL[r.a]} vs {ms.DESIGN_LABEL[r.b]}",
                                       "Median neurons per run": f"{r.median_a:.0f} vs {r.median_b:.0f}",
                                       "p (Holm)": p_fmt(r.p_holm)} for r in ms.pairwise_wilcoxon(pr, "neurons").itertuples()])) + "\n")

    # ---- Built-in fact loss --------------------------------------------------------
    out.append("## Built-in memory block: facts saved and lost\n")
    out.append("From the memory block saved after every turn. A fact is lost if it was in the block and later "
               "disappeared while it still applied (dropping a value after it changed does not count).\n")
    fl = ms.fact_loss_table(data.fact_loss)
    out.append(md_table(pd.DataFrame([{"Length": LENGTH[r.scale], "Facts": r.facts, "Saved": f"{pct(r.saved_rate)} ({r.saved})",
                                       "Lost (of saved)": f"{pct(r.lost_rate_of_saved)} ({r.lost})",
                                       "Missing at end": r.missing_at_end} for r in fl.itertuples()])) + "\n")

    # ---- Grader agreement ---------------------------------------------------------
    g = ms.grader_agreement(data.labels, "full-1-sample-001")
    out.append("## Grader agreement\n")
    out.append(f"On {g['n']} blind hand-labelled answers (stratified by design and question type; answers the grader "
               f"flagged as unclear were reviewed separately and are not in this sample): agreement {g['agree']}/{g['n']} "
               f"({pct(g['agreement'])}), Cohen's κ = {g['kappa']:.2f}. The grader was not tuned on these answers.\n")
    conf = g["confusion"].reset_index()
    conf.columns = [str(c) for c in conf.columns]
    out.append(md_table(conf) + "\n")
    out.append("Disagreements:\n")
    ans = data.answers.set_index("answer_id")
    for r in g["disagreements"].itertuples():
        a = ans.loc[r.answer_id]
        out.append(f"- *{a.question}* ({r.question_type}, {ms.DESIGN_LABEL[r.design]}): grader **{r.rule_verdict}**, "
                   f"human **{r.label}**. Reply: \"{' '.join(str(a.answer).split())[:180]}\"")
    out.append("")

    (out_dir / "report.md").write_text("\n".join(out) + "\n")
    figures(data, fact, pr, scales, figures_dir)
    print(f"Wrote {out_dir / 'report.md'} and {len(list(figures_dir.glob('*.png')))} figures")


def figures(data: ms.Data, fact: pd.DataFrame, pr: pd.DataFrame, scales: list[float], FIGURES: Path) -> None:
    # 1. Forgetting curve with conversation-level 95% CIs and direct labels.
    fig, ax = plt.subplots(figsize=(7, 4))
    xs = np.arange(len(scales))
    for d in ms.DESIGNS:
        ys, los, his = [], [], []
        for s in scales:
            f = fact[(fact.design == d) & (fact.scale == s)]
            lo, hi = ms.bootstrap_ci(f, "right")
            ys.append(100 * f.right.mean()); los.append(100 * lo); his.append(100 * hi)
        ys, los, his = map(np.array, (ys, los, his))
        ax.vlines(xs, los, his, color=COLOR[d], lw=1, alpha=0.6)
        ax.plot(xs, ys, color=COLOR[d], lw=2, marker="o", ms=8, mec=SURFACE, mew=2, solid_capstyle="round")
        ax.annotate(f"{ms.DESIGN_LABEL[d]} {ys[-1]:.0f}%", (xs[-1], ys[-1]), xytext=(10, 0), textcoords="offset points",
                    va="center", color=INK2, fontsize=9)
    ax.set_xticks(xs, [LENGTH[s] for s in scales])
    ax.set_xlim(-0.25, len(scales) - 1 + 0.9)
    ax.set_ylim(0, 100)
    ax.set_yticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
    ax.grid(axis="x", visible=False)
    ax.set_title("Fact questions answered right, by conversation length", loc="left", fontsize=11, color=INK, pad=28)
    legend(ax, "line")
    fig.tight_layout()
    fig.savefig(FIGURES / "forgetting_curve.png", dpi=160)
    plt.close(fig)

    # 2. Accuracy by question type, one panel per length.
    t = ms.accuracy_table(data.answers, ["scale", "question_type", "design"])
    fig, axes = plt.subplots(1, len(scales), figsize=(10, 3.6), sharey=True)
    w = 0.24
    for ax, s in zip(np.atleast_1d(axes), scales):
        for i, d in enumerate(ms.DESIGNS):
            vals = [100 * t[(t.scale == s) & (t.question_type == q) & (t.design == d)].accuracy.iloc[0] for q in TYPES]
            ax.bar(np.arange(len(TYPES)) + (i - 1) * (w + 0.02), vals, width=w, color=COLOR[d])
        ax.set_xticks(np.arange(len(TYPES)), TYPES)
        ax.set_title(LENGTH[s], loc="left", fontsize=10, color=INK2)
        ax.set_ylim(0, 105)
        ax.set_yticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
        ax.grid(axis="x", visible=False)
    fig.suptitle("Answered right, by question type", x=0.01, y=0.98, ha="left", fontsize=11, color=INK)
    legend(fig, "rect", loc="upper left", bbox_to_anchor=(0.01, 0.93))
    fig.tight_layout(rect=(0, 0, 1, 0.9))
    fig.savefig(FIGURES / "accuracy_by_type.png", dpi=160)
    plt.close(fig)

    # 3. Reply time (median bar, p90 tick) and 4. cost per run, by length.
    for name, title, value, fmt in [
        ("reply_time", "Seconds per reply: bar = median, tick = 90th percentile", None, lambda v: f"{v:.1f} s"),
        ("cost", "Workers AI neurons per run (turns plus summaries)", "neurons", lambda v: f"{v:.0f}"),
    ]:
        fig, axes = plt.subplots(1, len(scales), figsize=(9, 3.4), sharey=True)
        for ax, s in zip(np.atleast_1d(axes), scales):
            for i, d in enumerate(ms.DESIGNS):
                if value is None:
                    lat = data.turns[(data.turns.design == d) & (data.turns.scale == s)]["latency_ms"] / 1000
                    v, p90 = lat.median(), np.quantile(lat, 0.9)
                    ax.hlines(p90, i - 0.22, i + 0.22, color=INK, lw=2)
                    ax.annotate(f"p90 {p90:.1f} s", (i + 0.25, p90), va="center", fontsize=8, color=INK2)
                else:
                    v = pr[(pr.design == d) & (pr.scale == s)][value].mean()
                ax.bar(i, v, width=0.35, color=COLOR[d])
                ax.annotate(fmt(v), (i, v), xytext=(0, 4), textcoords="offset points", ha="center", fontsize=8, color=INK2)
            ax.set_xticks(range(3), [ms.DESIGN_LABEL[d] for d in ms.DESIGNS])
            ax.set_xlim(-0.5, 2.95)  # room for the last bar's p90 label
            ax.set_title(LENGTH[s], loc="left", fontsize=10, color=INK2)
            ax.grid(axis="x", visible=False)
        if value is None:
            top = max(np.quantile(data.turns[data.turns.design == d]["latency_ms"] / 1000, 0.9) for d in ms.DESIGNS)
            np.atleast_1d(axes)[0].set_ylim(0, top * 1.15)
        fig.suptitle(title, x=0.01, ha="left", fontsize=11, color=INK)
        fig.tight_layout()
        fig.savefig(FIGURES / f"{name}.png", dpi=160)
        plt.close(fig)


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "results" / "full-1", HERE)
