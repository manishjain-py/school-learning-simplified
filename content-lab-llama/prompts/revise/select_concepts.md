# Select: THE CONCEPTS TO REVISE (distil the Explain deck)

You choose the ~20–25 core ideas a student should quickly go over to **revise** one chapter — no more. Revise is not re-teaching; it is a fast flip through the key ideas the chapter already taught, one light flashcard each.

Your task message supplies inline JSON: `explain_deck.json` (the full lesson the student was actually taught — your source of truth for WHAT was taught and in what words), `guideline.json` (the chapter's sections + Learning Objectives — your source of truth for COVERAGE). Read both supplied objects.

## What to pick

- **One idea per concept.** Each concept becomes ONE light flashcard later, so it must be a single, self-contained fact or idea — not a cluster. If an Explain card holds two ideas, split it into two concepts (or keep only the one worth revising).
- **Cover the whole chapter.** Every section in `guideline.json.sections` must get at least one concept, roughly in proportion to its weight (`page_count`), and every CORE Learning Objective must be revisable from your list. A student who flips your whole stack has touched every important thing the chapter taught.
- **Core over trivia.** Prefer the ideas a teacher would put on a test: definitions, the "why", the named parts, the ordered steps. Drop asides, extra examples, and decoration.
- **Concept order.** List concepts in the chapter's teaching order (section by section, `sections` order). This is the order the student will flip.
- **Target ~20–25.** A revise stack is short. If the chapter is small, fewer is fine; never pad. The source target and minimum of 12 are advisory in this tiny reference path, never a completion gate.

## For each concept

Return a complete artifact envelope `{"artifact":{"concepts":[...]}}` with the `concepts` list in order. Each concept:
- `concept_key` — a short stable kebab-case slug for the idea (e.g. `digestion-begins-in-mouth`); unique across the list.
- `section_key` — the `sections[].section_key` from the guideline this idea belongs to.
- `section_seq` — the 1-based position of that section in `guideline.json.sections` (1 for the first section, 2 for the second, …). Non-decreasing down your list.
- `gist` — one plain sentence naming the idea to revise (this is a note to the author, not the flashcard text).
- `source_card_idxs` — the `card_idx` values in `explain_deck.json` this idea comes from (1-based; provenance so the author stays grounded).

Do not write any card text — that is the author's job. Pick well: everything downstream flips only through what you choose here.
