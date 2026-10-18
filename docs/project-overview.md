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
- **Structure (verified on the 10-row sample only):** semicolon-delimited, every field double-quoted, **30 fields per row, no header row**, ASCII, LF line endings. Field sequence matches the known RFB Estabelecimentos layout: CNPJ base/order/DV, matriz-filial flag, nome fantasia, situação cadastral + date + motivo, cidade exterior, país, início de atividade, CNAE principal, CNAE secundária, endereço (tipo, logradouro, número, complemento, bairro), CEP, UF, município, DDD1/telefone1, DDD2/telefone2, DDD fax/fax, e-mail, situação especial + date.
- **Evidence limits:** 10 rows cannot prove the whole dataset is well-formed. Exceptional records (malformed quoting, unusual lengths, encodings) may exist. The official field-name document should be cross-checked during implementation (gov.br was unreachable during this exploration).
- **Anomaly:** archive 0 decompresses to 7.26 GB while the others are ~1.1 GB each; the cause has not been investigated.
- The release also ships Empresas/Socios/Simples/etc. tables; only Estabelecimentos was downloaded and is in scope.

## Expected processing outcomes

- **Confirmed direction:** aggregate dimension counts/statistics over establishment records (examples: counts by UF, municipality, CNAE, situação cadastral, matriz/filial). Classic map-reduce shaped workload.
- **Open:** the exact dimension set, output format, and any derived statistics (e.g., distributions) still need final confirmation.

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
- **Local AWS emulation:** Floci (MIT, free, Docker-based, 126 AWS services on `:4566`) — the only emulator in scope (user decision; LocalStack excluded). Not installed yet — installation is a planned project task.
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
- **Repetition:** repeated measurements per configuration (assignment requirement), e.g., median or mean of N runs.
- **Saturation analysis:** locate the point where added parallelism yields no improvement or degrades performance; qualitatively explain bottlenecks (cold starts, I/O, orchestration overhead, emulator or AWS limits).
- **Scale:** controlled subsets for repeated experiments; one full end-to-end run over all 10 archives.
- **Comparison:** local (Floci) vs real AWS execution, explicitly framed as non-equivalent timing environments.

## Expected deliverables

- Source code with build and run instructions.
- A short report (≈2–4 pages, **English**) presenting the experiment, methodology, collected evidence, and answers to the analysis questions.
- Sufficient evidence and documentation for results to be reproduced and audited.

## Scope and non-goals

- **Out of scope:** business application features; joins with Empresas/Socios and other CNPJ tables; SQS-based fan-out; a local non-AWS baseline implementation; AWS cost metrics; LocalStack (Floci is the only emulator).
- **Deferred (not blockers for documentation):** installing Floci, AWS CLI, credentials setup, and copying the dataset into `data/` — all planned as setup tasks.

## Assumptions and unresolved items

| # | Item | Status |
|---|------|--------|
| 1 | Exact aggregation dimensions and output format | Open — final confirmation needed |
| 2 | Official RFB field-name layout document | To cross-check during implementation |
| 3 | Full dataset is well-formed | Unverified — 10-row sample only; malformed-record policy needed |
| 4 | Estabelecimentos0 decompressed size (7.26 GB) anomaly | Unexplained — inspect during preparation |
| 5 | Experiment level sets (concurrency values, input sizes, run counts) | Open — methodology to be established |
| 6 | AWS credentials setup timing and full-run budget | Open — account exists, setup later |
| 7 | Whether AWS CDK is mandatory or an alternative IaC is acceptable | Open — trade-offs documented in `docs/architecture.md` |
| 8 | Assignment's specific analysis questions for the report | Not provided — report structure follows the goals above |
