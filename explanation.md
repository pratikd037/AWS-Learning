# Complete System Explanation: How Everything Works Together

This document explains the **entire system end-to-end** — from writing the code, to running `pulumi up`, to a user clicking "Sign in with Google" and uploading a file. Every single step is covered.

---

## PART 1: The Project Structure

```
IaC/
├── index.ts                  ← The "brain" — Pulumi infrastructure code
├── src/
│   ├── backend/
│   │   ├── index.js          ← Node.js Express API (runs on EC2)
│   │   └── package.json      ← Backend dependencies
│   └── frontend/
│       ├── src/
│       │   ├── App.jsx       ← React app (the UI)
│       │   └── App.css       ← Styling
│       ├── index.html        ← Entry HTML (loads config.js + React)
│       └── package.json      ← Frontend dependencies
├── .env                      ← AWS credentials + Pulumi passphrase
└── Pulumi.yaml               ← Pulumi project name & runtime config
```

---

## PART 2: The Deployment — Step by Step

### Step 1: You Run `pulumi up`

Pulumi reads `index.ts` and connects to AWS using your credentials from `.env`. It then **computes a plan** — comparing what already exists in AWS vs what the code says should exist — and creates/updates/deletes the difference.

**The order of creation is critical** (Pulumi handles this automatically):
```
1. S3 Bucket (needed before Lambda trigger and EC2 download)
2. IAM Roles (needed before EC2 and Lambda can do anything)
3. Lambda Function (needed before S3 trigger can point to it)
4. S3 Bucket Notification (points to Lambda — Lambda must exist first)
5. Cognito User Pool (needed before App Client can reference it)
6. Cognito App Client (needed before EC2 gets its Client ID)
7. EC2 Instance (last — it needs the Bucket name, Cognito IDs, etc.)
```

---

### Step 2: The ZIP File is Uploaded to S3 (YOU do this manually)

Before running `pulumi up`, you first build and package the application locally:

```bash
# 1. Build the React frontend into a static "dist" folder
cd src/frontend && npm run build && cd ../..

# 2. Package everything (excluding heavy node_modules)
zip -r app.zip src/frontend/dist src/backend -x "**/node_modules/*"

# 3. Upload the package to the S3 bucket's "deploy" folder
aws s3 cp app.zip s3://integrated-project-uploads-382d1ff/deploy/app.zip
```

**Why this approach?**
- Building React on a `t3.micro` (1GB RAM) causes **Out of Memory crashes** during `npm run build`.
- We build it on your powerful local machine and upload the **ready-to-run** `dist/` folder.
- The EC2 instance just downloads and starts — no building required on the server.

---

### Step 3: The EC2 Instance is Created

In `index.ts` (line 277), Pulumi creates a `t3.micro` EC2 with these settings:

```typescript
const ec2Instance = new aws.ec2.Instance("web-app-instance", {
    ami: al2023Ami.then(a => a.id),  // Latest Amazon Linux 2023 image
    instanceType: "t3.micro",         // 1 vCPU, 1GB RAM
    subnetId: defaultSubnets.then(s => s.ids[0]),
    vpcSecurityGroupIds: [ec2Sg.id],  // Our custom firewall rules
    iamInstanceProfile: ec2InstanceProfile.name, // Gives S3 access
    associatePublicIpAddress: true,   // Gets a public IP
    userData: userData,               // The startup script (explained next)
    rootBlockDevice: {
        volumeSize: 30,               // 30GB disk
        volumeType: "gp3",
    },
});
```

**The AMI (Amazon Machine Image)** is like a "factory reset" disk image. Pulumi automatically finds the latest `al2023-ami-*-x86_64` (Amazon Linux 2023) from Amazon's official list.

**The IAM Instance Profile** is like an "identity card" for the server. It tells AWS: *"This EC2 is allowed to read/write S3 and is managed by SSM (for remote debugging)."*

---

### Step 4: The EC2 Runs the `userData` Startup Script

This is the **most important part**. The `userData` is a bash script that runs **automatically, one time, on first boot**. It sets up the entire server without anyone SSH-ing in.

Here's what each section does:

