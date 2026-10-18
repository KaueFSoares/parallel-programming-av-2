# Project Overview

## Purpose

Process Brazil's Federal Revenue Service (Receita Federal) CNPJ "Estabelecimentos" open dataset — ~16 GB of semicolon-delimited CSV records too large to hold in memory as a single operation — using a reproducible, parallel, serverless-style pipeline. The second goal is academic: run controlled performance experiments that measure how execution time and throughput scale with the level of parallelism, identify the point of diminishing returns, and support the analysis with collected data rather than assumptions.

## Problem statement

- The input is 10 source archives containing establishment records; total decompressed size is ~16.2 GB (see Dataset below).
- The data must be processed correctly and completely, with verifiable coverage of every input record.
- Work must be distributable across independent processing units with **configurable concurrency**.
- The experiment must answer: *where does increasing parallelism stop improving performance, and why?* using measured speedup and parallel efficiency, not presumed linear scaling.

## Source dataset

- **Source:** official RFB CNPJ open data, release **2026-10**.
  - <https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj>
  - <https://arquivos.receitafederal.gov.br/index.php/s/YggdBLfdninEJX9?dir=/2026-10>
- **Local copies:** `~/Downloads/download/` contains the 10 `Estabelecimentos{0..9}.zip` archives (≈4.1 GB compressed total) and their decompressed files (~16.2 GB total). Verified: local file sizes match the official 2026-10 release listing exactly.
- **Structure (verified on the 10-row sample only):** semicolon-delimited, every field double-quoted, **30 fields per row, no header row**, LF line endings. Field sequence matches the known RFB Estabelecimentos layout: CNPJ base/order/DV, matriz-filial flag, nome fantasia, situação cadastral + date + motivo, cidade exterior, país, início de atividade, CNAE principal, CNAE secundária, endereço (tipo, logradouro, número, complemento, bairro), CEP, UF, município, DDD1/telefone1, DDD2/telefone2, DDD fax/fax, e-mail, situação especial + date.
- **Encoding (verified by measurement):** the raw files are **ISO-8859-1 (Latin-1)**, not UTF-8 — high bytes decode to Portuguese accents and no valid UTF-8 sequences exist in sampled regions. The pipeline decodes raw CSVs as Latin-1 so byte offsets map 1:1 to file offsets; counted dimensions (UF, município, CNAE, situação, matriz/filial) are ASCII codes and are unaffected.
- **Evidence limits:** 10 rows cannot prove the whole dataset is well-formed. Exceptional records (malformed quoting, unusual lengths, encodings) may exist. The official field-name document should be cross-checked during implementation (gov.br was unreachable during this exploration).
- **Anomaly resolved (2026-10-18):** archive 0 contains 31,028,468 records while archives 1–9 hold ~4,753,435 each; total ≈ 73.8M records in 16.2 GB (measured by streaming line counts). The release is genuinely imbalanced by CNPJ range — not corruption. Partitioning and experiments must treat part 0 as ~6.5× the size of the others.
- The release also ships Empresas/Socios/Simples/etc. tables; only Estabelecimentos was downloaded and is in scope.

## Expected processing outcomes

- **Confirmed:** a single-pass aggregation producing one JSON document at the end of the pipeline. Every input line is read exactly once; the pipeline counts records by dimension — counts by UF, municipality, CNAE principal, situação cadastral, and matriz/filial flag, plus total and malformed-record counts. All dimensions are positional columns on every row, so no joins or lookups are needed. The exact JSON shape is an implementation detail; the workload is a pure map-reduce over all 73.8M rows.
- **Accuracy note (explicit owner statement):** aggregation accuracy is not the objective — the project measures concurrency gains. Malformed lines are counted and skipped (see `docs/architecture.md`).

## Functional requirements

1. Stream the input; never require the full dataset in memory.
2. Prepare independent work units (partitioning of large CSV inputs, aware that rows contain quoted fields and there is no header row).
3. Record a manifest of processing units so coverage is auditable.
4. Execute workers in parallel with configurable concurrency.
5. Consolidate partial results correctly and verify completeness against the manifest.
6. Measure execution time, throughput, speedup, and parallel efficiency per configuration.
7. Repeat runs under controlled configurations (assignment requirement).
8. Run the same workload locally (Floci) and on real AWS, comparing results while recognizing emulator timings are not equivalent to production performance (assignment requirement).

## Non-functional requirements

- **Correctness first:** aggregation results must be verified, not assumed.
- **Reproducibility:** pinned versions (Node, Floci image, dependencies), scripted setup, version-controlled docs and configuration.
- **Portability:** the code must run unchanged against Floci locally and real AWS in the cloud, via AWS SDK v3 + `AWS_ENDPOINT_URL`; no coupling to a specific emulator. Floci is the only supported emulator.
- **Privacy:** never include real record values in documentation, logs, or fixtures; describe schema only.
- **Resource awareness:** local machine has 12 CPUs / 30 GB RAM / 282 GB free disk; real-AWS runs cost time and money.

## Development and execution environments

