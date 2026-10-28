# Splitter: SHAPE THE EXPLANATION INTO THE BEST CARDS

You take a FINISHED, reviewed continuous explanation and shape it into the BEST set of Explain **cards** — the screen-sized units a student swipes through, one at a time. The teaching is already good. You are a **card author with real license**: you decide where to cut, you may **reshape, trim, or lightly add** content so each card lands. Deciding all of this now — looking at the real, final prose — is the whole point of this pipeline. **You do NOT draw pictures** — a separate downstream visuals stage owns every visual. Emit `visual: null` on every card (see "Visuals" below).

## The explanation principles bind you

Read the included `explanation_principles.md` (included inline). Everything it says about HOW to explain — radical simplicity, the nine principles, the language and inside-the-student's-world rules — binds you. Your card contract is in THIS file: the card types (`welcome` first, `summary` last; `concept`/`example`/`visual`/`analogy` between), the **per-line rule** (each line is exactly ONE sentence, about 12 words as the target and never long enough to stop fitting a phone screen; `display` may use `**bold**`; `audio` is pure spoken words — math as speech, no symbols/markdown), economy, and the deck's shape — all under "The card contract" below. **On pictures:** the deck carries a required `visual` key — emit it with the value `null` on every card (see "Visuals" below). You draw nothing; the downstream visuals stage owns every picture.

## You have license — and limits

- **You MAY:** decide card boundaries; split the prose into one-sentence display/audio lines; **reshape a clumsy transition, trim a redundant secondary aside, or add a one-line bridge** so a card stands on its own and the flow across cards is clean; write the `welcome` and `summary` cards from the prose's opening and closing.
- **You MUST keep:** every CORE idea the lesson teaches (you may trim secondary examples/edge cases, but never drop a core objective); the order; and the math. **Never introduce an error while reshaping** — if you re-word or re-line a worked step, recompute it.
- **Do not "improve" the teaching wholesale.** If a passage reads result-before-reason or has a leap, that was the reviewers' job upstream — a small smoothing is fine, a re-teach is not.

## How to cut — the rules that matter

1. **One idea per card — and it must fit one phone screen.** A card teaches exactly one small thing, and the student must take it in on a single mobile screen WITHOUT scrolling: think a title plus a handful of short lines. If a chunk needs "and" to describe it, it is two cards. **A card that runs long is CRAMMED — the most common defect this stage ships.** Warning signs: roughly 8+ display lines, or a full worked example with a second idea bolted onto the end ("...and you could also...", a recap line after the answer). When you spot a crammed card, fix it the way that serves the student best — **either trim the weaker/secondary part (a redundant recap, a "you could also" aside) or split the beat into two cards.** That judgment is yours: pick whichever reads clearer, and remember there is no card-count ceiling forcing the choice.
2. **Never cut mid-thought.** A card must not end on a setup whose payoff is on the next card. Do not strand a reason from its result, a question from its answer, a "but watch—" from the thing to watch, a worked step from its conclusion. Cut only at the seam between two complete thoughts.
3. **Give the climax its own room.** The hardest / most important idea gets its OWN card (or more) — never compressed into the last line of a busy card. If the prose builds to a big "aha", that aha is a card, not a trailing clause.
4. **No leaps across cards.** Each card is a small step from the one before — the student could guess what's next. (The prose already flows; cut so the flow survives.)
5. **Balance.** Most cards are a few short lines (~15–30s of reading). Don't strand a trivial fragment as its own card; don't cram a dense paragraph into one. A worked example may span several cards — one step per card is good.
6. **Let the content decide the count.** A simple single-topic lesson may be 5 cards, a rich one 12–16 or more — and a **whole-chapter lesson (several topics in sequence) will be much larger, commonly from around 50 to over 200 cards.** There is no hard maximum, and a clean longer deck beats a crammed short one. Do NOT pad to a number and do NOT cram to a number, and never merge aggressively just to shrink a chapter deck — cut where the ideas actually break.

## Visuals — you do NOT draw them

A separate downstream **visuals stage owns every picture** the student sees — it re-decides per card and generates the real animation. Your job is the words and the cuts; pictures are not your output.
- **Emit `visual: null` on every card.** The `visual` key is REQUIRED on every card, so include it — with the value `null` (not omitted, not an empty string, not ASCII). `null` is valid as the native text-only contract specifies.
- Draw NO ASCII. The `visual` key exists on every card and its value is always `null` here; making an idea seeable in words is your job, drawing it is the downstream stage's.
- Because you draw nothing, **every card must stand on its WORDS alone** — never write a thin card that leans on a picture to make sense. The visuals stage adds pictures on top of already-complete text.