#### 4a. Update the System & Install Node.js
```bash
set -e                          # Stop immediately if any command fails
yum update -y                   # Update all system packages
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs git       # Install Node.js version 20
```

#### 4b. Create Swap Space (Critical for t3.micro)
```bash
fallocate -l 2G /swapfile       # Reserve 2GB of disk space
chmod 600 /swapfile             # Secure the swap file
mkswap /swapfile                # Format it as swap
swapon /swapfile                # Activate it as virtual RAM
```
Without this, `npm install` (which loads thousands of tiny files) can exhaust the 1GB RAM and crash the server silently.

#### 4c. Download and Unzip the App
```bash
PROJECT_ROOT=/home/ec2-user/project
mkdir -p $PROJECT_ROOT
cd $PROJECT_ROOT
yum install -y unzip

aws s3 cp s3://${bucketName}/deploy/app.zip .   # Download from S3
unzip -o app.zip                                 # Extract over existing files
```
The `${bucketName}` is **dynamically injected** by Pulumi at deploy time — it's the real bucket name generated by AWS (e.g., `integrated-project-uploads-382d1ff`).

#### 4d. Set Up Nginx with HTTPS
```bash
yum install -y nginx
mkdir -p /etc/nginx/ssl

# Generate a self-signed SSL certificate (valid for 365 days)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/nginx.key \
  -out /etc/nginx/ssl/nginx.crt \
  -subj "/C=US/ST=State/L=City/O=Org/OU=Unit/CN=ap-south-1"
```
**Why self-signed?** AWS Cognito requires `https://` for all redirect URLs. A real certificate (from Let's Encrypt) requires a domain name. Since we use a raw IP address, we generate our own certificate. The browser shows a warning, but Cognito accepts it.

Then we write an Nginx config file:
```nginx
# Redirect all HTTP → HTTPS
server {
    listen 80;
    return 301 https://$host$request_uri;
}

# HTTPS server — receives requests and forwards to Node.js
server {
    listen 443 ssl;
    ssl_certificate /etc/nginx/ssl/nginx.crt;
    ssl_certificate_key /etc/nginx/ssl/nginx.key;

    location / {
        proxy_pass http://localhost:3000;  # Forward to Node.js
    }
}
```
**Traffic flow**: User Browser → Port 443 (Nginx) → Port 3000 (Node.js)

#### 4e. Inject Runtime Config into the Frontend
```bash
cd src/frontend/dist
cat > config.js << EOF
window.config = {
    COGNITO_USER_POOL_ID: "${upId}",          # e.g. ap-south-1_qbIypTTpa
    COGNITO_CLIENT_ID: "${clientId}",          # e.g. 6ru9te6pogse0hq5v20ubunfqa
    COGNITO_DOMAIN: "${domain}.auth.ap-south-1.amazoncognito.com",
    AWS_REGION: "ap-south-1"
};
EOF
```
**Why this trick?** The React app is a static bundle. We can't change its code after building. Instead, we inject values into `window.config` (a global JS variable) via `config.js`. The React app then reads `window.config` when it first loads.

#### 4f. Install Backend Dependencies and Start the Server
```bash
cd $PROJECT_ROOT/src/backend
npm install                     # Install express, aws-sdk, aws-jwt-verify etc.

# Set environment variables for the Node.js process
export S3_BUCKET_NAME=${bucketName}
export AWS_REGION=ap-south-1
export COGNITO_USER_POOL_ID=${upId}
export COGNITO_CLIENT_ID=${clientId}
export PORT=3000

npm install -g pm2              # Install PM2 globally
pm2 start index.js --name "cloud-app"  # Start Node.js with auto-restart
```

**PM2 (Process Manager 2)** keeps the Node.js server alive. If it crashes (e.g., memory spike), PM2 restarts it in seconds. Without PM2, one error would kill the server permanently.

---

## PART 3: The AWS Infrastructure Config

### S3 Bucket Configuration (`index.ts` lines 40-62)

```typescript
const s3Bucket = new aws.s3.BucketV2("integrated-project-uploads", {...});

// CORS — allows browsers to PUT files directly to S3
new aws.s3.BucketCorsConfigurationV2("bucket-cors", {
    bucket: s3Bucket.id,
    corsRules: [{
        allowedHeaders: ["*"],
        allowedMethods: ["PUT", "POST", "GET"],
        allowedOrigins: ["*"],   // Any domain can upload
        maxAgeSeconds: 3000,
    }],
});

// Block public access — no one can list or download without a key
new aws.s3.BucketPublicAccessBlock("bucket-pab", {
    bucket: s3Bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});
```

**CORS is critical**: Without it, browsers refuse to upload files to S3 (browsers block "cross-origin" requests by default). The CORS config tells S3: *"I allow browsers from any origin to PUT files."*

**Public Access Block**: Even though uploads are allowed via CORS, the bucket is still private. Files can only be accessed via **Pre-signed URLs** (time-limited, single-use download/upload links).

---

### IAM Roles Configuration (`index.ts` lines 68-100)

**EC2 Role** — Grants the EC2 server permission to:
- `AmazonS3FullAccess`: Download the `app.zip` from S3 on startup and generate S3 pre-signed URLs.
- `AmazonSSMManagedInstanceCore`: Connect via AWS Systems Manager (SSM) for debugging without SSH keys.

**Lambda Role** — Grants the Lambda function:
- `AWSLambdaBasicExecutionRole`: Write logs to CloudWatch.
- `AmazonS3ReadOnlyAccess`: Read the metadata of the uploaded file.

---

### Lambda Function Configuration (`index.ts` lines 104-140)

```typescript
const lambdaFn = new aws.lambda.Function("thank-you-lambda", {
    runtime: aws.lambda.Runtime.NodeJS20dX,
    handler: "index.handler",     // Calls the `handler` export in index.js
    role: lambdaRole.arn,
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
exports.handler = async (event) => {
    for (const record of event.Records) {
        const bucket = record.s3.bucket.name;
        const key = record.s3.object.key;
        console.log(\`THANK YOU for uploading \${key} to \${bucket}! 🚀\`);
    }
    return { statusCode: 200 };
};
        `),
    }),
});
```

The Lambda code is written **as a string inside the TypeScript file** and sent directly to AWS. No separate file needed.

**The trigger chain**:
```typescript
// 1. Grant S3 permission to invoke the Lambda
new aws.lambda.Permission("s3-permission", {
    action: "lambda:InvokeFunction",
    function: lambdaFn.name,
    principal: "s3.amazonaws.com",
    sourceArn: s3Bucket.arn,
});

