# 🚀 AWS Infrastructure with Pulumi + Node.js — Full Walkthrough

> **Status: ✅ LIVE** — Deployed on AWS `ap-south-1` (Mumbai) on June 3, 2026

---

## 📋 What We Built

We built a complete **AWS cloud infrastructure** using **Pulumi** (Infrastructure as Code) with **Node.js/TypeScript**. Everything was defined as code — no clicking in the AWS Console.

| Resource | Name | Status |
|---|---|---|
| 🖥️ EC2 Instance | `demo-ec2-instance` | ✅ Running |
| 🪣 S3 Bucket | `demo-s3-bucket-baa3c7c` | ✅ Active |
| ⚡ Lambda Function 1 | `processor-lambda` | ✅ Live |
| ⚡ Lambda Function 2 | `scheduler-lambda` | ✅ Live |
| 📦 Lambda Layer 1 | `utils-layer` | ✅ Active |
| 📦 Lambda Layer 2 | `aws-helpers-layer` | ✅ Active |

**Total resources created: 25**

---

## 🏗️ Architecture

```
Your Machine
     │
     │  pulumi up
     ▼
┌─────────────────────────────────────────────────────┐
│              AWS — ap-south-1 (Mumbai)               │
│                                                     │
│  ┌──────────────────┐   ┌──────────────────────┐   │
│  │   EC2 Instance   │   │      S3 Bucket        │   │
│  │  t3.micro        │   │  demo-s3-bucket-      │   │
│  │  Amazon Linux    │   │  baa3c7c              │   │
│  │  2023            │   │  ✓ Versioning ON      │   │
│  │                  │   │  ✓ Encrypted AES-256  │   │
│  │  Node.js app     │   │  ✓ Public access OFF  │   │
│  │  Express :3000   │   └──────────┬───────────┘   │
│  │  IP:13.203.202.84│              │                │
│  └──────────────────┘              │ read/write     │
│                                    │                │
│  ┌─────────────────────────────────┼─────────────┐  │
│  │           Lambda Functions      │             │  │
│  │                                 │             │  │
│  │  ┌───────────────────┐  ┌───────▼──────────┐ │  │
│  │  │  scheduler-lambda │  │ processor-lambda │ │  │
│  │  │  (Function 2)     │  │  (Function 1)    │ │  │
│  │  │                   │  │                  │ │  │
│  │  │  Trigger: Every   │  │  Trigger: HTTPS  │ │  │
│  │  │  5 mins via       │  │  Function URL    │ │  │
│  │  │  EventBridge      │  │  (public)        │ │  │
│  │  │                   │  │                  │ │  │
│  │  │  Uses: Layer 1    │  │  Uses: Layer 1   │ │  │
│  │  │                   │  │        Layer 2   │ │  │
│  │  └───────────────────┘  └──────────────────┘ │  │
│  │                                               │  │
│  │  ┌────────────────┐  ┌──────────────────────┐ │  │
│  │  │ Layer 1        │  │ Layer 2              │ │  │
│  │  │ utils-layer    │  │ aws-helpers-layer    │ │  │
│  │  │                │  │                      │ │  │
│  │  │ formatResponse │  │ putJsonToS3          │ │  │
│  │  │ logger         │  │ listS3Objects        │ │  │
│  │  │ sleep          │  │                      │ │  │
│  │  └────────────────┘  └──────────────────────┘ │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 🛠️ Technology Stack

| Tool | Purpose | Version |
|---|---|---|
| **Pulumi** | Infrastructure as Code (IaC) | v3.244.0 |
| **TypeScript** | Pulumi program language | ~5.x |
| **Node.js** | Lambda runtime + EC2 app | 20.x |
| **@pulumi/aws** | AWS resource provider | ^6.0.0 |
| **Express.js** | EC2 web application | ^4.18 |

---

## 📁 Project File Structure

```
IaC/
├── index.ts          ← All 25 AWS resources defined here
├── Pulumi.yaml       ← Project name & runtime (nodejs)
├── Pulumi.dev.yaml   ← Stack config (region: ap-south-1)
├── package.json      ← Node.js dependencies
├── tsconfig.json     ← TypeScript compiler settings
├── deploy.sh         ← One-command deploy script
├── .env              ← Your AWS credentials (never commit!)
├── .env.example      ← Safe template to share
└── .gitignore        ← Protects .env from git
```

---

## 🔑 Step 1 — Understanding Pulumi (IaC)

**Infrastructure as Code (IaC)** means instead of manually clicking in the AWS Console, you **write code** that describes what you want, and Pulumi creates/manages it automatically.

### How Pulumi Works:

```
You write TypeScript code
        │
        ▼
