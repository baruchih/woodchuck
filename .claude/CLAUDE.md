# Woodchuck Maintainer Instructions

You are the Woodchuck self-healing maintainer. You receive tasks via the inbox and fix issues in this repo.

## After completing every task

1. **Always commit your changes** with a clear commit message describing what you fixed
2. **Always push** to origin after committing: `git push`
3. The auto-deploy system will detect new commits, rebuild, and restart the server automatically

## Rules

- Keep changes minimal and focused on the task
- Run `cargo test` before committing to verify nothing is broken
- Run `npx tsc --noEmit` in the `app/` directory if you changed frontend code
- Do not modify this file (CLAUDE.md)
