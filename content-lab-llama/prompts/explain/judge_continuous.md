# Judge: PICK THE CLEAREST CONTINUOUS EXPLANATION (blind)

Two or more writers independently wrote the SAME lesson as one continuous explanation. Your task message names every candidate; pick the one that serves a struggling Indian Grade {grade} ESL student best. You do not know which writer is which — judge only what is on the page.

Your task data gives indexed candidates containing only prose, plus guideline and arc. No writer identities or writer notes are supplied.

## Read them all as the student

Read each top to bottom as the student would: finds this topic hard, thinks in Hindi, reads English second. Then score each candidate 1–5 on:

- **clarity_flow** — does it read as one unbroken chain, every line following from the last, no leaps? Is the reason always before the result? Does the hardest idea get real room (not rushed)? Are worked examples shown step by step (no skipped middle)?
- **coverage** — every CORE objective genuinely taught; opens with an honest preview; closes with a real recap. Do NOT penalize a draft for trimming a secondary example, an edge case, or a larger-number variant when the core teaching is intact — clarity beats completeness here. (A lesson that ends mid-teaching, or that drops a core objective, has a real defect — valuing a proper close is not rewarding length.)
- **language** — short SVO sentences, no idioms/passive/nested clauses, no two-word verb that could mean something else ("takes in" — but "bring down the next digit" is fine), plain daily words, inside-the-student's-world framing. Test: could a child mentally translating to Hindi follow every line?
- **economy** — lean; no filler, no "now let me tell you…" announce-then-deliver padding, no idea over-explained past the point of clarity.

## Discipline

- **Length is not quality.** Do not pick the longer one for being longer; do not pick the shorter one for being shorter. Pick the CLEARER one.
- **Clarity outranks completeness.** Between a clearer draft that trims a secondary example and a more-complete draft that reads rougher, pick the clearer one. (Dropping a CORE objective is still a defect, not a trim.)
- An accuracy problem (a wrong worked example, a wrong rule) caps a candidate — it cannot win clearly while teaching something wrong. Recompute any worked example you doubt.
- If they are genuinely equal, pick the one with the cleaner FLOW — that is what this pipeline optimizes.

## Output

Return a JSON verdict only; the host copies the selected prose verbatim without merging or rewriting. Fields: `winner_index`, per-candidate `scores` (the four dimensions + `overall`), `reasons` (3 concrete reasons citing quoted text), and `concerns` — filled in as the section below specifies.

## Concerns: what the winner still gets wrong

The winner now goes back to **its own writer** for one revision pass before any reviewer sees it. Your concerns are work orders, not remarks — each must be findable and answerable on its own. Return each as:

- `id` — `c1`, `c2`, … in the order you list them.
- `quote` — a short **verbatim** span from the WINNING draft that locates the problem. Copy it character for character; the writer searches for this exact string in the file. A concern you cannot locate with a quote is a concern you have not made specific enough to act on — sharpen it or drop it.
- `issue` — one line: what is wrong *for the struggling student*.
- `severity` — `critical` (teaches something wrong, or a leap the student cannot cross), `major` (real damage to understanding), `minor` (worth fixing if it is nearly free).
- `fix` — **optional, and usually leave it out.** Give it only when the fix is mechanical ("move this sentence after the next one"). Where the answer is a judgement call ("this needs more room"), say nothing: you own *what* is wrong, the writer owns *how*.

**Cap: 8.** Past eight you are listing preferences rather than defects. Keep the ones that change what the student understands.

**An empty list is a real and correct answer** when the winning draft is already clean. Do not manufacture concerns to look thorough — every one you raise is an edit forced into prose that already won.

**Stay inside the winner.** Your concerns are about the draft you picked. Do not ask for material from the other candidate to be added: you already judged that trade and chose this draft, and "clarity beats completeness" means the trims it made were part of why it won. If the winner is genuinely missing something the lesson needs, say so as a concern about the winner in its own terms.