- **Language/runtime:** TypeScript on Node.js **24.22.0** (pinned via `.nvmrc`; installed via NVM, currently not the active default — 26.9.0 is active and must not be changed during setup).
- **Local AWS emulation:** Floci (MIT, free, Docker-based, 126 AWS services on `:4566`) — the only emulator in scope (user decision; LocalStack excluded). **Installed and validated 2026-10-18:** floci-cli 0.4.0 (user-level at `~/.local/bin`), emulator image `floci/floci:latest`; project config should pin a fixed release (2.3.0, 2026-10-15). Start with `floci start`, configure via `eval "$(floci env)"`, stop with `floci stop`. Hands-on probes validated S3, Step Functions Distributed Map (CSV `ItemReader` and manifest-driven), Lambda (`nodejs24.x` runtime), CloudFormation, and AWS CDK via `cdklocal` — details in `docs/architecture.md`.
- **Real AWS:** an account exists; credentials setup is a future task. AWS CLI is not currently installed.
- **Infrastructure as code:** AWS CDK is preferred where it serves the objectives, but not yet mandated; validate against emulator capabilities before committing.
- **Machine:** 12 cores, 30 GB RAM, Docker 29.9.0 with daemon running.

## Technology direction and constraints

- Initial architecture candidates: S3 for source/prepared/intermediate/final data, Lambda for per-partition compute, Step Functions for orchestration and parallel fan-out.
- Confirmed component set: **Lambda + S3 + Step Functions**. Not selected: SQS fan-out, a local non-AWS Node.js baseline.
- Floci compatibility notes that shape design: S3 and Step Functions are emulated in-process (with documented deviations, e.g., Step Functions `Wait` capped at 30 s locally); Lambda executes in real Docker containers using AWS runtime images (per-region concurrency limit 1000, configurable; provisioned concurrency not implemented).
- Emulator timings differ from AWS by design; the measurement methodology must treat local and cloud runs as separate regimes.

## Academic experiment goals

- Clearly stated problem and hypothesis (see Purpose/Problem statement).
- **Independent variables:** concurrency level; input size (both confirmed). Exact level sets to be defined in the methodology.
- **Dependent variables:** execution time, throughput (e.g., records/s), derived speedup `S(p) = T(1)/T(p)` and efficiency `S(p)/p`.
- **Controlled parameters:** identical code, data subset, worker configuration, and measurement procedure across runs.
- **Repetition:** repeated measurements per configuration (assignment requirement), e.g., median or mean of N runs; warm-up runs before timed measurements (local Lambda cold starts ≈ 1.3–17 s vs 3–4 ms warm — regimes must be separated).
- **Saturation analysis:** locate the point where added parallelism yields no improvement or degrades performance; qualitatively explain bottlenecks (cold starts, I/O, orchestration overhead, emulator or AWS limits).
- **Scale:** controlled subsets for repeated experiments; one full end-to-end run over all 10 archives.
- **Comparison:** local (Floci) vs real AWS execution, explicitly framed as non-equivalent timing environments.
- **Proposed level sets (explored against the 12-core host and emulator limits):** concurrency in {1, 2, 4, 8, 12, 16, 24, 32, 64}; input sizes as partition counts/sizes (e.g., ~50 MB, 100 MB, 500 MB, 1 GB, 4 GB, full dataset). Final sets to be fixed in the methodology; local ceilings to respect: 500 concurrent Lambda executions (Runtime API port range), region limit 1000 (configurable).

## Expected deliverables

- **Source code with build and run instructions — done:** TypeScript pipeline (prep/worker/consolidator/harness), AWS CDK stack, `README.md` with the full workflow; 37 unit tests.
- **Experiment report — done:** `docs/experiment-report.md` (2–4 pages, English) with methodology, full result tables, speedup/efficiency analysis, and conclusions from the real-data sweep (62 measured runs, all completeness-verified).
- **Evidence for reproduction/audit:** run records in `data/results/exp-{64,256,1024}mb.json` + `combined.md`.

## Scope and non-goals

- **Out of scope:** business application features; joins with Empresas/Socios and other CNPJ tables; SQS-based fan-out; a local non-AWS baseline implementation; AWS cost metrics; LocalStack (Floci is the only emulator).
- **Deferred (not blockers for documentation):** AWS CLI and credentials setup, and copying the dataset into `data/` — planned as setup tasks. (Floci is already installed and validated.)

## Assumptions and unresolved items

| # | Item | Status |
|---|------|--------|
| 1 | Aggregation dimensions and output shape | Confirmed: single-pass counts (UF, municipality, CNAE principal, situação cadastral, matriz/filial) → one JSON |
| 2 | Official RFB field-name layout document | Minor — positional schema used; cross-check optional |
| 3 | Full dataset is well-formed | Policy applied: malformed lines counted and skipped (accuracy not the goal) |
| 4 | Estabelecimentos0 size imbalance | Resolved — real release imbalance (31.0M vs ~4.75M records/part) |
| 5 | Experiment level sets (concurrency values, input sizes, run counts) | Executed: {1..32} × {64,256,1024} MiB, warm-up + 2–3 reps; see `docs/experiment-report.md` |
| 6 | AWS credentials setup timing and full-run budget | Open — account exists, setup later (stack IAM is real-AWS-ready) |
| 7 | AWS CDK viability on the emulator | Resolved — validated end-to-end via cdklocal (bootstrap + deploy) |
| 8 | Assignment's specific analysis questions for the report | Not provided — report answers the goals above |
