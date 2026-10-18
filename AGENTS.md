# AGENTS.md — Working Instructions for Coding Agents

This repository implements a parallel data-processing pipeline for Brazil's Federal Revenue (Receita Federal) CNPJ "Estabelecimentos" open dataset, plus a performance experiment that measures how execution time and throughput scale with parallelism. It is an academic performance-evaluation project, not a business application.

## Required reading

Before making changes, read, in this order:

1. `docs/project-overview.md` — purpose, requirements, dataset, environment, experiment goals, scope and non-goals.
2. `docs/architecture.md` — architectural understanding, including the **Confirmed / Proposed / Open** status of every design element.

These files are the shared source of truth. If they contradict each other or the code, do not silently "fix" either side — investigate, report, and ask the user before overriding an established decision.

## Environment

- **Node.js 24.22.0** via NVM, pinned in `.nvmrc`. Do not switch versions or modify the runtime setup as a side effect of other work.
- **TypeScript** is the implementation language. No package manager, build tooling, linter, or test runner has been established yet — do not invent or present unconfigured commands as if they exist.
- **Docker** is required for local AWS emulation. The chosen emulator is **Floci** — the *only* supported emulator (LocalStack is explicitly out of scope). Floci is not installed yet; installation/setup is a planned project task — do not install it ad hoc as part of unrelated work.

## Dataset and privacy rules (mandatory)

- The dataset lives under `data/`, which is gitignored. **Never commit dataset files** to the repository.
- The dataset is ~16 GB decompressed. **Never load whole source files into memory** — always stream. This constraint exists for the machine's 30 GB RAM and is part of what the project must demonstrate.
- Records contain real business names, addresses, and phone numbers. **Never copy record values into documentation, commit messages, logs, or test fixtures.** Document schema and structural characteristics only. The 10-row sample at `/home/kauesoares/Downloads/Estabelecimentos9/example.csv` is illustrative, not proof that the full dataset is well-formed.

## Coding conventions

Not yet established (no `package.json` exists). Until they exist, follow these standing rules:

- **Emulator-agnostic code.** Use AWS SDK v3 and the standard `AWS_ENDPOINT_URL` mechanism. Never call emulator-specific APIs, endpoints, or environment variables in application code; configuration may reference Floci only at the operational layer.
- Pin the Floci Docker image to a fixed version tag (not `latest`) for reproducible experiments.
- Keep Floci's persisted state out of `data/` (Floci's default persistent path is `./data`; use a dedicated directory such as `floci-data/`).
- New conventions (linting, formatting, testing) must be introduced deliberately and documented in this file when adopted.

## Validation expectations

- No test or CI setup exists yet. Validate changes by running the commands that actually exist; state clearly when a workflow is not yet configured.
- Changes to processing logic must be verified for correctness (correct aggregates, complete coverage of all records) — not just "it runs".
- Behavioral claims against the emulator must be verified against Floci's service documentation (`docs/architecture.md` lists known deviations).

## Architecture and shared contracts

- `docs/architecture.md` classifies each element as **Confirmed** (agreed or implemented), **Proposed** (not yet approved/validated), or **Open**. Changing a Confirmed decision requires user approval and a coordinated update of both docs and any affected code.
- Do not invent component APIs, schemas, or contracts to make the design look complete; leave unspecified parts marked as Open.
- Always inspect existing code before modifying it. Do not silently override established decisions.

## Scope guardrails

This project deliberately excludes (see `docs/project-overview.md`): joins with other CNPJ tables, an SQS-based fan-out, a local non-AWS baseline implementation, AWS cost metrics, LocalStack, and any business-facing application.
