# Contributing to Shiftboss

Thanks for contributing. Shiftboss is a local-first mission control for AI coding agents, licensed under Apache-2.0.

## Getting started
- Open an issue first for anything non-trivial so we can agree on the approach.
- Keep pull requests small and focused on one change.

## Work Orders
Most changes should map to a Work Order in `work_orders/`.
Follow the YAML contract in `docs/work_orders.md` and keep changes scoped to the active WO.

## Local development
```bash
npm install
npm run server:dev
npm run dev
```

## Tests
```bash
npm test
```

CI also runs lint, typecheck, and build — `npm run lint`, `npx tsc -p tsconfig.json`, `npm run build`.

## License of contributions
Shiftboss is licensed under the Apache License 2.0 (see `LICENSE`). By submitting a contribution, you agree it is licensed under Apache-2.0, the same license as the project (inbound=outbound). No CLA is required.

## Developer Certificate of Origin (DCO)
All commits must be signed off to certify that you have the right to submit the contribution under the project's license, per the [Developer Certificate of Origin](https://developercertificate.org/).

Add a `Signed-off-by` line to each commit:

```bash
git commit -s -m "Your commit message"
```

which appends:

```
Signed-off-by: Your Name <you@example.com>
```

PRs with unsigned commits will fail the DCO check; use `git rebase --signoff` to fix up existing commits.

## Notes
- Do not commit secrets. Use `.env` and keep it gitignored.
- Keep changes minimal and focused.
