# AWS Bedrock Integration Guide (Node.js on EC2)

This project already has:
- A **React** frontend (static `dist/`) served by the Node.js backend
- A **Node.js Express** backend running on EC2 (started by `pm2`)
- An **EC2 IAM role** (in `IaC/index.ts`) that grants the instance AWS permissions
- A **Cognito-authenticated API pattern** (see `checkAuth` in `IaC/src/backend/index.js`)

This guide shows how to add **AWS Bedrock** so your backend can call a foundation model securely.

---

## Goal / Recommended Architecture

- **Do not call Bedrock directly from the browser.**
  - You’d have to expose AWS credentials or mint temporary creds client-side.
  - You’d also lose server-side control over prompt injection, rate limiting, logging, and model choice.

- **Call Bedrock from the backend (EC2) using the instance IAM role.**
  - Your EC2 already has an IAM role via `ec2InstanceProfile`.
  - Add least-privilege Bedrock permissions to that role.

Request flow:

1. React app authenticates user with Cognito.
2. React sends request to your backend with `Authorization: Bearer <idToken>`.
3. Backend verifies token (existing `checkAuth`).
4. Backend calls Bedrock using AWS SDK and returns the response.

---

## Step 1 — Enable a Bedrock model (console)

In the AWS Console:
- Go to **Amazon Bedrock** → **Model access**
- Request access for the model(s) you want to use (varies by account/region)

Important:
- Bedrock model availability depends on **region**.
- Your project already sets `AWS_REGION` on the instance; Bedrock calls must use a region that supports the chosen model.

---

## Step 2 — Add IAM permissions to the EC2 role (Pulumi)

Your EC2 role is defined here:
- `IaC/index.ts` → `const ec2Role = new aws.iam.Role("ec2-role", ...)`

Add an inline policy (recommended) granting only Bedrock invocation actions.

### Minimal policy (invoke only)

Add a policy similar to:

```ts
new aws.iam.RolePolicy("ec2-bedrock-invoke", {
  role: ec2Role.id,
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream"
        ],
        Resource: "*"
      }
    ]
  })
});
```

Notes:
- You *can* restrict `Resource` to specific model ARNs, but the ARN format differs across model types and regions; start with `*` for correctness, then tighten later.
- If you later add embeddings, tool use, agents, or knowledge bases, additional permissions may be required.

Deploy:
- Run `pulumi up` after adding the policy.

---

## Step 3 — Add the AWS SDK client for Bedrock runtime

Your backend uses AWS SDK v3 already (`@aws-sdk/client-s3`).
For Bedrock text generation, install the Bedrock Runtime client in:
- `IaC/src/backend/`

Install:

```bash
cd IaC/src/backend
npm install @aws-sdk/client-bedrock-runtime
```

Then re-zip and redeploy the app package (same flow as your existing deployment docs).

---

## Step 4 — Add an authenticated Bedrock endpoint to the backend

File:
- `IaC/src/backend/index.js`

### Example: simple text generation endpoint

This uses the **Bedrock Runtime** API. The exact request body depends on the model provider.

#### Option A: Anthropic Claude (common)

```js
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const bedrock = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
});

app.post("/api/bedrock/claude", checkAuth, async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const modelId = process.env.BEDROCK_MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";

    const body = JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const out = await bedrock.send(new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body,
    }));

    const json = JSON.parse(Buffer.from(out.body).toString("utf8"));
    // Claude returns content as an array; common shape: [{type:"text", text:"..."}]
    const text = json?.content?.map(c => c.text).join("") ?? json;
    res.json({ modelId, text, raw: json });
  } catch (err) {
    console.error("Bedrock invoke failed:", err);
    res.status(500).json({ error: "Bedrock invoke failed" });
  }
});
```

#### Option B: Amazon Titan Text (example)

```js
app.post("/api/bedrock/titan", checkAuth, async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const modelId = process.env.BEDROCK_MODEL_ID || "amazon.titan-text-express-v1";

    const body = JSON.stringify({
      inputText: prompt,
      textGenerationConfig: {
        maxTokenCount: 512,
        temperature: 0.7,
        topP: 0.9
      }
    });

    const out = await bedrock.send(new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body,
    }));

    const json = JSON.parse(Buffer.from(out.body).toString("utf8"));
    res.json({ modelId, raw: json });
  } catch (err) {
    console.error("Bedrock invoke failed:", err);
    res.status(500).json({ error: "Bedrock invoke failed" });
  }
});
```

---

## Step 5 — Provide runtime config (env vars)

Recommended environment variables (on the EC2 instance):
- `AWS_REGION`: already created by your `userData`
- `BEDROCK_MODEL_ID`: model id string (optional, but recommended)

Where to set them:
- Your EC2 `userData` currently writes a backend `.env` at boot:
  - `IaC/index.ts` → userData section creating `src/backend/.env`

Add:

```bash
BEDROCK_MODEL_ID=anthropic.claude-3-haiku-20240307-v1:0
```

Then redeploy / replace the instance so it picks up the new `.env`.

---

## Step 6 — Call the endpoint from the frontend

The frontend already sends the Cognito ID token to your backend for `/api/upload-url`.
Use the same approach for Bedrock:

```js
const response = await fetch("/api/bedrock/claude", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${idToken}`,
  },
  body: JSON.stringify({ prompt: "Write a short welcome message." }),
});
const data = await response.json();
console.log(data.text);
```

---

## Operational notes (production hardening)

- **Timeouts**: Bedrock calls can take seconds. Set appropriate timeouts client-side and server-side.
- **Rate limiting**: Add per-user limits (API gateway, reverse-proxy, or app-level).
- **Prompt safety**: Treat user input as untrusted; consider moderation or policy checks.
- **Logging**: Avoid logging full prompts/responses if they can contain sensitive data.
- **Costs**: Bedrock is usage-based; add guardrails (max tokens, model choice).