// 2. Tell S3 to actually call the Lambda when a file is created
new aws.s3.BucketNotification("bucket-notification", {
    bucket: s3Bucket.id,
    lambdaFunctions: [{
        lambdaFunctionArn: lambdaFn.arn,
        events: ["s3:ObjectCreated:*"],   // Any new file triggers this
    }],
});
```

---

### Cognito Configuration (`index.ts` lines 145-175)

```typescript
// 1. The User Pool — like a database of users
const userPool = new aws.cognito.UserPool("user-pool", {
    name: "cloud-app-user-pool",
    passwordPolicy: {
        minimumLength: 8,
        requireLowercase: true,
        requireNumbers: true,
        requireSymbols: true,
        requireUppercase: true,
    },
    autoVerifiedAttributes: ["email"],  // Auto-verify email on signup
});

// 2. The Domain — the URL of the Cognito Hosted Login UI
// Result: cloud-app-dev.auth.ap-south-1.amazoncognito.com
const userPoolDomain = new aws.cognito.UserPoolDomain("user-pool-domain", {
    domain: `cloud-app-${pulumi.getStack()}`,  // "cloud-app-dev"
    userPoolId: userPool.id,
});

// 3. The App Client — "key" that the React app uses to talk to Cognito
const userPoolClient = new aws.cognito.UserPoolClient("user-pool-client", {
    userPoolId: userPool.id,
    generateSecret: false,                // Public client (browser app)
    allowedOauthFlows: ["code", "implicit"],
    allowedOauthFlowsUserPoolClient: true,
    allowedOauthScopes: ["phone", "email", "openid", "profile"],
    callbackUrls: ["http://localhost:5173"],  // Where to redirect after login
    logoutUrls: ["http://localhost:5173"],
    supportedIdentityProviders: ["COGNITO"], // Google added manually in console
});
```

---

## PART 4: The Security Group (Firewall)

```typescript
const ec2Sg = new aws.ec2.SecurityGroup("web-app-sg", {
    ingress: [
        { protocol: "tcp", fromPort: 22,   toPort: 22,   cidrBlocks: ["0.0.0.0/0"] }, // SSH
        { protocol: "tcp", fromPort: 80,   toPort: 80,   cidrBlocks: ["0.0.0.0/0"] }, // HTTP
        { protocol: "tcp", fromPort: 443,  toPort: 443,  cidrBlocks: ["0.0.0.0/0"] }, // HTTPS
        { protocol: "tcp", fromPort: 3000, toPort: 3000, cidrBlocks: ["0.0.0.0/0"] }, // Node.js direct
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }, // Allow all outbound
    ],
});
```

This is the EC2 firewall. Port `443` **must be open** or Nginx (HTTPS) won't be reachable from the browser.

---

## PART 5: The Backend — `src/backend/index.js`

The backend serves two purposes: **serve the frontend files** and **provide a secure upload URL API**.

### How It Serves the Frontend
```javascript
app.use(express.static(path.join(__dirname, '../frontend/dist')));
// Any request to "/" returns the React app's index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});
```
This means one Node.js server handles both the API and the React frontend.

### JWT Verification Middleware
```javascript
const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    tokenUse: "id",              // We check the "id token" (user identity)
    clientId: process.env.COGNITO_CLIENT_ID,
});

