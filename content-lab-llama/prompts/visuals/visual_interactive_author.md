# Interactive Author: MAKE ONE BASE PICTURE MOVE

Take the supplied base Pixi visual and let the learner control the one quantity
the picture already explains. Find that quantity; do not add a different lesson.
The base picture, frozen card and nomination arrive as explicit inline task
data. Your output is a separate native visual artifact. Preserve the base artifact;
review feedback does not decide whether your artifact replaces it.

## The one idea

A movable picture is a new SOURCE for a quantity the picture already uses.
Positions, labels, counts and captions must all re-derive from that one value.
If changing it would make the fixed card false, explain the problem. Do not
invent a quiz, right answer, score, tick/cross or “try again” message.

## Preserve the card and base identity

Copy the supplied native entry. Change `pixi_code`, add `interactive`, and retain
or update `duration_ms` as described below, all INSIDE `visual_explanation` as
siblings of `pixi_code`. Copy card_idx,
expected_card_type, expected_title, output_type, title, visual_summary,
visual_spec and layout_warning exactly. Do not alter the card's English words:
its narration/translation may already depend on those words. The touch invitation
lives inside the drawing, never in rewritten lesson text.

The base artifact is separately retained. A negative review is advisory; it does
not silently restore the base, pick another candidate or filter this entry.

## New local slider ABI — the only supported control

Use `interactive`:
`{type:"slider",param:"meaningfulName",x:number,y:number,width:number,min:number,max:number,step?:number,label:string}`.

Coordinates describe a horizontal track inside the 500 × 350 canvas. Leave space
for the knob and text at both ends. Width must be positive and min < max. `step`,
when present, is a positive value increment, not a count of stops. Use it where
between-values are meaningless. The host maps real pointer gestures and a visible
control to the parameter; the code must answer that same name.

This is a new ABI: source `kind`, x1/y1/x2/y2, `steps`, `zone`, `stages`, `pick`
and `orbit` are not supported and must not be emitted.

The Pixi code is an async function body with initialized lexical `app` and
global `PIXI` v8. It must define:

- `globalThis.renderAt = (t_ms) => { ... }`, deterministic at absolute time.
- `globalThis.setParam = (name,value,grabbed) => { ... }`.

Ignore other names. Clamp to min/max and quantize to step when supplied. Set the
one parameter, then repaint every dependent mark. `grabbed` is true while the
pointer is down and false on release. Show a subtle held outline/halo while true.
Do not create another application, call app.init, import, fetch assets, use tools,
timers/ticker/Date/randomness or depend on accumulated elapsed time.

Keep the student-controlled value across `renderAt` calls. Re-seeking the same
time with the same parameter must reproduce the same pixels. Draw a short visible
invitation initially and hide it once touched. Do not let invitation or knob
collide with labels; keep everything on canvas at both extremes. The at-rest
picture should remain recognizable as the supplied base.

Set `visual_explanation.duration_ms` to a positive finite integer no greater
than 600000, covering the complete playback sequence and final-state hold.
Retain the base duration when timing is unchanged; update it when changed code
needs a different full duration, and supply it if the base omitted it. Do not
lose the duration while copying the native entry. The renderer defaults to
10000ms only when omitted, captures time 0, middle and endpoint, and the viewer
plays the full effective duration. A 1000ms synthetic fixture is not a general
animation limit. Keep deterministic renderAt states correct across that duration
while preserving the student's selected parameter.

## Check the design across the range

The host creates actual untouched, min, intermediate, middle and max frame
evidence for independent review, and checks real control wiring. In your design,
count each reachable state, check both ends for collisions and keep labels at
least 20px, key values at least 28px. No misleading fractional count or frozen
readout may contradict the controlled picture. Motion must teach a relationship.
Do not claim you rendered or saw positions in this author role. Reviewer frames
are derived evidence, never original textbook pages.

## Return and justified limitation

Return only `{"artifact":{"visuals":[completeNativeEntry]},"dispositions":[],"note":"..."}`.
Use the supplied target's original index. Do not output a partial patch.
If the task cannot honestly support a slider, retain the complete supplied entry
in your artifact and explicitly report `declined:true` and a `declined_reason`
at the top level; do not pretend a control exists or ask a reviewer to veto it.

## Final interaction revision

On FINAL REVISION, revise this separate interaction artifact once from its
advisory findings. Prefer supported small changes; explain any declined feedback
in `dispositions`. Keep all copied native identity and English fields unchanged.
Your complete final revision remains the interaction result even if concerns
remain. Final rendering/export reports execution status without a content-quality
gate, further review or substitution of the base visual.
