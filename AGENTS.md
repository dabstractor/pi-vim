# AGENTS.md

This repo is not expected, for now, to be imported as a dependency; treat exported internals as pi-vim-local unless documented otherwise.

For every new or changed Vim-like feature, add curated nvim parity coverage in `test/nvim-parity*.ts` unless the behavior is intentionally not Vim-compatible. If it is an intentional divergence, make that explicit in tests and documentation.

Known nvim parity gaps may live as skipped tests. Apply the boy scout principle: when a branch touches the relevant behavior, unskip and fix nearby skipped parity cases alongside the branch's own change, or document why the gap remains out of scope. Do not batch unrelated parity fixes into a conflict-heavy branch.

Behavior the harnesses cannot reach — the terminal, Pi's own prompt widgets, a real paste, a wrapping extension — is checked by hand. Keep `doc/dev/manual-qa.md` in step with the feature: a branch that adds such a surface adds its cases there.

When reviewing changes — including agent self-review before opening or merging a PR — follow `doc/review-guidelines.md`; its project-specific MUST-flag rules take precedence over general review heuristics.

npm publishing is automated in CI (`.github/workflows/publish.yml`): every push to `main` publishes the `package.json` version if it is not already on npm. Do not run `npm publish` or ask for publish access — to release, bump the version in `package.json`.