const checkAuth = async (req, res, next) => {
    const token = req.headers.authorization.split(' ')[1]; // "Bearer <token>"
    const payload = await verifier.verify(token); // Throws if invalid/expired
    req.user = payload;          // Attach user info to the request
    next();                      // Continue to the route handler
};
```
`aws-jwt-verify` downloads Cognito's public keys and uses them to cryptographically verify that the token was genuinely issued by your User Pool and hasn't been tampered with.

### Pre-signed URL Generation
```javascript
app.get('/api/upload-url', checkAuth, async (req, res) => {
    const key = `uploads/${Date.now()}-${fileName}`;  // Unique file path in S3
    const command = new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: key,
        ContentType: contentType
    });
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    // Returns a URL that is valid for 1 hour for this exact file only
    res.json({ uploadUrl, key });
});
```

---

## PART 6: The Frontend — `src/frontend/src/App.jsx`

### Runtime Config Loading
```javascript
// index.html loads /config.js first
// config.js sets window.config = { COGNITO_USER_POOL_ID: "...", ... }

if (window.config) {
    Amplify.configure({
        Auth: {
            Cognito: {
                userPoolId: window.config.COGNITO_USER_POOL_ID,
                userPoolClientId: window.config.COGNITO_CLIENT_ID,
                loginWith: {
                    oauth: {
                        domain: window.config.COGNITO_DOMAIN,
                        redirectSignIn: [window.location.origin],  // Dynamic!
                        redirectSignOut: [window.location.origin],
                        responseType: 'code'
                    }
                }
            }
        }
    });
}
```

### Direct Google Login
```javascript
// Bypasses the Cognito username/password screen entirely
<button onClick={() => signInWithRedirect({ provider: 'Google' })}>
    Sign in with Google
</button>
```
Without `{ provider: 'Google' }`, Amplify opens the Cognito login page. Adding this option tells Cognito to skip its own page and go directly to Google's OAuth screen.

### The Upload Flow
```javascript
// 1. Get the user's current session token
const session = await fetchAuthSession();
const idToken = session.tokens.idToken;

// 2. Ask the backend for a pre-signed URL (sends token for verification)
const response = await fetch('/api/upload-url?fileName=...&contentType=...', {
    headers: { 'Authorization': `Bearer ${idToken}` }
});
const { uploadUrl } = await response.json();

// 3. Upload DIRECTLY to S3 (NOT through the backend)
const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
});
```

---

## PART 7: GCP + Cognito Integration (Google Social Login)

### How OAuth Works Here

```
User clicks "Sign in with Google"
    ↓