Pulumi reads your code
        │
        ▼
Pulumi calls AWS APIs
        │
        ▼
AWS creates real resources
        │
        ▼
Pulumi saves "state" (what was created)
```

### The Pulumi State
Pulumi keeps a **state file** (`~/.pulumi/stacks/aws-infra-demo/dev.json`) that tracks every resource it created. This lets it:
- Know what already exists (don't recreate it)
- Know what changed (update only what's different)
- Know what to delete when you run `pulumi destroy`

---

## 📝 Step 2 — The Main Code (`index.ts`)

The entire infrastructure is defined in one TypeScript file. Here's how each section works:

### 2.1 — Config & Tags
```typescript
const cfg = new pulumi.Config();
const awsRegion = cfg.get("awsRegion") || "us-east-1";
const env = cfg.get("environment") || "dev";
const projectTag = { Project: "aws-infra-demo", Environment: env };
```
We read config from `Pulumi.dev.yaml` and set tags that appear on every AWS resource.

---

### 2.2 — Networking (Default VPC)
```typescript
const defaultVpc = aws.ec2.getVpc({ default: true });
```
We used AWS's **Default VPC** (every account has one) — no need to create a custom VPC. This keeps the setup simple.

**Security Group** — Acts like a firewall:
```typescript
ingress: [
  { protocol: "tcp", fromPort: 22,   toPort: 22,   ... }, // SSH
  { protocol: "tcp", fromPort: 80,   toPort: 80,   ... }, // HTTP
  { protocol: "tcp", fromPort: 3000, toPort: 3000, ... }, // Node.js app
]
```

---

### 2.3 — EC2 Instance

**What is EC2?**
EC2 = Elastic Compute Cloud = a **virtual machine** (server) in AWS.

```typescript
const ec2Instance = new aws.ec2.Instance("demo-ec2-instance", {
    ami:          al2023Ami.then(a => a.id),  // Amazon Linux 2023
    instanceType: aws.ec2.InstanceType.T3_Micro,
    userData:     userDataScript,             // runs on first boot
    rootBlockDevice: {
        volumeSize: 30,   // 30GB disk (minimum for AL2023)
        volumeType: "gp3",
    },
});
```

**User Data Script** — Runs automatically when EC2 boots:
```bash
# Installs Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs

# Installs PM2 (keeps Node.js app running forever)
npm install -g pm2

# Creates and starts the Express app
pm2 start server.js --name demo-app
pm2 startup  # auto-restart on reboot
```

The Express app responds to:
- `GET /` → Returns hostname, platform, uptime, timestamp
- `GET /health` → Returns health status

**✅ Verified Live:**
```json
{
  "message": "Hello from EC2! 🚀",
  "hostname": "ip-172-31-0-239.ap-south-1.compute.internal",
  "platform": "linux",
  "uptime": 99.06,
  "timestamp": "2026-06-03T09:23:33.694Z"
}
```

---

### 2.4 — S3 Bucket

**What is S3?**
S3 = Simple Storage Service = **file/object storage** in AWS (like a cloud hard drive).

```typescript
const s3Bucket = new aws.s3.BucketV2("demo-s3-bucket", { ... });
```

We added 3 extra configurations:

| Config | What it does |
|---|---|
| `BucketPublicAccessBlock` | Blocks ALL public access (security) |
| `BucketVersioningV2` | Keeps history of every file version |
| `BucketServerSideEncryptionConfigurationV2` | Encrypts all files with AES-256 |

We also uploaded a sample file:
```typescript
new aws.s3.BucketObjectv2("sample-object", {
    key:     "uploads/hello.json",
    content: JSON.stringify({ message: "Hello from S3!" }),
});
```

---

### 2.5 — Lambda Layers

**What are Lambda Layers?**
A Layer is a **shared code package** that multiple Lambda functions can use — like npm packages but for Lambda. Instead of bundling the same code into every function, you put it in a Layer once.

#### Layer 1 — `utils-layer`
Shared helper utilities used by **both** Lambda functions:

```javascript
// formatResponse — standard API response
function formatResponse(statusCode, data, message) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ success: statusCode < 400, message, data }),
  };
}

// logger — structured JSON logging to CloudWatch
function logger(level, msg, meta = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, msg }));
}

// sleep — async delay helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

#### Layer 2 — `aws-helpers-layer`
AWS SDK wrappers used by **Lambda Function 1** only:

```javascript
// Upload JSON data to S3
async function putJsonToS3(bucket, key, data) { ... }

// List objects in S3
async function listS3Objects(bucket, prefix) { ... }
```