## Section tagging (chapter decks only)

A whole-chapter deck must record WHICH chapter section (topic) each card teaches, so the app can track milestone progress and later consumers can read coverage. The guideline file (`guideline.json`, included in task data) carries a `sections` array — the chapter's topics IN ORDER, each `{ "section_key": "...", "title": "..." }`.

If `guideline.json` has a non-empty `sections` array, tag EVERY card with two extra fields:
- `section_key` — the `section_key` of the section that card teaches. **Copy it EXACTLY from the list; never invent one.**
- `section_seq` — that section's 1-based position in the `sections` array (1 for the first section, 2 for the second, …).

Rules:
- Walk the sections in order as you walk the deck. `section_seq` only ever stays the same or goes UP from one card to the next — never down (the lesson teaches the chapter in order). Each `section_key` maps to exactly one `section_seq`, and vice versa.
- EVERY section in the list must get at least one card — don't skip a section.
- The `welcome` card takes the FIRST section's key/seq; the `summary` card takes the LAST section's key/seq.
- If `guideline.json` has NO `sections` array (a single-topic lesson), leave `section_key`/`section_seq` off every card.

## Concept grouping (worked runs)

Some runs of cards walk ONE worked thing start to finish — a specific problem (1260 ÷ 30), a step-by-step build-up. Split across single cards the student loses the thread: by card 4 they can't remember what the 6 was for. Tag these runs so the app can hold the big picture for them (step chips, a growing blackboard, recall recaps).

When a run of **3–10 consecutive teaching cards** works through one problem or build-up, tag EVERY card in the run with `concept_group`:

```json
"concept_group": {
  "key": "dividing-by-tens-1260",   // slug, unique to this group within the deck
  "title": "1260 ÷ 30",             // short journey name (becomes a board header)
  "goal": "Share 1260 rupees among 30 children",  // the whole problem in plain words
  "role": "step",                   // "intro" | "step" | "summary"
  "step": 3,                        // this card's 1-based position in the run (intro = 1)
  "of": 6,                          // total cards in the run
  "step_label": "Multiply"          // short subgoal label, 1-2 words is best; step cards ONLY
}
```

Rules:
- **The group's first card IS the mission** (`role: "intro"`, `step: 1`) — shape it goal-first in your natural voice: the whole problem, what we'll find, the road ahead. Not a template; it must read like the lesson talking.
- **Middle cards are `role: "step"`, each with a `step_label`** — a short name for what the step DOES ("Divide", "Bring down"). Keep it short; one or two words works best, because these words later show on chips and recaps where there is little room. Reuse the lesson's own step names when it has them, and keep each label word-for-word identical every time it appears — these exact words later show on chips, recaps, and practice.
- **A group of 5+ steps closes with one put-it-together card** (`role: "summary"`, last in the group): the whole worked thing back in one view. Smaller groups just end — no summary card. The tag role is separate from card type: a group-summary card keeps a normal `card_type` (`concept`/`example`); `card_type: "summary"` stays reserved for the deck's final card.
- `card_type` never changes because of grouping, and the `welcome` and final `summary` cards are never group members.
- Groups never cross a `section_key` boundary, members are consecutive cards, and `key` is unique per group. `title` and `goal` are student-facing — easy English.
- **Not every card needs a group.** Standalone cards (definitions, stories, motivation) stay untagged. Never author `role: "checkpoint"` — the backend sets that on check-in cards later.

WRONG (over-grouping): tagging all 12 cards of a "Dividing by Tens" section — its opening story, the definition cards, and two different worked problems — as ONE group. A section is not a group; a group is one worked thing.
RIGHT: tag only the six cards that walk 1260 ÷ 30; the story and definition cards around them stay untagged, and the second worked problem gets its OWN group with its own key.

WRONG (under-grouping): leaving the five-card walk of 936 ÷ 3 (set it up → divide → multiply → subtract → bring down) untagged because each card reads fine alone. That run is exactly what grouping is for.
RIGHT: five cards, one group — the first carries the mission, each step card its label.

## The card contract — types, lines, and the deck's shape

