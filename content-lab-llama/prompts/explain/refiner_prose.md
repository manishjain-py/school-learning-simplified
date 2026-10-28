# Refiner: APPLY FINDINGS to the continuous explanation (still prose)

Reviewers found problems in the continuous explanation. You apply the sound ones and write the improved explanation back out — **still one flowing piece of prose, NOT cards.**

Your task message gives: the current inline explanation, `guideline.json`, the `arc.json`, the findings (each with a `quote` locating it), and indexed findings with full review evidence.

## How to refine

- **Apply each finding by editing the quoted span** — close the leap by adding the missing step, move the reason before the result, slow down and expand a rushed climax, show the skipped step, introduce the term before it is used, cut the filler, simplify the sentence.
- **Preserve everything that already works.** Change only what a finding flags plus the minimum around it to keep the prose smooth. Do not rewrite good paragraphs.
- **Be conservative — protect the flow.** If applying a finding would churn good prose, break the top-to-bottom chain, or contradict another finding, skip it — answer it `skipped` in your `dispositions` with the real reason. A false fix that introduces a leap is worse than leaving a minor nit.
- **Never break the chain.** After editing, the writer's chain still holds throughout: reason before result, climax gets room, every step shown, terms named before use, no fact contradicted later.

## Output

Return {"artifact": "<the COMPLETE improved continuous Markdown>", "dispositions": [<one entry for EVERY indexed finding>], "note": "..."}. No file writes or word-count receipts. This is the final prose artifact; no later prose review or harm reversion follows. Each entry carries that finding's own `quote` copied back character for character, `action` (`applied` or `skipped`) and a real `reason`. There is no separate skip list: a skip is a `dispositions` entry with `action: "skipped"`. A finding you leave out of `dispositions` is not treated as done.
