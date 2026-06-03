# Integrated AWS Cloud Uploader (React + Node.js + Pulumi)

A high-performance, secure web application that bridges a React frontend with AWS S3 and Lambda, protected by AWS Cognito and featuring Google Social Login.

## 🏗️ Architecture Overview

-   **Frontend**: React (Vite) served from Nginx via HTTPS on a `t3.micro` EC2.
-   **Backend**: Node.js Express server acting as a secure gateway for S3 pre-signed URLs.
-   **Security**: 
    -   **Nginx Proxy**: SSL termination with self-signed cert for Cognito compatibility.
    -   **AWS Cognito**: User Pool & Client managing authentication.
    -   **JWT Verification**: Backend verifies Cognito tokens before allowing uploads.
-   **Storage**: S3 Bucket with restricted public access and CORS configured for direct browser uploads.
-   **Automation**: AWS Lambda triggered instantly on S3 object creation.

---

## 🧠 Technical Deep Dive: How the Code Works

This project uses **Infrastructure as Code (IaC)** to automate the entire lifecycle of a secure cloud application.

### 1. The Deployment Engine (`index.ts`)
The core of the project is written in Pulumi (TypeScript). Instead of manual AWS setup, the code defines the "Final State" of the system.
*   **Sequential Logic**: Pulumi handles the complex order of operations (e.g., creating the S3 bucket *before* creating the Lambda trigger that needs its ARN).
*   **Interpolation**: Values like the `bucketName` and `userPoolId` are dynamically injected into the server settings at runtime.

### 2. EC2 Provisioning & "Self-Healing"
Instead of a pre-configured AMI, we use a raw Amazon Linux 2023 image and a **User Data script**:
*   **Resource Management**: On a `t3.micro` (1GB RAM), `npm install` and SSL processing can cause crashes. Our code automatically creates a **2GB Swap file** to ensure stability.
*   **SSL/TLS (HTTPS)**: The code generates a self-signed certificate and configures **Nginx** as a reverse proxy. This allows Cognito's strict HTTPS requirements to be met without needing a paid domain.
*   **PM2 Process Management**: The backend is started using PM2, which monitors the Node.js process and automatically restarts it if it crashes.

### 3. The S3-to-Lambda Bridge
*   **Direct-to-S3 Uploads**: The frontend doesn't send files to the EC2. Instead, the backend generates a **Pre-signed URL**. This offloads the heavy data transfer from your small EC2 directly to AWS S3, improving performance.
*   **Event-Driven Trigger**: The S3 notification system is configured to send a JSON event to Lambda. This happens in under <50ms after the file upload is complete.

### 4. Authentication Flow (Cognito + Google)
*   **Direct Login**: We configured the frontend (`App.jsx`) to use `signInWithRedirect({ provider: 'Google' })`. This bypasses the default Cognito login screen to provide a "Premium" Google-first experience.
*   **Token Verification**: For security, the backend (`index.js`) uses `aws-jwt-verify`. Every request for an upload URL must include a `Bearer token` in the header, which is validated against the Cognito User Pool keys.

---

## 🚀 Commands & Deployment

### 1. Fresh Deployment (From Scratch)
If you are setting this up for the first time:
```bash
# Install root dependencies
npm install

# Build the frontend locally
cd src/frontend && npm install && npm run build && cd ../..

# Create the initial deployment package
zip -r app.zip src/frontend/dist src/backend -x "**/node_modules/*"

# Set Pulumi passphrase
export PULUMI_CONFIG_PASSPHRASE=your_passphrase_here

# Deploy infrastructure
pulumi up --yes
```

### 2. Updating the Application
When you make changes to the code and want to deploy the latest version:
```bash
# 1. Build and Zip
cd src/frontend && npm run build && cd ../..
zip -r app.zip src/frontend/dist src/backend -x "**/node_modules/*"

# 2. Upload to S3
aws s3 cp app.zip s3://$(pulumi stack output bucketName)/deploy/app.zip

# 3. Replace the EC2 instance to pull new code
pulumi up --replace 'urn:pulumi:dev::aws-infra-demo::aws:ec2/instance:Instance::web-app-instance' --yes
```

---

## 🔐 Cognito & Google Integration

### Manual AWS Dashboard Steps:
Because Google Secrets are sensitive, they must be added manually in the AWS Console:

1.  **Add Google Identity Provider**:
    -   Cognito → User Pools → `cloud-app-user-pool` → **Sign-in experience**.
    -   Click **Add identity provider** → Select **Google**.
    -   Paste your **Google Client ID** and **Client Secret**.
    -   Scopes: `profile email openid`.

2.  **Enable Google on App Client**:
    -   Go to **App integration** → **App clients** → `user-pool-client`.
    -   Edit **Identity providers** → Check the **Google** box.

3.  **Update Callbacks**:
    -   Add `https://YOUR_EC2_IP` to the **Callback URLs** and **Sign-out URLs** in the App Client settings.
    -   **Note**: Cognito REQUIRES `https` for IP addresses.

---

## 📦 Component Details

### EC2 (Web Server)
-   **Instance Type**: `t3.micro` (Amazon Linux 2023).
-   **RAM Optimization**: Added **2GB Swap space** to prevent OOM errors.
-   **Nginx**: Reverse proxy (Port 443 -> 3000) with auto-generated self-signed certs.
-   **PM2**: Node.js process manager to ensure the backend is always running.

### S3 (Storage)
-   **CORS**: Configured to allow `PUT` requests from any origin (restricted to your IP for production).
-   **Security**: Public access blocked; interaction is via Pre-signed URLs for 1-hour windows.

### Lambda (Trigger)
-   **Runtime**: Node.js 20.x.
-   **Event**: `s3:ObjectCreated:*`.
-   **Function**: Logs a "Thank You" message and metadata to CloudWatch logs.

### Cognito (Auth)
-   **User Pool**: Managed directory for your users.
-   **Auth Flow**: OAuth 2.0 Code Grant.
-   **Verification**: Backend uses `aws-jwt-verify` to ensure only logged-in users get S3 URLs.

---

## 🪵 How to check logs
-   **Backend Logs**: SSH into EC2 and run `pm2 logs`.
-   **Lambda Logs**: CloudWatch → Log Groups → `/aws/lambda/thank-you-lambda-...`.
-   **Deployment Logs**: `/var/log/cloud-init-output.log` on the EC2 instance.
# AWS-Learning
