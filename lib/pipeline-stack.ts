/**
 * PipelineStack: S3 data bucket, worker/consolidator Lambdas, and the
 * Distributed Map state machine that fans out one worker per manifest unit.
 */
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";

const WORKER_ENTRY = "src/functions/worker.ts";
const CONSOLIDATOR_ENTRY = "src/functions/consolidator.ts";

/**
 * Builds the Amazon States Language definition, wiring the resolved Lambda
 * ARNs into the Map processor and the consolidation task.
 */
export function buildDefinition(workerArn: string, consolidatorArn: string): Record<string, unknown> {
  return {
    StartAt: "FanOut",
    States: {
      FanOut: {
        Type: "Map",
        ItemProcessor: {
          ProcessorConfig: { Mode: "DISTRIBUTED", ExecutionType: "STANDARD" },
          StartAt: "Worker",
          States: {
            Worker: {
              Type: "Task",
              Resource: workerArn,
              Retry: [{ ErrorEquals: ["States.ALL"], MaxAttempts: 2, BackoffRate: 2 }],
              End: true,
            },
          },
        },
        ItemReader: {
          Resource: "arn:aws:states:::s3:getObject",
          Parameters: { "Bucket.$": "$.bucket", "Key.$": "$.manifestKey" },
          ReaderConfig: { InputType: "JSON" },
        },
        ItemSelector: {
          "unitId.$": "$$.Map.Item.Value.unitId",
          "key.$": "$$.Map.Item.Value.key",
          "offset.$": "$$.Map.Item.Value.offset",
          "length.$": "$$.Map.Item.Value.length",
          "rows.$": "$$.Map.Item.Value.rows",
          "bucket.$": "$.bucket",
          "outPrefix.$": "$.outPrefix",
        },
        MaxConcurrencyPath: "$.maxConcurrency",
        ResultPath: "$.partials",
        Next: "Consolidate",
      },
      Consolidate: {
        Type: "Task",
        Resource: consolidatorArn,
        Parameters: {
          "bucket.$": "$.bucket",
          "outPrefix.$": "$.outPrefix",
          "partials.$": "$.partials",
          "expectedUnits.$": "$.expectedUnits",
          "expectedRows.$": "$.expectedRows",
        },
        Retry: [{ ErrorEquals: ["States.ALL"], MaxAttempts: 2, BackoffRate: 2 }],
        End: true,
      },
    },
  };
}

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "Data", {
      bucketName: `cnpj-pipeline-${this.account}`,
    });

    const workerFn = new nodejs.NodejsFunction(this, "Worker", {
      entry: WORKER_ENTRY,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(900),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: bucket.bucketName,
      },
    });
    bucket.grantReadWrite(workerFn);

    const consolidatorFn = new nodejs.NodejsFunction(this, "Consolidator", {
      entry: CONSOLIDATOR_ENTRY,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(900),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: bucket.bucketName,
      },
    });
    bucket.grantReadWrite(consolidatorFn);

    const execRole = new iam.Role(this, "PipelineExecRole", {
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
    });
    execRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [workerFn.functionArn, consolidatorFn.functionArn],
      }),
    );
    // Distributed Map ItemReader reads the manifest from S3.
    bucket.grantRead(execRole, "manifests/*");
    // Distributed Map child executions: the state machine role must be able to
    // start, describe, and stop its own executions (required on real AWS).
    execRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["states:StartExecution", "states:DescribeExecution", "states:StopExecution"],
        resources: ["*"],
      }),
    );

    const stateMachine = new sfn.StateMachine(this, "Pipeline", {
      stateMachineName: "cnpj-pipeline",
      role: execRole,
      definitionBody: sfn.DefinitionBody.fromString(
        JSON.stringify(buildDefinition(workerFn.functionArn, consolidatorFn.functionArn)),
      ),
    });

    new cdk.CfnOutput(this, "BucketName", {
      value: bucket.bucketName,
      description: "S3 bucket holding raw data, manifests, partials, and results.",
    });
    new cdk.CfnOutput(this, "StateMachineArn", {
      value: stateMachine.stateMachineArn,
      description: "ARN of the pipeline state machine.",
    });
    new cdk.CfnOutput(this, "WorkerFunctionName", {
      value: workerFn.functionName,
      description: "Name of the worker Lambda function.",
    });
    new cdk.CfnOutput(this, "ConsolidatorFunctionName", {
      value: consolidatorFn.functionName,
      description: "Name of the consolidator Lambda function.",
    });
  }
}
