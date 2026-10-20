# Working agreements

## Invariants

- Keep changes limited to what was asked. Mention unrelated problems instead of fixing them.
- Never print, commit or log secrets, tokens or passwords. Reference them through environment variables or the OS keychain.

## Verification

- Before reporting work as done, run the project's test and lint commands and report the result.
- When a check fails, report the failure and its output instead of weakening the check.

## Boundaries

- Ask before changing CI workflows, lockfiles, database migrations or generated files.
- Before editing files, say which files you will change and why.
