import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const cfg        = new pulumi.Config();
const awsRegion  = cfg.get("awsRegion")  || "us-east-1";
const env        = cfg.get("environment") || "dev";
const projectTag = { Project: "aws-infra-demo", Environment: env };

// ─────────────────────────────────────────────
// 1. VPC / NETWORKING  (uses default VPC for simplicity)
// ─────────────────────────────────────────────
const defaultVpc = aws.ec2.getVpc({ default: true });
const defaultSubnets = defaultVpc.then(vpc =>
    aws.ec2.getSubnets({ filters: [{ name: "vpc-id", values: [vpc.id] }] })
);

// Security Group for EC2
const ec2Sg = new aws.ec2.SecurityGroup("ec2-sg", {
    description: "Allow HTTP, HTTPS, and SSH",
    vpcId: defaultVpc.then(v => v.id),
    ingress: [
        { protocol: "tcp", fromPort: 22,  toPort: 22,  cidrBlocks: ["0.0.0.0/0"], description: "SSH" },
        { protocol: "tcp", fromPort: 80,  toPort: 80,  cidrBlocks: ["0.0.0.0/0"], description: "HTTP" },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"], description: "HTTPS" },
        { protocol: "tcp", fromPort: 3000, toPort: 3000, cidrBlocks: ["0.0.0.0/0"], description: "Node App" },
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"], description: "All outbound" },
    ],
    tags: { ...projectTag, Name: "ec2-sg" },
});

// ─────────────────────────────────────────────
// 2. IAM ROLE FOR EC2
// ─────────────────────────────────────────────
const ec2Role = new aws.iam.Role("ec2-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
    tags: { ...projectTag, Name: "ec2-role" },
});

new aws.iam.RolePolicyAttachment("ec2-ssm-policy", {
    role: ec2Role.name,
    policyArn: aws.iam.ManagedPolicy.AmazonSSMManagedInstanceCore,
});

new aws.iam.RolePolicyAttachment("ec2-s3-policy", {
    role: ec2Role.name,
    policyArn: aws.iam.ManagedPolicy.AmazonS3FullAccess,
});

const ec2InstanceProfile = new aws.iam.InstanceProfile("ec2-instance-profile", {
    role: ec2Role.name,
    tags: { ...projectTag },
});

// ─────────────────────────────────────────────
// 3. EC2 INSTANCE  (Amazon Linux 2023, Node.js app)
// ─────────────────────────────────────────────
// Latest Amazon Linux 2023 AMI
const al2023Ami = aws.ec2.getAmi({
    mostRecent: true,
    owners: ["amazon"],
    filters: [
        { name: "name",                values: ["al2023-ami-*-x86_64"] },
        { name: "virtualization-type", values: ["hvm"] },
        { name: "root-device-type",    values: ["ebs"] },
    ],
});

// User-data: install Node.js 20 + PM2 + deploy the Express app
const userDataScript = `#!/bin/bash
set -e
yum update -y
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs git

# Install PM2 globally
npm install -g pm2

# Create application directory
mkdir -p /home/ec2-user/app
cd /home/ec2-user/app

# Write the Express application
cat > package.json << 'EOF'
{
  "name": "demo-app",
  "version": "1.0.0",
  "description": "Basic Node.js Express app on EC2",
  "main": "server.js",
  "dependencies": {
    "express": "^4.18.0"
  }
}
EOF

cat > server.js << 'EOF'
const express = require("express");
const os      = require("os");

const app  = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    message: "Hello from EC2! 🚀",
    hostname: os.hostname(),
    platform: os.platform(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
EOF

# Install dependencies and start with PM2
npm install
pm2 start server.js --name demo-app
pm2 startup systemd -u ec2-user --hp /home/ec2-user
pm2 save

# Allow access on port 3000 via iptables redirect from 80
iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 3000
`;

const ec2Instance = new aws.ec2.Instance("demo-ec2-instance", {
    ami:                      al2023Ami.then(a => a.id),
    instanceType:             aws.ec2.InstanceType.T3_Micro,
    subnetId:                 defaultSubnets.then(s => s.ids[0]),
    vpcSecurityGroupIds:      [ec2Sg.id],
    iamInstanceProfile:       ec2InstanceProfile.name,
    associatePublicIpAddress: true,
    userData:                 userDataScript,
    rootBlockDevice: {
        volumeSize: 30,   // AL2023 in ap-south-1 requires >= 30GB
        volumeType: "gp3",
        deleteOnTermination: true,
    },
    tags: { ...projectTag, Name: "demo-ec2-instance" },
});