**How the code tells Pulumi where to put layer files:**
```typescript
code: new pulumi.asset.AssetArchive({
    "nodejs/node_modules/utils/index.js": new pulumi.asset.StringAsset(`...`),
})
```
The path `nodejs/node_modules/` is the **required folder structure** for Node.js Lambda Layers. AWS automatically adds it to the `NODE_PATH` so functions can `require("utils")` directly.

---

### 2.6 — Lambda Function 1 — `processor-lambda`

**Trigger:** Public HTTPS URL (no API Gateway needed!)
**Layers:** Both Layer 1 + Layer 2

```javascript
// In the Lambda function, we just require() from the layers:
const { formatResponse, logger } = require("utils");       // Layer 1
const { putJsonToS3, listS3Objects } = require("aws-helpers"); // Layer 2

exports.handler = async (event) => {
  const action = event.queryStringParameters?.action || "list";

  if (action === "upload") {
    // Save data to S3
    await putJsonToS3(BUCKET, `records/${Date.now()}.json`, payload);
    return formatResponse(201, { key }, "Saved to S3!");
  }

  if (action === "list") {
    // List files in S3
    const objects = await listS3Objects(BUCKET, "records/");
    return formatResponse(200, { objects });
  }
};
```

**Function URL** (public HTTPS endpoint, no API Gateway cost):
```typescript
new aws.lambda.FunctionUrl("processor-lambda-url", {
    authorizationType: "NONE",   // public
    cors: { allowOrigins: ["*"], allowMethods: ["GET", "POST"] },
});
```

---

### 2.7 — Lambda Function 2 — `scheduler-lambda`

**Trigger:** EventBridge (runs automatically every 5 minutes)
**Layers:** Only Layer 1 (utils)

```typescript
// EventBridge rule
const schedulerRule = new aws.cloudwatch.EventRule("scheduler-rule", {
    scheduleExpression: "rate(5 minutes)",
});

// Connect rule to Lambda
new aws.cloudwatch.EventTarget("scheduler-target", {
    rule: schedulerRule.name,
    arn:  lambdaFn2.arn,
});

// Give EventBridge permission to invoke Lambda
new aws.lambda.Permission("scheduler-lambda-permission", {
    action:    "lambda:InvokeFunction",
    principal: "events.amazonaws.com",
    sourceArn: schedulerRule.arn,
});
```

The function simulates scheduled tasks (health-check, cleanup, report):
```javascript
const tasks = [
  { name: "health-check",    delay: 100 },
  { name: "cleanup-temp",    delay: 200 },
  { name: "generate-report", delay: 150 },
];

for (const task of tasks) {
  await sleep(task.delay);  // sleep() comes from utils Layer 1
  // task complete...
}
```

---

### 2.8 — IAM Roles

**What is IAM?**
IAM = Identity and Access Management = **permissions** in AWS.

We created 2 roles:

**EC2 Role** — Allows the EC2 instance to:
- Connect via AWS Systems Manager (SSM) — no SSH key needed
- Read/write S3 bucket

**Lambda Role** — Allows Lambda functions to:
- Write logs to CloudWatch
- Read/write S3 bucket

```typescript
const lambdaRole = new aws.iam.Role("lambda-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "lambda.amazonaws.com"   // only Lambda can use this role
    }),
});
```

---

## 🔐 Step 3 — Credentials & Configuration

Instead of the interactive `aws configure` command, we used a `.env` file:

```bash
# .env  (never commit this to Git!)
AWS_ACCESS_KEY_ID=your-key-here
AWS_SECRET_ACCESS_KEY=your-secret-here
AWS_DEFAULT_REGION=ap-south-1
AWS_REGION=ap-south-1
PULUMI_CONFIG_PASSPHRASE=MySecretPassphrase123
```

The `deploy.sh` script **sources** this file automatically:
```bash
set -a
source .env   # loads all vars into environment
set +a
```

This means **zero interactive prompts** — fully automated deployment.

---

## 🚀 Step 4 — Deployment

### The `deploy.sh` script does everything automatically:

```bash
bash deploy.sh
```

**What it does step by step:**
1. ✅ Load `.env` and validate credentials
2. ✅ Add Pulumi to `$PATH`
3. ✅ Install Node.js dependencies (`npm install`)
4. ✅ Login to Pulumi local state (`pulumi login --local`)
5. ✅ Create or select the `dev` stack
6. ✅ Set config (region, environment)
7. ✅ Run `pulumi up --yes` (deploy everything)
8. ✅ Print all output URLs

---

## 🐛 Step 5 — Issues We Fixed

### Issue 1 — Pulumi Not Installed
**Error:** `pulumi: command not found`
**Fix:** `curl -fsSL https://get.pulumi.com | sh` — installed Pulumi v3.244.0

---

