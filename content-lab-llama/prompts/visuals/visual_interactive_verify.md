# Interactive Verify: PROVE IT MOVES, AND THAT EVERY POSITION IS RIGHT

Independently review the supplied slider artifact using actual local frame/control
evidence. A spec can look correct while setParam does nothing; one frame cannot
prove a working interaction. Findings go to one final interaction author revision,
not a gate or automatic fallback to the base picture.

Your task data includes the fixed card, separate base/interaction artifacts,
slider spec/code, actual control-state frames with recorded parameter values and
hashes, and renderer diagnostics. These are derived review frames, not original
textbook pages. Do not request source files, curl, validator commands, network
rendering or unavailable tools. Do not claim you created the evidence yourself.

## Read the local ABI and actual states

Only `interactive.type:"slider"` is supported: param, x/y/width, min/max,
optional positive value-increment `step`, label. The code must expose
globalThis.setParam(name,value,grabbed) and deterministic renderAt(t_ms).
Source kind/track endpoints/stop count, pick/orbit and group controls are absent.

Inspect evidence for the untouched picture plus min, an intermediate value,
middle and max. Report the exact values and frames actually seen. If any are
missing, say so; do not invent `positions_seen` or a working-control result.
Read execution diagnostics before describing unavailable pixels.

Read `visual_explanation.duration_ms` and the recorded effective playback
duration: a positive finite integer no greater than 600000 covers the complete
sequence and final-state hold; only omission uses the 10000ms renderer default.
Expect actual time-0, middle and endpoint evidence across that duration as well
as the distinct slider states, and a viewer that plays the full duration.
Report missing or truncated evidence; a 1000ms sample cannot prove a longer
sequence's completion. Do not infer unseen time/parameter combinations.

## Did it actually move?

Compare states before judging any of them. For distinct reachable values, the
meaningful picture/readout must visibly respond; a stationary rendering or a
changed control alone does not prove the diagram changed. Check the parameter
name agrees with the spec and that actual gestures/control values reached
setParam. Repeated quantized values may correctly match, so compare distinct
stops when a step is declared. Report what the pixels/control evidence proves,
and what remains uncertain.

## Judge every inspected state

- Count the picture at each position. The readout and marks must agree.
- Keep each state true to the card, including reachable states it does not
  explicitly discuss. Never reveal a question's answer or turn exploration
  into scoring.
- Check both extremes for swallowed labels, clipped knobs and off-canvas marks.
- Check label size/contrast and phone-width readability throughout the range.
- A declared step must not leave an invalid between-value state.
- In the untouched state, a short visible invitation should explain what moves;
  it should disappear after touch and not collide with the picture.
- While grabbed, a visual response should show the child has the control.

Do not flag the picture differing from the base merely because it is movable,
harmless taste choices, plain English invitations or appropriate simplification.
Flag incorrect quantities/relations and unusable controls with exact state and
location. A stopped picture, one uninspected end or unavailable control evidence
must not become a fabricated verification claim.

## Return advisory findings

Return only `{"findings":[...],"ok":true,"note":"..."}` with the advisory
assessment false for observed problems/insufficient evidence. Each finding names
card_idx, value/state, frame/time, problem and concrete fix. In the note record
positions_seen, the actual values, whether the picture changed and what real
control evidence was supplied. Use strings or objects as the task wrapper asks.
No negative finding removes the artifact, chooses a new candidate or restores
the base. The final author may apply or reasonably decline your findings, and
its complete revision is retained without another content-quality review.
