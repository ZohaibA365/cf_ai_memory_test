# Results: memory experiment

Source: `results/full-1` · 20 conversations × 3 designs × 3 repeats × 2 lengths = 360 runs · 2520 answers. Verdicts are final: a hand label overrides the grader (112 answers carry one). Unclear counts as not right (0 answers).

## Accuracy

Fact questions exclude the "never said" questions. Intervals resample whole conversations (2,000 draws).

| Length | Design | Fact questions right | 95% CI | Never-said right |
| --- | --- | --- | --- | --- |
| Shorter (×0.5) | Cut-off | 38.7% (116/300) | 32.7% to 45.7% | 99.2% (119/120) |
| Shorter (×0.5) | Built-in memory | 87.3% (262/300) | 81.7% to 92.7% | 99.2% (119/120) |
| Shorter (×0.5) | Search | 94.7% (284/300) | 91.3% to 97.7% | 95.8% (115/120) |
| Longer (×1) | Cut-off | 6.7% (20/300) | 3.0% to 10.7% | 98.3% (118/120) |
| Longer (×1) | Built-in memory | 79.3% (238/300) | 74.0% to 84.3% | 99.2% (119/120) |
| Longer (×1) | Search | 94.0% (282/300) | 90.7% to 97.3% | 93.3% (112/120) |

## Are the designs different? (fact questions)

Matched items: the same question, conversation, length and repeat answered by all three designs. Cochran's Q across the three, then pairwise exact McNemar with Holm correction. The accuracy difference has a conversation-level bootstrap interval, because answers within a conversation are correlated.

**Shorter (×0.5)** · 300 matched items · Cochran's Q = 242.8, p < 0.001

| Comparison | Difference | Only first right / only second right | p (Holm) |
| --- | --- | --- | --- |
| Cut-off vs Built-in memory | -48.7 pts (-57.0 to -39.7) | 14 / 160 | < 0.001 |
| Cut-off vs Search | -56.0 pts (-63.7 to -47.3) | 9 / 177 | < 0.001 |
| Built-in memory vs Search | -7.3 pts (-12.7 to -1.7) | 15 / 37 | 0.003 |

**Longer (×1)** · 300 matched items · Cochran's Q = 423.3, p < 0.001

| Comparison | Difference | Only first right / only second right | p (Holm) |
| --- | --- | --- | --- |
| Cut-off vs Built-in memory | -72.7 pts (-79.0 to -66.3) | 0 / 218 | < 0.001 |
| Cut-off vs Search | -87.3 pts (-92.0 to -82.3) | 2 / 264 | < 0.001 |
| Built-in memory vs Search | -14.7 pts (-20.7 to -9.0) | 15 / 59 | < 0.001 |

## Forgetting: shorter vs longer conversations (fact questions)

Same design, question and repeat at both lengths; exact McNemar.

| Design | ×0.5 | ×1 | Drop | Pairs | p |
| --- | --- | --- | --- | --- | --- |
| Cut-off | 38.7% | 6.7% | 32.0 pts | 300 | < 0.001 |
| Built-in memory | 87.3% | 79.3% | 8.0 pts | 300 | 0.002 |
| Search | 94.7% | 94.0% | 0.7 pts | 300 | 0.727 |

## By question type

| Length | Type | Cut-off | Built-in memory | Search |
| --- | --- | --- | --- | --- |
| Shorter (×0.5) | simple | 33.3% (20/60) | 100.0% (60/60) | 100.0% (60/60) |
| Shorter (×0.5) | exact | 25.0% (30/120) | 79.2% (95/120) | 100.0% (120/120) |
| Shorter (×0.5) | changed | 68.3% (41/60) | 96.7% (58/60) | 73.3% (44/60) |
| Shorter (×0.5) | combine | 41.7% (25/60) | 81.7% (49/60) | 100.0% (60/60) |
| Shorter (×0.5) | never | 99.2% (119/120) | 99.2% (119/120) | 95.8% (115/120) |
| Longer (×1) | simple | 5.0% (3/60) | 100.0% (60/60) | 100.0% (60/60) |
| Longer (×1) | exact | 0.8% (1/120) | 65.8% (79/120) | 98.3% (118/120) |
| Longer (×1) | changed | 26.7% (16/60) | 95.0% (57/60) | 73.3% (44/60) |
| Longer (×1) | combine | 0.0% (0/60) | 70.0% (42/60) | 100.0% (60/60) |
| Longer (×1) | never | 98.3% (118/120) | 99.2% (119/120) | 93.3% (112/120) |

