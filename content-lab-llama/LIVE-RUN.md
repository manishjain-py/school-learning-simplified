# The full live run

On **30 October 2026** the connected pipeline ran all **18 stages** once, end to end, on
one chapter's input pages, with Meta's **Llama 4 Maverick** on Amazon Bedrock.

- **Model calls:** 94, all to Llama 4 Maverick, for about **USD 0.23** in total. None was
  left unresolved.
- **Stages:** TOC, Guideline, Explain, Practice, Revise, Hindi Translate, Visuals, Boards
  (English and Hindi), six narration stages (English and Hindi), Avatar (English and Hindi)
  and Feedback. The 12 model stages called Llama. The six narration stages use local macOS
  voices and make no model calls.
- **What it made:** a contents map, a teaching guideline, explanation cards with check-in
  questions, practice questions, revision cards, their Hindi translation, visuals,
  pencil-board animations narrated in English and Hindi, and a stylized narrated welcome in
  both languages.
- **Resume:** resuming the finished run repeated no call and left every file and the cost
  unchanged.

**Limits, plainly:**
- The Feedback stage made no change: its local application was a no-op, so this run does
  not show a live repair.
- The media are samples: selected sample media, macOS speech and estimated word timing.
- Nothing from this run was published to the app.

The chapter's input pages and the run's outputs are not in this repository. To run the
pipeline yourself, see [README.md](README.md).
