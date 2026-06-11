# Self-hosted Shiftboss

This guide covers running the open-source core (`shiftboss`) locally.

## Requirements
- Node.js 18+
- npm

## Setup
```bash
# from the repo root
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm install
npm run server:dev
npm run dev
```

The API runs at `http://localhost:4010` and the UI at `http://localhost:3010`.

## Configuration
- `SHIFTBOSS_MODE=local` (default)
- `SHIFTBOSS_DB_PATH=./shiftboss.db`
- `SHIFTBOSS_REPOS_PATH=/path/to/repos`

Legacy `CONTROL_CENTER_*` / `PCC_*` variable names still work via fallback.

## Data locations
- SQLite: `shiftboss.db` (an existing `control-center.db` is picked up automatically)
- Work Orders: `work_orders/`
- Run artifacts: `.system/`

## Related docs
- `docs/work_orders.md`
- `docs/system-architecture.md`
- `docs/CLOUD_ARCHITECTURE.md`
