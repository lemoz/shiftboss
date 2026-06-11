# CI Setup

Two GitHub Actions workflows run on pushes to `main` and on pull requests.
Neither requires any GitHub secrets.

## `ci.yml`

Runs on Node 20 with a cached `node_modules`:

1. `npm run lint`
2. `npx tsc -p tsconfig.json` (typecheck)
3. `npm run test:unit`
4. `npm run build` and `npm run server:build`

The Playwright e2e suite (`npm run test:e2e`) is not part of CI; run it locally.

## `private-data-guard.yml`

Scans tracked files for deny-listed private strings and fails if any
`*.db`/`*.bak` files or `.env` files (other than `.env.example`) are tracked.

## Adding secrets later

If future CI steps need external provider access (for example, OpenAI or
ElevenLabs), add the required secrets in the repo settings and document them
here.
