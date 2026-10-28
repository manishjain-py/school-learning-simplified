# Author: PRACTICE BLUEPRINT (coverage spine + deck digest — once per chapter)

You build the **practice blueprint** for one chapter — the contract every practice-factory top-up run allocates against. It is written ONCE and reused for months while the bank grows from ~50 to 250+ questions, so precision here compounds: a vague skill produces vague questions forever.

You produce TWO things in one JSON file:
1. **skills** — the chapter's drillable skills, derived from the guideline's Learning Objectives.
2. **digest** — a compact terminology + methods digest of the deck, so future question authors NEVER need to read the deck itself.

## Your inputs (read them first)

Read the inline guideline and settled Explain deck in declared task data. The guideline is factual ground truth. Use the deck ONLY to build the digest. No file tools or external research are available. {grade}

## PART 1 — skills

Turn the guideline's Learning Objectives into a flat list of **drillable skills**. Rules:

- **Derive from objectives, not from vibes.** Walk each section's `## Learning Objectives` bullets. One skill per objective is the default; merge two bullets into one skill ONLY when they are genuinely the same drill (e.g., "read a 5-digit number" + "write a 5-digit number"). Never merge across sections.
- **Every section MUST contribute at least one skill.** A section with zero skills is a blueprint failure.
- **A skill is something you can write 20 different questions about.** "Long division: 3-digit ÷ 1-digit" is a skill. "Division" is not (too broad). "Divide 618 by 3" is not (that is one question).
- For a full chapter the source aims for **8–20 skills**. This tiny reference path has no minimum skill count; retain usable skills for the supplied sections.
- `skill_key`: `<section_key>--<short-slug>` — lowercase kebab-case, unique, readable (e.g., `dividing-by-1-digit-number--zero-in-quotient`).

### MATHEMATICS ONLY — skills are OUTCOMES, never methods

Apply this block when guideline.json `subject` is Mathematics; skip it for every other subject.

The deck teaches solution methods (column method, expanded form, box method, bar models, jump-in-tens, near-doubles, doubling shortcuts, guess-test-fix, round-and-correct, simpler-numbers-first, pairing tricks…). In Practice the student may solve every question THEIR OWN way — so a skill is named for WHAT the student produces (a result, a decision, a meaning), never for HOW the deck computes it.

- An objective phrased "do X using method M" becomes the skill "do X". Record the method name in the skill's optional `taught_method` field (a short phrase) — question authors use it ONLY inside `explanation_why`, never in the ask.
  WRONG skill: `smart-ways-to-multiply--doubling-to-build-a-table` (drills the trick itself)
  RIGHT skill: `smart-ways-to-multiply--multiply-by-one-digit-mentally` with `taught_method: "doubling to build a table"` (drills the products; the trick appears only in explanations)
- NEVER blueprint a skill that drills a method's inner states, layout, or step vocabulary — no skills about carrying rows, zero placeholders, which columns borrow, box cells, how a bar model is cut, or which strategy to pick. Fold each such objective into the outcome skill it serves; its `parameter_space` carries the special cases the method targeted (carrying needed, zero in the quotient, borrowing through zeros, remainder vs exact…), because those cases are still drilled — through outcomes.
- Concept skills STAY skills: board vocabulary (dividend/quotient/factor/product), reading/writing/comparing numbers, choosing the OPERATION for a story, what a quotient/remainder MEANS in a story, estimation/reasonableness. These test ideas, not procedures.
- Classic procedure errors survive as WRONG-RESULT material, not as step trivia: "927 ÷ 3 = 39" (the dropped zero) is a great false claim for a true_false — list it under the outcome skill's `misconceptions`, never as a "spot the missing placeholder" skill.

Each skill object:

| field | what |
|---|---|
| `skill_key` | `<section_key>--<short-slug>`, unique in the file |
| `section_key` | the guideline section it belongs to (must exist in `sections`) |
| `title` | short human title (≤8 words) |
| `objective` | the Learning Objective bullet(s) this drills, condensed faithfully — do not water it down |
| `what_to_test` | 1–2 sentences: what a question on this skill actually asks the student to do |
| `taught_method` | (Mathematics only, optional) the deck's method name behind this outcome skill (e.g., "column method with carrying") — for authors' `explanation_why` ONLY; the ask never names it |
| `formats` | 2–4 of the 4 MVP practice formats that genuinely fit this skill (from: pick_one, true_false, fill_blank, multi_select — the app is phone-first; these four tap-only interactions are ALL that exists). Pick formats that fit the skill's nature — multi_select suits classification and "which of these…" analysis, fill_blank suits vocabulary and completing a taught sentence, true_false suits judging a claim or a worked step, pick_one fits everything else (including odd-one-out and prediction stated as a question). A retired interaction's intent is rewritten: ordering → "which comes after ___?", matching → fill_blank/pick_one about the relationship, classifying → multi_select ("Choose all the ___"), spot-the-error → pick_one over the steps. |
| `difficulty_notes` | `{easy, medium}` — one line each: what easy/medium means FOR THIS SKILL (easy = one-step recall/direct application; medium = slightly new context or 2 steps). The bank has NO hard tier — do not define one. |
| `misconceptions` | 0–4 entries picked from the guideline's `misconceptions` list that make good WRONG-answer material for this skill (verbatim or lightly trimmed) |
| `parameter_space` | THE FRESHNESS ENGINE. For numeric skills: the exact ranges and special cases questions should draw from (e.g., "dividends 100–999, divisors 2–9; include zero-in-quotient, remainder, and no-remainder cases"). For non-numeric skills: the dimension that varies (e.g., "one word per question from the section's word list; vary word length"). Be specific — authors vary questions along exactly these axes. |
| `weight` | 1 = minor/supporting, 2 = core (default), 3 = pillar the chapter drills hardest. Base it on the guideline's Required Depth. |

## PART 2 — digest (of the deck)

Read the deck ONCE and compress what a question author needs, ≤2000 words total:

| field | what |
|---|---|
| `vocabulary` | the exact terms the deck teaches with (e.g., "quotient", "remainder", "dividend") — authors must use THESE words, not synonyms |
| `step_labels` | for each `concept_group` run whose cards carry `step_label` words (e.g., "Divide", "Multiply", "Subtract", "Bring down"): `{"<group title>": ["label", ...]}` — the student learned the steps by these names; a synonym breaks the thread |
| `methods_conventions` | 3–8 short lines: the exact procedures/layouts/notations the deck teaches (e.g., how long division is written, how remainders are stated, comma placement). Questions must match these conventions, never a rival method. |
| `contexts_used` | the real-world settings the deck's examples already use (e.g., "buses with 36 seats", "pens at ₹4"). Authors AVOID reusing these exact scenarios so practice feels fresh vs the lesson. |
| `board_titles` | the deck's `concept_group` titles, verbatim — the chapter's big ideas as the student saw them |

## PART 3 — theme_wheel

A nonempty list of everyday-Indian-life context themes (the source aims for 8–12; this tiny reference path has no count floor) for question variety (e.g., "market/shop with ₹", "cricket", "school library", "train journey", "kitchen/cooking", "festival", "garden", "post office"). Exclude themes already heavy in `contexts_used`. Authors rotate through these so the bank never becomes five mango-seller questions in a row.

## Output

Return {"artifact":{"skills":[...],"digest":{...},"theme_wheel":[...]},"note":"..."}. The host writes it, records input hashes and performs local allocation. No production validator, database or importer runs. Re-read whether a colleague could author varied questions using each skill, its section and digest without the deck; enrich the digest where needed.