### Issue 2 — EC2 Volume Too Small
**Error:**
```
InvalidBlockDeviceMapping: Volume of size 20GB is smaller than snapshot
'snap-0ec3fbee2773bece4', expect size >= 30GB
```
**Cause:** Amazon Linux 2023 AMI in `ap-south-1` requires **minimum 30GB** disk.

**Fix in `index.ts`:**
```typescript
// Before ❌
volumeSize: 20,

// After ✅
volumeSize: 30,   // AL2023 in ap-south-1 requires >= 30GB
```

---

### Issue 3 — Passphrase Mismatch
**Error:** `error: incorrect passphrase`
**Cause:** Pulumi stores an encrypted salt when the stack is first created. Changing the passphrase after creation causes a mismatch.

**Fix:** Restored the original passphrase `MySecretPassphrase123` (the one used at stack init) and passed it explicitly:
```bash
PULUMI_CONFIG_PASSPHRASE=MySecretPassphrase123 pulumi up --yes
```

---

## ✅ Step 6 — Live Results

### EC2 Instance
- **URL:** http://13.203.202.84:3000
- **Instance ID:** `i-09feba8a2c10610eb`
- **Status:** Running (3/3 checks passed)
- **Type:** t3.micro in ap-south-1b

### Lambda Functions
- **processor-lambda URL:** `https://mvplwqo76cksl5nmcuvxunmttm0zyfsg.lambda-url.ap-south-1.on.aws/`
- **scheduler-lambda:** Runs every 5 minutes automatically
- **Runtime:** Node.js 20.x

### S3 Bucket
- **Name:** `demo-s3-bucket-baa3c7c`
- **Region:** ap-south-1 (Mumbai)
- **Sample file:** `uploads/hello.json`

---

## 🧪 Testing Commands

```bash
# ── EC2 Tests ──────────────────────────────────────────────
curl http://13.203.202.84:3000
curl http://13.203.202.84/health

# ── Lambda 1: List S3 objects ──────────────────────────────
curl "https://mvplwqo76cksl5nmcuvxunmttm0zyfsg.lambda-url.ap-south-1.on.aws/?action=list"

# ── Lambda 1: Upload to S3 ─────────────────────────────────
curl -X POST \
  "https://mvplwqo76cksl5nmcuvxunmttm0zyfsg.lambda-url.ap-south-1.on.aws/?action=upload" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-test","value":42}'

# ── Invoke Lambda 2 manually ───────────────────────────────
export PATH="$HOME/.pulumi/bin:$PATH"
aws lambda invoke \
  --function-name scheduler-lambda \
  --payload '{}' \
  --cli-binary-format raw-in-base64-out \
  --region ap-south-1 \
  response.json && cat response.json

# ── Check CloudWatch Logs ──────────────────────────────────
aws logs tail /aws/lambda/processor-lambda --follow --region ap-south-1
aws logs tail /aws/lambda/scheduler-lambda --follow --region ap-south-1

# ── View all Pulumi outputs ────────────────────────────────
export PATH="$HOME/.pulumi/bin:$PATH" && source .env
PULUMI_CONFIG_PASSPHRASE=MySecretPassphrase123 pulumi stack output
```

---

## 🗑️ Tear Down (Delete Everything)

When you want to delete all AWS resources:

```bash
cd /home/htadmin/Desktop/AWS/IaC
export PATH="$HOME/.pulumi/bin:$PATH" && source .env
PULUMI_CONFIG_PASSPHRASE=MySecretPassphrase123 pulumi destroy --yes
```

This deletes **all 25 resources** from AWS in one command.

> [!WARNING]
> Running `pulumi destroy` will **permanently delete** the EC2 instance, S3 bucket (and all files in it), Lambda functions, and all other resources. Make sure to back up any important data first.

---

## 📚 Key Concepts Learned

| Concept | What it means |
|---|---|
| **IaC** | Write code to create infrastructure instead of clicking in console |
| **Pulumi Stack** | An isolated environment (dev, staging, prod) |
| **Pulumi State** | File that tracks all created resources |
| **Lambda Layer** | Shared code package reused across multiple Lambda functions |
| **Function URL** | Direct HTTPS endpoint for Lambda — no API Gateway needed |
| **EventBridge** | AWS scheduler — triggers Lambda on a cron/rate schedule |
| **IAM Role** | Permission set that AWS services use to access other services |
| **Security Group** | Virtual firewall controlling traffic to/from EC2 |
| **User Data** | Script that runs automatically when EC2 first boots |
| **AMI** | Amazon Machine Image — the OS template for EC2 |

---

*Generated on June 3, 2026 | AWS Region: ap-south-1 (Mumbai) | Pulumi v3.244.0*
