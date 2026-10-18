#!/usr/bin/env node
/**
 * CDK app entry point for the CNPJ parallel pipeline.
 * Deployed locally against Floci through cdklocal (see scripts/deploy-local.sh).
 */
import * as cdk from "aws-cdk-lib";
import { PipelineStack } from "../lib/pipeline-stack.js";

const app = new cdk.App();

const account = process.env.AWS_ACCOUNT ?? "000000000000";
const region = process.env.AWS_DEFAULT_REGION ?? "us-east-1";

new PipelineStack(app, "CnpjPipelineStack", {
  env: { account, region },
  description: "CNPJ Estabelecimentos parallel processing pipeline (Lambda + S3 + Step Functions).",
});

app.synth();
