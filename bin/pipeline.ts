#!/usr/bin/env node
/**
 * CDK app entry point for the CNPJ parallel pipeline.
 * Deployed locally against Floci through cdklocal (see scripts/deploy-local.sh)
 * or against a real account with plain `cdk deploy`.
 */
import * as cdk from "aws-cdk-lib";
import { PipelineStack } from "../lib/pipeline-stack.js";

const app = new cdk.App();

// Explicit env only when provided; otherwise CDK resolves account/region from
// the active credentials (Floci: 000000000000; real AWS: the caller's account).
const env: cdk.Environment | undefined =
  process.env.AWS_ACCOUNT || process.env.AWS_DEFAULT_REGION
    ? { account: process.env.AWS_ACCOUNT, region: process.env.AWS_DEFAULT_REGION }
    : undefined;

new PipelineStack(app, "CnpjPipelineStack", {
  env,
  description: "CNPJ Estabelecimentos parallel processing pipeline (Lambda + S3 + Step Functions).",
});

app.synth();
