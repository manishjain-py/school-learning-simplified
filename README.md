# School Learning Simplified

School Learning Simplified is a learning web app for Indian school students. It
teaches Class 4 Environmental Studies (EVS) in English and Hindi, with Learn,
Revise and Practice for each chapter. On the school side, a teacher writes a short
class note; Meta's Llama reads it and turns it into each child's next steps.
Teachers and parents also share a private conversation, where the teacher can
start a message with **Draft with Llama**.

- **Live site:** https://schoollearningsimplified.com
- **Demo film:** https://schoollearningsimplified.com/media/film/53a9b75e369d2916/index.html
- **Guide:** [GUIDE.md](GUIDE.md) walks through the student, teacher and parent journeys.

## Try it

Prepared demo accounts for a student, a teacher and a parent are given in the
hackathon submission form. You can also choose **Sign up** on the live site,
confirm the emailed code and use the library on your own.

## How Llama is used

- **In the app:** Llama 3.3 70B on Amazon Bedrock reads each teacher's class note
  and finds the chapter, activity and children it is about. The app checks the
  result before it publishes each child's next steps. Llama also drafts parent
  notes from the selected lesson; the teacher reads and edits a draft before
  sending it. Children's names are replaced before Llama sees a note.
- **In the Content Lab:** a LangGraph pipeline of 18 stages and 54 agent roles,
  running on Llama 4 Maverick on Amazon Bedrock, authors a chapter's content:
  contents map, teaching guideline, explanations, practice questions, revision
  cards, Hindi translation, visuals, drawn boards, a narrated avatar and feedback
  repair. See [content-lab-llama/README.md](content-lab-llama/README.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/web` | React and Vite web app: library, lesson player, Practice, Revise, report cards and the school workspace |
| `apps/api` | TypeScript API for AWS Lambda: lessons, progress, Practice grading, schools, guidance, Llama features and parent email |
| `content/releases/m2` | Lesson, Practice, Revise and scene data for two chapters in English and Hindi |
| `content/public` | A small one-chapter lesson set that the API uses by default |
| `infra` | Terraform for the AWS resources |
| `scripts` | Tests for shared web helpers |
| `content-lab-llama` | The Content Lab pipeline (Python, LangGraph) |
| `licenses` | Third-party licence texts |

## Run locally

You need Node 22.12 or newer and npm. From the repository root:

```sh
npm ci
npm run build    # type checks, then builds the web app and the API
```

Start the API with the lesson data in one terminal:

```sh
NODE_ENV=development CONTENT_RELEASE=m2 LOCAL_CONTENT_DIR="$PWD/content/releases/m2" npm run dev:api
```

Start the web app in a second terminal, then open http://127.0.0.1:4180:

```sh
npm run dev
```

The API listens on 127.0.0.1:4181 and Vite forwards `/api`, `/content`, `/media`
and `/config.json` to it. Locally you see the signed-out first page, and the API
serves the lesson data, for example `/api/catalog` and
`/api/lessons/<chapter id>?language=en`. Signing in, the learner screens, saved
progress, Practice grading, the school workspace and the Llama features need the
deployed AWS services (Cognito, DynamoDB, S3, Bedrock and SES). Lesson audio and
images are not stored in this repository.

Environment variables, by name only:

- Local runs: `NODE_ENV`, `CONTENT_RELEASE`, `LOCAL_CONTENT_DIR`, and optionally
  `LOCAL_MEDIA_DIR`, `LOCAL_PRIVATE_CONTENT_DIR`, `USER_POOL_ID` and
  `USER_POOL_CLIENT_ID`.
- Deployed API: `AWS_REGION`, `TABLE_NAME`, `CONTENT_BUCKET`, `CONTENT_RELEASE`,
  `USER_POOL_ID`, `SITE_URL`, `RELEASE_SHA`, `SCHOOL_AI_ENABLED`,
  `PARENT_EMAIL_ENABLED`, `PARENT_EMAIL_FROM` and `PARENT_EMAIL_ALLOWED_RECIPIENTS`.

## Tests

The API, web and helper tests use Node's test runner with mocked AWS and model
calls, so they need no cloud access:

```sh
./node_modules/.bin/tsx --test $(find apps scripts -name '*.test.ts' -not -path '*/node_modules/*')
```

The Content Lab has its own Python tests; see its README.

## Built during the hackathon

- The web app, with its mobile-first library and English and Hindi screens
- The API and its AWS integrations
- The lesson player and the drawing engine for narrated scenes
- Practice sets with server-side grading, and report cards
- The school workspace: schools, classes, class notes, guidance, family updates
  and private teacher-parent replies
- The Llama features: reading class notes and Draft with Llama
- The Content Lab pipeline
- The infrastructure code

The lesson content and the agents' starting prompts were prepared by the founder before the event; all the code was written during it.
