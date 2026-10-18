#!/usr/bin/env bash
# Deploy the pipeline stack to the local Floci emulator via cdklocal.
# Floci must already be running (floci start) and S3 must use persistent storage
# for the full dataset (see AGENTS.md).
set -euo pipefail

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ENDPOINT_URL_S3=http://s3.localhost.floci.io:4566

cd "$(dirname "${BASH_SOURCE[0]}")/.."

npx cdklocal bootstrap --force
npx cdklocal deploy --require-approval never