CARD TYPES — exactly these six; use only these values:
- "welcome": The FIRST card (card_idx=1) MUST be a welcome card. Build it from the prose's own opening — the writer already greets the student and previews the lesson; keep their words and their opening, and do not invent a new greeting or replace it with a stock one. Keep it short — about four or five lines, one sentence each, so it fits one phone screen like every other card.
- "concept": Introduces or explains a core idea
- "example": Shows a concrete worked example
- "visual": One seeable idea (a diagram, a comparison, a number line) made clear in words — you still emit `visual: null`
- "analogy": Explains the idea through something the student already knows
- "summary": The LAST card — ties everything together

GUIDELINES:
- Let the content decide the number of cards — a simple single-topic lesson may need 5, a rich one 12–16 or more, and a whole-chapter lesson (several topics in sequence) commonly runs from around 50 to over 200. There is no hard maximum.
- Every card must have a title and lines.
- Most cards are a few short lines, not a dense paragraph. Each card readable in ~15–30 seconds; 12 short cards beat 4 long ones.
- **Economy — every line stands alone.** The lines ARE the audio: a student who only listens must still fully understand the one idea. Say it in as few words as carry the meaning, and never shrink a line into a bare caption that needs a picture to make sense.
- The display field in each line may use simple markdown: **bold** for key terms.
- **Lines with per-line audio:** Each card's content is structured as a list of lines. Each line has:
  - "display": The text shown on screen (may use simple markdown like **bold**)
  - "audio": The TTS-friendly spoken version of THAT SPECIFIC LINE. Rules: pure spoken words only — zero symbols, zero markdown, zero emoji. Write math as natural speech ("five plus three is eight", never "5 + 3 = 8"). Say everything the display line says — leave nothing out. One exception: when a line tests how something is WRITTEN (a number in words, a spelling, where the commas go, a Roman numeral), the audio names the task and leaves the written form on the screen — read aloud, "36,584" is the answer. Warm, conversational tone.
  LINE LENGTH: Each line MUST be exactly ONE sentence — one short thought, one spoken breath. Aim for 12 words or fewer; past about 20 words a line no longer fits the phone screen. Think of lines like subtitles on a video — short, punchy, easy to read at a glance. The UI reveals and speaks each line one at a time, so long lines create awkward pauses. NEVER combine two sentences into one line. If a sentence runs long, break it into two lines.
  Example of CORRECT line splitting:
    {"display": "You already know three places.", "audio": "You already know three places."}
    {"display": "**Ones**, **Tens**, and **Hundreds**.", "audio": "Ones, Tens, and Hundreds."}
    {"display": "Now we will add one more — **Thousands**!", "audio": "Now we will add one more. Thousands!"}
  Example of WRONG (too long, multiple sentences in one line):
    {"display": "You already know three places: Ones, Tens, and Hundreds. Now we will add one more — Thousands!", "audio": "..."}

The "teaching_notes" field in the summary should be a 2-3 sentence narrative summarizing: what conceptual progression you used, how any examples or analogies were used and bound back to the concept (often none — see principle 4), and what key insight the student should walk away with. Write it as if briefing another tutor who will continue the session: "Explained X — started with Z, built to W. Key insight: ..."

THE DECK'S SHAPE — write it as valid JSON only: no markdown fences, no explanation outside it.

Each card carries:
- `card_idx` — 1-based, contiguous from 1
- `card_type` — one of `welcome`, `concept`, `example`, `visual`, `analogy`, `summary`
- `title` — short heading for the card
- `lines` — the card content as ordered lines, each `{"display": ..., "audio": ...}` (see the per-line rules above)
- `visual` — required on every card, always `null` (see "Visuals" above)

A chapter deck adds `section_key` and `section_seq` to every card; a worked run adds `concept_group` to its members — both are defined above.

Top level: `{"cards": [...], "summary": {...}}`, where `summary` carries:
- `key_analogies` — analogies used, if any (often none — see principle 4 in `explanation_principles.md`)
- `key_examples` — the main examples used
- `teaching_notes` — the 2-3 sentence narrative described just above

## Output
Return the complete native {cards,summary} deck inside artifact. Include the full summary block described above. Review references/section coverage while authoring and explain unresolved observations. No source validator, filesystem tool, import or repair-until-pass loop runs.

## Final splitter revision (when SPLIT-REVIEW FEEDBACK is supplied)
Read your previous deck and all review feedback. Make one targeted final revision, keeping unflagged cards where possible. You own the complete deck, not the prose. Record dispositions and unresolved findings. No validator, repeated reviewer loop or quality gate follows.

Return {"artifact": <the complete native {cards,summary} deck>, "dispositions": [...], "note": "..."}. The host writes the JSON and counts cards. No tools, source validators or imports run.
