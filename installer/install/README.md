# Alertly installer foundation

This directory contains the versioned foundation for guided Alertly installation.

## Current basic version

- `./install/alertly-setup.sh --detect` performs dependency-free, read-only host detection.
- `./install/alertly-setup.sh` is the bootstrap wizard for a fresh Linux host.
- `node scripts/setup.js` provides the same versioned configuration model once the bundled Alertly runtime is present.
- Choices are saved to `config/installation.json` with a schema version and revision.
- Every saved revision appends a non-secret summary to `config/installation-history.jsonl`.
- This version does not apply system changes. Installation apply/rollback is the next stage.

## Native containment contract

Native mode must never scatter application files throughout the operating system.

- All application releases, the bundled Node runtime, configuration, data, uploads, backups, and logs live beneath `/opt/alertly`.
- A dedicated unprivileged `alertly` account runs the application.
- No global npm packages are installed.
- The only external runtime integration is `/etc/systemd/system/alertly.service`.
- Releases use `/opt/alertly/releases/<version>` and the `/opt/alertly/current` symlink so upgrades and rollbacks are atomic.
- Removing the service file and `/opt/alertly` removes Alertly completely; the installer must show that destructive command before execution.

## Compatibility contract

Future prompts should evolve the configuration by adding a new schema version and migration. Existing keys must not be silently renamed or removed. Secrets never belong in `installation.json` or its history file.