// ─────────────────────────────────────────────
// 4. S3 BUCKET
// ─────────────────────────────────────────────
const s3Bucket = new aws.s3.BucketV2("demo-s3-bucket", {
    tags: { ...projectTag, Name: "demo-s3-bucket" },
});

// Block all public access
new aws.s3.BucketPublicAccessBlock("demo-s3-public-access-block", {
    bucket:                s3Bucket.id,
    blockPublicAcls:       true,
    blockPublicPolicy:     true,
    ignorePublicAcls:      true,
    restrictPublicBuckets: true,
});

// Enable versioning
new aws.s3.BucketVersioningV2("demo-s3-versioning", {
    bucket: s3Bucket.id,
    versioningConfiguration: { status: "Enabled" },
});

// Server-side encryption
new aws.s3.BucketServerSideEncryptionConfigurationV2("demo-s3-sse", {
    bucket: s3Bucket.id,
    rules: [{
        applyServerSideEncryptionByDefault: {
            sseAlgorithm: "AES256",
        },
    }],
});

// Upload a sample file to the bucket
const sampleObject = new aws.s3.BucketObjectv2("sample-object", {
    bucket:      s3Bucket.id,
    key:         "uploads/hello.json",
    content:     JSON.stringify({ message: "Hello from S3!", created: new Date().toISOString() }, null, 2),
    contentType: "application/json",
    tags:        { ...projectTag },
});

// ─────────────────────────────────────────────
// 5. IAM ROLE FOR LAMBDA
// ─────────────────────────────────────────────
const lambdaRole = new aws.iam.Role("lambda-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
    tags: { ...projectTag, Name: "lambda-role" },
});

