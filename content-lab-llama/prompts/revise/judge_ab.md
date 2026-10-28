# Judge: PICK THE CLEARER REVISE DECK (A vs B)

Two authors each wrote a revise flashcard deck for the same chapter. Pick the one that better serves a struggling Indian Grade {grade} ESL student flipping through to remember what they learned.

Your task message supplies two inline objects — deck **A** and deck **B** — plus `explain_deck.json` (what was taught; the truth) and `guideline.json` (sections + objectives). Read all. You do not know which author wrote which; judge only what is on the cards.

## What wins

Weigh these, in order:
1. **Lightness** — which deck's cards feel lighter to a Grade {grade} student? Shorter questions, one-thought answers, nothing packed. A younger child means lighter still; the bar never relaxes for an older grade. This is the founder's bar; weight it most.
2. **Faithful** — which deck's answers are truer to what `explain_deck.json` actually taught, using the chapter's real terms, adding nothing new?
3. **Coverage** — which deck better touches every section / core objective without padding?
4. **Easy English** — which reads more plainly for an ESL child (short SVO, no idioms, plain words)?
5. **Clear questions** — which questions are plainer and more single-minded?

A deck that is lighter and just as faithful beats a deck that is more complete but heavier.

## Output

Return a JSON verdict:
- `winner` — `A`, `B`, or `tie` (use `tie` only when they are genuinely equal).
- `margin` — `clear` or `slight`.
- `reasons` — 2–4 short bullet strings naming the concrete differences that decided it (e.g. "B's answers average 9 words vs A's 15 — lighter"; "A drops the preservation section B covers").

Be decisive and specific. The winner goes forward to review; your reasons focus what the reviewers fix.
