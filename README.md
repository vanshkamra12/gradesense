# GradeSense

Reads a student answer paper, grades it against a model answer and marking
rubric, and draws annotations at the right place on the page.

## Requirements

Node 20.19+ or 22.12+ (developed on Node 22.21). Vite 8 sets that floor; the
server alone runs on Node 18. No database server, no cloud services.

## Setup

```bash
npm install                     # installs both workspaces
cp server/.env.example server/.env
```

The defaults in `.env.example` run the whole system against a mock grading
provider, so no API key is needed until stage 14.

## Running

Two terminals:

```bash
npm run dev:server              # http://localhost:3001
npm run dev:web                 # http://localhost:5173
```

The web dev server proxies `/api` to the backend, so the frontend needs no base
URL.

## Using the real model

```bash
# server/.env
GRADE_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.7-flash   # whichever model your key can reach
```

Model availability varies by project and billing tier. If a call fails with 403
or 404 the model is not enabled for your key, and 429 with `limit: 0` means the
free tier grants no quota for it — neither is a bug in this code, and the
provider reports them without retrying pointlessly.

`npm run compare --workspace server` grades Script A with the configured
provider and prints the result beside `fixtures/error_key_script_a.md`. Pass a
number to repeat it and see how much the marking varies between runs.

## Other scripts

```bash
npm run build                   # typecheck + compile server, build web bundle
npm run typecheck               # types only, no output
npm test                        # server test suite (vitest)
```

## Layout

```
server/   Express API, PDF handling, grading pipeline, SQLite
web/      React + Vite frontend
fixtures/ Question paper, model answer, sample student scripts
```

## Environment

All configuration is read in `server/src/config.ts`. `.env` is gitignored;
`server/.env.example` documents every variable.
