# Workspace Instructions & Directives

## Automatic Git Push Workflow
- Whenever any code edits, bug fixes, or new features are created in this repository, the AI assistant must automatically stage, commit, and run `git push origin main`.
- The user must never be required to manually type or run `git push`.
- All changes pushed to `origin/main` automatically flow into the live production deployment on `alertly.live` via the background `start.sh` runner.