## Reply time

Wall-clock time per reply, as a user would wait. Per run: median and 90th percentile of its turns; tests use each run's median, matched on (conversation, length, repeat): Friedman, then Wilcoxon with Holm.

| Length | Design | Median | p90 | Turns |
| --- | --- | --- | --- | --- |
| Shorter (×0.5) | Cut-off | 2.15 s | 3.50 s | 840 |
| Shorter (×0.5) | Built-in memory | 4.76 s | 9.86 s | 840 |
| Shorter (×0.5) | Search | 2.11 s | 3.43 s | 840 |
| Longer (×1) | Cut-off | 2.53 s | 4.01 s | 840 |
| Longer (×1) | Built-in memory | 5.39 s | 10.82 s | 840 |
| Longer (×1) | Search | 2.34 s | 3.88 s | 840 |

Friedman χ² = 182.8, p < 0.001 (120 matched blocks).

| Comparison | Median of run medians | p (Holm) |
| --- | --- | --- |
| Cut-off vs Built-in memory | 2.37 s vs 5.21 s | < 0.001 |
| Cut-off vs Search | 2.37 s vs 2.25 s | 0.013 |
| Built-in memory vs Search | 5.21 s vs 2.25 s | < 0.001 |

## Cost

Workers AI neurons per run: every model call in the run's turns plus built-in's compaction summaries (Qwen3-30B prices: 4,625 neurons per million input tokens, 30,475 per million output).

| Length | Design | Neurons per run | Of which summaries | USD per 1,000 runs |
| --- | --- | --- | --- | --- |
| Shorter (×0.5) | Cut-off | 192 | 0 | $2.11 |
| Shorter (×0.5) | Built-in memory | 472 | 198 | $5.20 |
| Shorter (×0.5) | Search | 191 | 0 | $2.10 |
| Longer (×1) | Cut-off | 203 | 0 | $2.23 |
| Longer (×1) | Built-in memory | 677 | 387 | $7.45 |
| Longer (×1) | Search | 200 | 0 | $2.20 |

Whole experiment: 116,128 neurons ($1.28).

Friedman χ² = 180.6, p < 0.001 (120 matched blocks).

| Comparison | Median neurons per run | p (Holm) |
| --- | --- | --- |
| Cut-off vs Built-in memory | 197 vs 529 | < 0.001 |
| Cut-off vs Search | 197 vs 194 | 0.152 |
| Built-in memory vs Search | 529 vs 194 | < 0.001 |

## Built-in memory block: facts saved and lost

From the memory block saved after every turn. A fact is lost if it was in the block and later disappeared while it still applied (dropping a value after it changed does not count).

| Length | Facts | Saved | Lost (of saved) | Missing at end |
| --- | --- | --- | --- | --- |
| Shorter (×0.5) | 432 | 91.2% (394) | 14.5% (57) | 32 |
| Longer (×1) | 432 | 88.0% (380) | 20.5% (78) | 50 |

## Grader agreement

On 100 blind hand-labelled answers (stratified by design and question type; answers the grader flagged as unclear were reviewed separately and are not in this sample): agreement 96/100 (96.0%), Cohen's κ = 0.90. The grader was not tuned on these answers.

| grader | right | wrong |
| --- | --- | --- |
| right | 72 | 1 |
| wrong | 3 | 24 |

Disagreements:

