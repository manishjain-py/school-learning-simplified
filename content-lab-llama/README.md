# Content Lab

The Content Lab is a pipeline that authors a school chapter's learning content
with Meta's **Llama 4 Maverick** on Amazon Bedrock. Each factory is a
[LangGraph](https://github.com/langchain-ai/langgraph) graph of model roles:
independent drafts, reviewers that check them, and one final author whose
revision is the factory's output. Reviews are kept as advice; no later step can
veto the final author. Built with Llama.

## Factories

| Factory | What it does |
| --- | --- |
| TOC | Reads selected contents pages and maps each chapter to its page range |
| Guideline | Reads a chapter's page images and writes a teaching guideline and a refresher of prerequisite topics |
| Explain | Turns the guideline into explanation cards and separate check-in questions |
| Practice | Plans a question blueprint and grows a Practice question bank |
| Revise | Writes short revision cards |
| Hindi Translate | Translates the teaching cards, check-ins, Practice, feedback and revision cards into Hindi |
| Visuals | Chooses and writes Pixi visuals for selected cards, rendered in a local browser |
| Boards | Draws pencil-board animations timed to the narration, in English and Hindi |
| Avatar | Animates a narrated, stylized tutor from supplied artwork |
| Feedback | Plans repairs from a teacher's feedback and applies them to a separate local copy |

The connected pipeline runs these factories, plus six shared narration stages,
as **18 stages**: TOC → Guideline → Explain → Practice and Revise → Hindi
Translate → Visuals → Boards (English, Hindi) → narration → Avatar (English,
Hindi) → Feedback. Each stage reads only the files and earlier outputs declared
in its manifest, and every run can be resumed without repeating finished calls.

## Requirements

- Python 3.12 or newer on macOS or Linux (Windows users can use WSL).
- For the media stages: Node 20 or newer with npm, ffmpeg and ffprobe. The
  narration stages use macOS `say` with the **Samantha** (English) and **Lekha**
  (Hindi) voices.
- For live runs: AWS credentials that can call an image-capable Meta Llama model
  on Amazon Bedrock. The examples below make no model calls.

## Install

From the repository root:

```sh
cd content-lab-llama
python3.12 -m venv .venv          # or any Python 3.12+
source .venv/bin/activate
python -m pip install -r requirements.lock
cd media && npm ci --ignore-scripts && npm run install-browser && cd ..
```

The last line is needed only for the media stages.

## Try it without a model

The examples use labelled synthetic responses, so they need no credentials and
make no network calls. Choose any new folder as a run's workspace.

```sh
python run_factory.py list
python run_factory.py verify examples/guideline/manifest.json
python run_factory.py run examples/guideline/manifest.json --provider fixture --workspace "$HOME/content-lab-runs/guideline"
python run_factory.py report --workspace "$HOME/content-lab-runs/guideline"
python run_factory.py resume --workspace "$HOME/content-lab-runs/guideline"
```

Each factory has an example under `examples/`. To run all 18 connected stages:

```sh
python run_pipeline.py verify examples/pipeline/manifest.json
python examples/pipeline/offline.py run examples/pipeline/manifest.json --provider fixture --workspace "$HOME/content-lab-runs/pipeline"
python examples/pipeline/offline.py resume --workspace "$HOME/content-lab-runs/pipeline"
python run_pipeline.py report --workspace "$HOME/content-lab-runs/pipeline"
```

Open the printed `report.html` or `pipeline-report.html` in a browser.

## Run with Llama on Bedrock

Live runs can cost money. Copy `examples/bedrock-config.json` (one factory) or
`examples/pipeline/bedrock-config.json` (the pipeline, with a cap per stage),
then set the model, region, token prices and spending caps. The examples ship
with placeholders, so they cannot start a paid run. Credentials come from your
normal AWS credential chain, never from the config file.

```sh
python run_factory.py run <your-manifest.json> --provider bedrock --config <your-config.json> --allow-paid --workspace <new-folder>
python run_pipeline.py run <your-pipeline-manifest.json> --provider bedrock --config <your-budget.json> --allow-paid --workspace <new-folder>
```

Both commands also take `resume --workspace <folder> --allow-paid`. A request is
sent only if its reserved cost fits within the caps you set.

## Tests

With the virtual environment active, from `content-lab-llama`:

```sh
python -m pytest -q -c pytest-current.ini
python -m pytest -q tests/test_visuals_pixi_body_render.py   # needs the media install
```

The tests use synthetic model responses and make no paid calls. Media tests are
skipped when their tools are not installed.