Amplify redirects → Cognito Hosted UI
    ↓
Cognito redirects → Google OAuth (accounts.google.com)
    ↓
User selects their Google Account
    ↓
Google sends an auth code → Cognito callback URL:
    https://cloud-app-dev.auth.ap-south-1.amazoncognito.com/oauth2/idpresponse
    ↓
Cognito exchanges code for Google tokens, creates a Cognito user
    ↓
Cognito redirects back → Your App (https://YOUR_EC2_IP)
    with a Cognito ID Token in the URL
    ↓
Amplify reads the token, user is now logged in
```

### What You Configure in GCP Console
- **Authorized JavaScript origins**: `https://cloud-app-dev.auth.ap-south-1.amazoncognito.com`
  - This tells Google: *"Requests coming from this domain are trusted."*
- **Authorized redirect URIs**: `https://cloud-app-dev.auth.ap-south-1.amazoncognito.com/oauth2/idpresponse`
  - This is where Google sends the user **back to** after they approve login.

### What You Configure in AWS Cognito Console
- **Identity Provider → Google**: Paste GCP Client ID + Secret.
- **App Client → Identity Providers**: Check the Google checkbox.
- **App Client → Callback URLs**: Add `https://YOUR_EC2_IP` (Cognito needs to know your app URL to redirect back to it).

---

## PART 8: End-to-End Request Lifecycle

Here is what happens from the moment a user uploads a file:

```
1. User opens https://35.154.124.10 in browser
2. Browser connects to PORT 443 (Nginx) on the EC2
3. Nginx forwards the request to PORT 3000 (Node.js)
4. Node.js serves the React index.html from dist/
5. Browser loads index.html → loads config.js → loads the React bundle
6. React reads window.config and configures Amplify
7. Amplify checks localStorage for a saved session → User not logged in
8. UI shows "Sign in with Google" button

--- User clicks Sign in ---

9. Amplify redirects to Cognito Hosted UI with response_type=code
10. Cognito redirects to Google (because Google provider is enabled)
11. User selects their Google account
12. Google redirects to Cognito's idpresponse endpoint with an auth code
13. Cognito exchanges the code for Google tokens, creates a Cognito session
14. Cognito redirects to https://35.154.124.10 with a Cognito code
15. Amplify exchanges the code for ID Token + Access Token
16. Amplify stores tokens in localStorage
17. React calls getCurrentUser() → returns the user object
18. UI shows "Welcome, user@gmail.com" and the Upload button

--- User selects a file and clicks Upload ---

19. React calls fetchAuthSession() → gets the ID Token from localStorage
20. React sends GET /api/upload-url with Authorization: Bearer <idToken>
21. Nginx forwards to Node.js
22. Node.js middleware calls aws-jwt-verify → verifies token is genuine
23. Node.js generates a Pre-signed S3 URL (valid 1 hour, for this file only)
24. Node.js returns { uploadUrl, key } to React
25. React sends PUT directly to S3 using the pre-signed URL
26. S3 accepts the file and stores it at uploads/1736123456-filename.jpg

--- Lambda triggers ---

27. S3 fires an event: "ObjectCreated" at uploads/1736123456-filename.jpg
28. S3 calls the Lambda function with event.Records containing file metadata
29. Lambda logs: "THANK YOU for uploading uploads/1736123456-filename.jpg! 🚀"
30. Log is stored in AWS CloudWatch under /aws/lambda/thank-you-lambda-...
31. React UI shows "Success! Lambda function has been triggered."
```

---

## PART 9: Checking Logs

### Backend Logs (PM2)
Connect via SSM or SSH to the EC2 and run:
```bash
pm2 logs cloud-app          # Live log stream
pm2 logs cloud-app --lines 100  # Last 100 lines
```

### Lambda Logs (CloudWatch)
1. AWS Console → **CloudWatch** → **Log Groups**
2. Find `/aws/lambda/thank-you-lambda-742c40f`
3. Click on the latest log stream
4. You will see the "THANK YOU" messages

### EC2 Startup Log
If the server isn't starting correctly:
```bash
cat /var/log/cloud-init-output.log
```
This shows everything that happened during the `userData` script execution.
