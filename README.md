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
