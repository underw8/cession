## Summary

<!-- What changed and why. -->

## Related Issue

Closes #

## Type

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor
- [ ] CI/CD
- [ ] Docs

## Changes

<!-- Key files changed and what each does. -->

-

## Checklist

- [ ] `make test` passes (server tests, typecheck, widget tests)
- [ ] `sh plugin/test.sh` passes against `make dev` if the plugin or ingest routes changed
- [ ] No tokens, cookies or `SETUP_CODE` in code, tests or screenshots
- [ ] Ingest routes still sit above the session gate (`test/gate.test.ts`)
- [ ] `plugin/.claude-plugin/plugin.json` version bumped if `plugin/` changed
- [ ] AGENTS.md updated if architecture, invariants or pitfalls changed

## Deployment Notes

<!-- New secrets or vars, a schema change the Hub migrates on start, or a plugin update users must re-run /cession:setup for. Write "None" if it just needs a deploy. -->

## Test Plan

<!-- How you verified this: test output, dashboard or widget screenshots. -->
