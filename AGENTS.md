# AGENTS.md — Working Instructions for Coding Agents

This repository implements a parallel data-processing pipeline for Brazil's Federal Revenue (Receita Federal) CNPJ "Estabelecimentos" open dataset, plus a performance experiment that measures how execution time and throughput scale with parallelism. It is an academic performance-evaluation project, not a business application.

## Required reading

Before making changes, read, in this order:

1. `docs/project-overview.md` — purpose, requirements, dataset, environment, experiment goals, scope and non-goals.
2. `docs/architecture.md` — architectural understanding, including the **Confirmed / Proposed / Open** status of every design element.
3. `docs/experiment-report.md` — the executed experiment, its results, and conclusions (read before touching the experiment harness).

These files are the shared source of truth. If they contradict each other or the code, do not silently "fix" either side — investigate, report, and ask the user before overriding an established decision.

## Environment

- **Node.js 24.22.0** via NVM, pinned in `.nvmrc`. Do not switch versions or modify the runtime setup as a side effect of other work.
- **TypeScript** is the implementation language. **Established tooling** (do not add alternatives casually): npm + Node 24 (`.nvmrc`), strict TS via `tsc` (`npm run build`), `vitest` for tests (`npm test`), `tsx` for CLIs, esbuild via CDK `NodejsFunction`, `cdklocal` for deploys.
- **Docker** is required for local AWS emulation. The chosen emulator is **Floci** — the *only* supported emulator (LocalStack is explicitly out of scope). Floci is installed and validated (floci-cli 0.4.0 at `~/.local/bin`): start with `floci start`, configure with `eval "$(floci env)"`, stop with `floci stop`. Pin the image to a fixed release (2.3.0) in project configuration — never `latest`.
- **AWS CDK is the confirmed IaC tool.** The validated local workflow is `cdklocal` (aws-cdk-local v3): `cdklocal synth`, `cdklocal bootstrap --force`, `cdklocal deploy --require-approval never`, with `AWS_ENDPOINT_URL_S3=http://s3.localhost.floci.io:4566` set for asset publishing.

## Dataset and privacy rules (mandatory)

- The dataset lives under `data/`, which is gitignored. **Never commit dataset files** to the repository.
- The dataset is ~16 GB decompressed. **Never load whole source files into memory** — always stream. This constraint exists for the machine's 30 GB RAM and is part of what the project must demonstrate.
- Records contain real business names, addresses, and phone numbers. **Never copy record values into documentation, commit messages, logs, or test fixtures.** Document schema and structural characteristics only. The 10-row sample at `/home/kauesoares/Downloads/Estabelecimentos9/example.csv` is illustrative, not proof that the full dataset is well-formed.

## Coding conventions

Established (see `tsconfig.json`): strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM (`"type": "module"`, NodeNext), 2-space indent, double quotes, semicolons. Also:

- **Emulator-agnostic code.** Use AWS SDK v3 and the standard `AWS_ENDPOINT_URL` mechanism. Never call emulator-specific APIs, endpoints, or environment variables in application code; configuration may reference Floci only at the operational layer.
- **Shared contracts** in `src/shared/types.ts` are the API between preparation, workers, orchestration (the CDK `buildDefinition` ASL), and consolidation. Changing a field name requires updating the state machine definition and both handlers in the same change.
- Use disk-backed S3 storage for the dataset (Floci `memory` mode caps at ~2 GiB): run Floci with `FLOCI_STORAGE_MODE=persistent` and keep persisted state out of `data/` (default path is `./data`; use `floci-data/`).
- Respect local ceilings in experiments: 500 concurrent Lambda executions (Runtime API port range 12000–12499) and the per-region limit (default 1000, configurable). Warm up functions before timed runs — local cold starts (≈1.3–17 s) dwarf warm invocations (3–4 ms).
- New conventions (linting, formatting, testing) must be introduced deliberately and documented in this file when adopted.

## Validation expectations

- **`npm test` (vitest) and `npm run build` (`tsc --noEmit`-equivalent typecheck) must pass** for every change.
- Validate behavior against the local emulator before claiming something works: `npm run deploy:local`, then a pipeline run via `npm run experiment`. The sample smoke path uses `data/samples/example.csv` (10 rows).
- Changes to processing logic must be verified for correctness (correct aggregates, complete coverage of all records) — not just "it runs". The pipeline itself verifies completeness per run (manifest units/rows accounting); check `verified=true` in run output.
- Behavioral claims against the emulator must be verified against Floci's service documentation (`docs/architecture.md` lists known deviations).

## Architecture and shared contracts

- `docs/architecture.md` classifies each element as **Confirmed** (agreed or implemented), **Proposed** (not yet approved/validated), or **Open**. Changing a Confirmed decision requires user approval and a coordinated update of both docs and any affected code.
- Do not invent component APIs, schemas, or contracts to make the design look complete; leave unspecified parts marked as Open.
- Always inspect existing code before modifying it. Do not silently override established decisions.

## Scope guardrails

This project deliberately excludes (see `docs/project-overview.md`): joins with other CNPJ tables, an SQS-based fan-out, a local non-AWS baseline implementation, AWS cost metrics, LocalStack, and any business-facing application.