new aws.iam.RolePolicyAttachment("lambda-basic-execution", {
    role:      lambdaRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

new aws.iam.RolePolicyAttachment("lambda-s3-access", {
    role:      lambdaRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonS3FullAccess,
});

// ─────────────────────────────────────────────
// 6. LAMBDA LAYER 1 – "utils-layer"  (shared utility functions)
// ─────────────────────────────────────────────
const layer1 = new aws.lambda.LayerVersion("utils-layer", {
    layerName:          "utils-layer",
    compatibleRuntimes: ["nodejs20.x"],
    code: new pulumi.asset.AssetArchive({
        "nodejs/node_modules/utils/index.js": new pulumi.asset.StringAsset(`
// ── Layer 1: Shared Utilities ──────────────────────────
"use strict";

/**
 * Format a standard API response envelope.
 */
function formatResponse(statusCode, data, message = "Success") {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "X-Powered-By": "aws-infra-demo",
    },
    body: JSON.stringify({ success: statusCode < 400, message, data }),
  };
}

/**
 * Simple logger that includes timestamp + level.
 */
function logger(level, msg, meta = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, msg, ...meta }));
}

/**
 * Sleep helper (async).
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { formatResponse, logger, sleep };
`),
        "nodejs/node_modules/utils/package.json": new pulumi.asset.StringAsset(
            JSON.stringify({ name: "utils", version: "1.0.0", main: "index.js" })
        ),
    }),
    description: "Layer 1 – Shared utility helpers (formatResponse, logger, sleep)",
});

// ─────────────────────────────────────────────
// 7. LAMBDA LAYER 2 – "aws-helpers-layer"  (AWS SDK wrappers)
// ─────────────────────────────────────────────
const layer2 = new aws.lambda.LayerVersion("aws-helpers-layer", {
    layerName:          "aws-helpers-layer",
    compatibleRuntimes: ["nodejs20.x"],
    code: new pulumi.asset.AssetArchive({
        "nodejs/node_modules/aws-helpers/index.js": new pulumi.asset.StringAsset(`
// ── Layer 2: AWS SDK Helpers ───────────────────────────
"use strict";
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });

/**
 * Upload a JSON object to S3.
 */
async function putJsonToS3(bucket, key, data) {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json",
  });
  return s3Client.send(cmd);
}

/**
 * List keys in an S3 bucket with an optional prefix.
 */
async function listS3Objects(bucket, prefix = "") {
  const cmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix });
  const result = await s3Client.send(cmd);
  return (result.Contents || []).map(obj => ({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified }));
}

module.exports = { putJsonToS3, listS3Objects };
`),
        "nodejs/node_modules/aws-helpers/package.json": new pulumi.asset.StringAsset(
            JSON.stringify({
                name: "aws-helpers",
                version: "1.0.0",
                main: "index.js",
                dependencies: { "@aws-sdk/client-s3": "^3.0.0" },
            })
        ),
    }),
    description: "Layer 2 – AWS SDK S3 helper wrappers",
});

// ─────────────────────────────────────────────
// 8. LAMBDA FUNCTION 1 – "processor"
//    Uses Layer 1 (utils) + Layer 2 (aws-helpers)
//    Triggered via Function URL (no API Gateway needed)
// ─────────────────────────────────────────────
const lambdaFn1 = new aws.lambda.Function("processor-lambda", {
    name:        "processor-lambda",
    runtime:     aws.lambda.Runtime.NodeJS20dX,
    handler:     "index.handler",
    role:        lambdaRole.arn,
    timeout:     30,
    memorySize:  256,
    layers:      [layer1.arn, layer2.arn],
    environment: {
        variables: {
            S3_BUCKET:   s3Bucket.bucket,
            ENVIRONMENT: env,
            NODE_ENV:    "production",
        },
    },
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
// ── Lambda Function 1: Processor ──────────────────────
"use strict";

// These modules come from the Lambda Layers
const { formatResponse, logger } = require("utils");
const { putJsonToS3, listS3Objects } = require("aws-helpers");

const BUCKET = process.env.S3_BUCKET;

exports.handler = async (event) => {
  logger("INFO", "Processor Lambda invoked", { event });

  try {
    const action = event.action || event.queryStringParameters?.action || "list";

    if (action === "upload") {
      // Write a record to S3
      const record = {
        id:        Date.now().toString(),
        createdAt: new Date().toISOString(),
        source:    "Lambda-Function-1",
        payload:   event.body ? JSON.parse(event.body) : { demo: true },
      };

      const key = \`records/\${record.id}.json\`;
      await putJsonToS3(BUCKET, key, record);

      logger("INFO", "Record saved to S3", { bucket: BUCKET, key });
      return formatResponse(201, { key, record }, "Record saved to S3 successfully");
    }

    if (action === "list") {
      const objects = await listS3Objects(BUCKET, "records/");
      logger("INFO", "Listed S3 objects", { count: objects.length });
      return formatResponse(200, { count: objects.length, objects }, "S3 objects listed");
    }

    return formatResponse(400, null, \`Unknown action: \${action}. Use 'upload' or 'list'.\`);

  } catch (err) {
    logger("ERROR", "Processor Lambda error", { error: err.message, stack: err.stack });
    return formatResponse(500, null, \`Internal error: \${err.message}\`);
  }
};
`),
    }),
    tags: { ...projectTag, Name: "processor-lambda" },
});

// Function URL for Lambda 1 (public HTTPS endpoint, no API Gateway)
const fn1Url = new aws.lambda.FunctionUrl("processor-lambda-url", {
    functionName:  lambdaFn1.name,
    authorizationType: "NONE",
    cors: {
        allowCredentials: false,
        allowOrigins:     ["*"],
        allowMethods:     ["GET", "POST"],
        allowHeaders:     ["content-type"],
        maxAge:           3600,
    },
});

// ─────────────────────────────────────────────
// 9. LAMBDA FUNCTION 2 – "scheduler"
//    Uses Layer 1 (utils) only
//    Scheduled via EventBridge (runs every 5 minutes)
// ─────────────────────────────────────────────
const lambdaFn2 = new aws.lambda.Function("scheduler-lambda", {
    name:        "scheduler-lambda",
    runtime:     aws.lambda.Runtime.NodeJS20dX,
    handler:     "index.handler",
    role:        lambdaRole.arn,
    timeout:     60,
    memorySize:  128,
    layers:      [layer1.arn],   // only Layer 1
    environment: {
        variables: {
            S3_BUCKET:   s3Bucket.bucket,
            ENVIRONMENT: env,
            NODE_ENV:    "production",
        },
    },
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
// ── Lambda Function 2: Scheduler ──────────────────────
"use strict";

// Only uses Layer 1 (utils)
const { formatResponse, logger, sleep } = require("utils");

exports.handler = async (event) => {
  logger("INFO", "Scheduler Lambda invoked", {
    source:    event.source,
    detailType: event["detail-type"],
    time:      event.time,
  });

  try {
    // Simulate scheduled work (e.g. health-check, cleanup, report)
    const tasks = [
      { name: "health-check",   delay: 100 },
      { name: "cleanup-temp",   delay: 200 },
      { name: "generate-report", delay: 150 },
    ];

    const results = [];
    for (const task of tasks) {
      logger("INFO", \`Running task: \${task.name}\`);
      await sleep(task.delay);
      results.push({
        task:      task.name,
        status:    "completed",
        duration:  task.delay,
        timestamp: new Date().toISOString(),
      });
    }

    logger("INFO", "All scheduled tasks completed", { count: results.length });

    return formatResponse(200, {
      executedAt: new Date().toISOString(),
      environment: process.env.ENVIRONMENT,
      tasksCompleted: results,
    }, "Scheduled run completed successfully");

  } catch (err) {
    logger("ERROR", "Scheduler Lambda error", { error: err.message });
    return formatResponse(500, null, \`Scheduled task failed: \${err.message}\`);
  }
};
`),
    }),
    tags: { ...projectTag, Name: "scheduler-lambda" },
});

// EventBridge rule: trigger "scheduler" every 5 minutes
const schedulerRule = new aws.cloudwatch.EventRule("scheduler-rule", {
    name:               "scheduler-lambda-rule",
    description:        "Trigger scheduler Lambda every 5 minutes",
    scheduleExpression: "rate(5 minutes)",
    tags:               { ...projectTag },
});

new aws.cloudwatch.EventTarget("scheduler-target", {
    rule: schedulerRule.name,
    arn:  lambdaFn2.arn,
});

new aws.lambda.Permission("scheduler-lambda-permission", {
    action:    "lambda:InvokeFunction",
    function:  lambdaFn2.name,
    principal: "events.amazonaws.com",
    sourceArn: schedulerRule.arn,
});

// ─────────────────────────────────────────────
// 10. CLOUDWATCH LOG GROUPS  (explicit, set retention)
// ─────────────────────────────────────────────
new aws.cloudwatch.LogGroup("fn1-logs", {
    name:            pulumi.interpolate`/aws/lambda/${lambdaFn1.name}`,
    retentionInDays: 7,
    tags:            { ...projectTag },
});

new aws.cloudwatch.LogGroup("fn2-logs", {
    name:            pulumi.interpolate`/aws/lambda/${lambdaFn2.name}`,
    retentionInDays: 7,
    tags:            { ...projectTag },
});

// ─────────────────────────────────────────────
// OUTPUTS
// ─────────────────────────────────────────────
export const ec2_instance_id        = ec2Instance.id;
export const ec2_public_ip          = ec2Instance.publicIp;
export const ec2_public_dns         = ec2Instance.publicDns;
export const ec2_app_url            = pulumi.interpolate`http://${ec2Instance.publicIp}`;
export const ec2_app_port_url       = pulumi.interpolate`http://${ec2Instance.publicIp}:3000`;

export const s3_bucket_name         = s3Bucket.bucket;
export const s3_bucket_arn          = s3Bucket.arn;
export const s3_sample_object_key   = sampleObject.key;

export const lambda1_name           = lambdaFn1.name;
export const lambda1_arn            = lambdaFn1.arn;
export const lambda1_function_url   = fn1Url.functionUrl;

export const lambda2_name           = lambdaFn2.name;
export const lambda2_arn            = lambdaFn2.arn;
export const lambda2_schedule       = schedulerRule.scheduleExpression;

export const layer1_arn             = layer1.arn;
export const layer2_arn             = layer2.arn;