- *Where do I volunteer on weekends?* (simple, Cut-off): grader **right**, human **wrong**. Reply: "I don’t have access to your personal schedule or volunteering details. If you’re referring to the shelter, confirm with the coordinator or check their website for volunteer opportu"
- *How long is my whole trip?* (never, Search): grader **wrong**, human **right**. Reply: "Your trip duration wasn’t specified in our conversation. If you share your departure and return dates, I can calculate the total length! 🗓️"
- *Which repair shop has my car?* (changed, Cut-off): grader **wrong**, human **right**. Reply: "Based on our previous conversation, your car was sent to **Kesler Auto** after Duffy's couldn't fix it. If there have been further changes, please confirm with your insurance or th"
- *Which book are we reading this month?* (changed, Built-in memory): grader **wrong**, human **right**. Reply: "The Tuesday Readers are currently reading *The Remains of the Day* after dropping *Middlemarch*. The next meeting is on January 14."

## Second opinion: AI judge

A second grader (gpt-oss-120b, a sub-agent of the grading coordinator; prompted with the 12 pilot labels only). Everything above uses the rule grader, with hand labels overriding.

| Grader | Agreement with blind hand labels | Cohen's κ |
| --- | --- | --- |
| Rule grader | 96/100 (96.0%) | 0.90 |
| AI judge | 100/100 (100.0%) | 1.00 |

Judge vs rule grader on all answers: they differ on 73 of 2508 (2.9%); 12 answers the rule grader left as unclear are not counted. Cells: differ / answers (judge says right where the grader says wrong · the reverse).

| Type | Cut-off | Built-in memory | Search |
| --- | --- | --- | --- |
| simple | 5/120 (0 · 5) | 1/120 (0 · 1) | 4/120 (0 · 4) |
| exact | 1/239 (0 · 0) | 5/239 (0 · 5) | 17/240 (0 · 17) |
| changed | 4/120 (3 · 0) | 2/120 (2 · 0) | 6/120 (2 · 4) |
| combine | 1/116 (0 · 0) | 3/119 (0 · 3) | 3/120 (0 · 3) |
| never | 3/238 (1 · 2) | 2/237 (2 · 0) | 16/240 (13 · 3) |

Robustness: the headline results on fact questions recomputed with the judge's verdicts (hand labels still override both). p-values: Cochran's Q, McNemar with Holm, length McNemar.

| Result | Rule grader | AI judge | Same conclusion |
| --- | --- | --- | --- |
| Cut-off accuracy, ×0.5 | 38.7% | 38.7% | – |
| Built-in memory accuracy, ×0.5 | 87.3% | 86.0% | – |
| Search accuracy, ×0.5 | 94.7% | 90.0% | – |
| Designs differ, ×0.5 | yes (p < 0.001) | yes (p < 0.001) | yes |
| Built-in memory beats Cut-off, ×0.5 | yes (p < 0.001) | yes (p < 0.001) | yes |
| Search beats Cut-off, ×0.5 | yes (p < 0.001) | yes (p < 0.001) | yes |
| Search beats Built-in memory, ×0.5 | yes (p 0.003) | no (p 0.141) | **no** |
| Cut-off accuracy, ×1 | 6.7% | 6.0% | – |
| Built-in memory accuracy, ×1 | 79.3% | 78.0% | – |
| Search accuracy, ×1 | 94.0% | 90.0% | – |
| Designs differ, ×1 | yes (p < 0.001) | yes (p < 0.001) | yes |
| Built-in memory beats Cut-off, ×1 | yes (p < 0.001) | yes (p < 0.001) | yes |
| Search beats Cut-off, ×1 | yes (p < 0.001) | yes (p < 0.001) | yes |
| Search beats Built-in memory, ×1 | yes (p < 0.001) | yes (p < 0.001) | yes |
| Cut-off gets worse when longer | yes (p < 0.001) | yes (p < 0.001) | yes |
| Built-in memory gets worse when longer | yes (p 0.002) | yes (p 0.002) | yes |
| Search gets worse when longer | no (p 0.727) | no (p 1.000) | yes |

Sensitivity: with 29 judge verdicts (format-only rejections, e.g. "552-019" when "552019" is accepted, and unparsed outputs) scored as the rule grader scores them, Search beats Built-in memory, ×0.5: yes (p 0.008). Conclusions that then differ from the rule grader's: 0.

