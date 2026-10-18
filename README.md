# Parallel Processing of the CNPJ Estabelecimentos Dataset

A reproducible, serverless-style parallel pipeline that processes Brazil's Federal Revenue (Receita Federal) CNPJ "Estabelecimentos" open dataset (~73.8M records, ~16 GB) — too large to process in memory as a single operation — and a controlled experiment measuring how execution time and throughput scale with parallelism.

- **Docs:** [`docs/project-overview.md`](docs/project-overview.md) (goals, dataset, requirements), [`docs/architecture.md`](docs/architecture.md) (design, validated emulator facts, open questions), [`AGENTS.md`](AGENTS.md) (working rules for coding agents).

## Architecture (summary)

1. **Preparation** (`npm run prep`): streams each CSV, computes **record-aligned byte ranges** ("units") of configurable size, writes a base manifest and composed manifests (`units-<n>mb.json`), and uploads raw files + manifests to S3.
2. **Processing** (Step Functions): a **Distributed Map** reads the manifest JSON from S3 (`ItemReader`), fans out one **Lambda worker per unit** (configurable `MaxConcurrency`); each worker streams its byte range via `Range: bytes=...` GetObject, counts dimensions (UF, municipality, CNAE, situação cadastral, matriz/filial), and writes partial counts to S3.
3. **Consolidation**: a Lambda merges partials, verifies completeness against the manifest (`units`, `rows`, accounting invariant), and writes the final JSON result.
4. **Experiment** (`npm run experiment` / `npm run report`): sweeps concurrency × input size with warm-ups and repetitions, records timings from execution history, computes speedup/efficiency.

## Prerequisites

- Node.js **24.22.0** via NVM (`.nvmrc`)
- Docker (running daemon)
- Floci (local AWS emulator): floci-cli installed at `~/.local/bin`
- 12+ CPU / 30 GB RAM machine with ~35 GB free disk (dataset + partitions)

## Setup

```bash
nvm use                    # Node 24.22.0
npm install                # install dependencies
floci start                # start the local AWS emulator (http://localhost:4566)
```

## Dataset

Copy the 10 decompressed `K3241...ESTABELE` files into `data/estabelecimentos/` (gitignored; source: Receita Federal 2026-10 release, see `docs/project-overview.md`). A 10-row sample lives in `data/samples/example.csv`.

## Workflow

```bash
# 1. Test
npm test

# 2. Typecheck
npm run build

# 3. Deploy infrastructure to the emulator (bucket, Lambdas, state machine)
npm run deploy:local

# 4. Prepare data: base units of 16 MB, composed manifests for 64/256/1024 MB,
#    upload raw files + manifests to S3
npm run prep -- --data-dir data/estabelecimentos --base-unit-mb 16 \
  --compose-mb 64,256,1024 --bucket cnpj-pipeline-000000000000 --upload-raw

# 5. Run the experiment: concurrency sweep over the 64 MB manifest,
#    1 warm-up + 3 measured runs per level
npm run experiment -- --manifest data/manifests/units-64mb.json \
  --concurrency 1,2,4,8,12,16,24,32 --reps 3 --warmup 1 \
  --bucket cnpj-pipeline-000000000000

# 6. Generate the report (speedup / efficiency / throughput)
npm run report -- data/results/exp-<id>.json
```

Experiment results land in `data/results/` (JSON run records + markdown report), pipeline outputs in S3 under `runs/<runId>/` (`partials/`, `result.json`).

## Real AWS

The same code and CDK stack deploy unchanged to a real account: set AWS credentials, then `cdk bootstrap && cdk deploy`. The bucket name derives from the account (`cnpj-pipeline-<account>`). Emulator timings are not equivalent to production performance — see `docs/architecture.md` for the fidelity notes and local concurrency ceilings.

## Known local limitations (Floci)

- Hard cap of 500 concurrent Lambda executions (Runtime API port range); region limit 1000 (configurable).
- Use disk-backed S3 for the 16 GB dataset: run Floci with `FLOCI_STORAGE_SERVICES_S3_MODE=persistent` (and keep persisted state out of `data/`, e.g. `floci-data/`).
- Cold starts (≈1.3–17 s) dwarf warm invocations (3–4 ms); the harness warms up before timed runs.
