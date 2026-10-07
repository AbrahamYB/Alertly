# Alertly installation work tracker

This file tracks implementation decisions so later upgrades extend the installer instead of replacing it.

## Completed — foundation v1

- Defined deployment profiles: demo and organization.
- Defined installation methods: Docker, contained native Linux, and split deployment.
- Added local hardware and operating-system detection.
- Added a dependency-free Linux bootstrap wizard so setup does not require host Node.js.
- Added selectable NVIDIA, AMD, Intel, CPU-only, and remote processing modes.
- Added versioned, revisioned configuration output.
- Added non-secret configuration history.
- Defined the native installation containment contract under `/opt/alertly`.
- Added a hardened systemd service template.
- Selected PostgreSQL as the durable queue setting for the upgrade build.

## Next implementation stage

- Generate a reviewable installation plan from `installation.json`.
- Add explicit `apply`, `status`, `upgrade`, `rollback`, and `uninstall` commands.
- Package a private Node runtime for native releases.
- Add Docker Compose profiles for CPU, NVIDIA, AMD/Intel, and remote workers.
- Implement the PostgreSQL-backed job repository and asynchronous report pipeline.
- Add live queue-time estimation to report submission.
- Add the localhost-only browser wizard using the same schema and detection engine.

## Safety invariants

- Never bind or modify TCP 443; native Xray owns it on the current server.
- Never modify unrelated Docker services or host networking.
- Never store secrets in generated plans, history, logs, or browser-visible state.
- Never perform destructive removal without displaying the exact targets first.
- Native mode may write only beneath `/opt/alertly` plus its single systemd service file.

