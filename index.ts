import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const cfg = new pulumi.Config();
const env = cfg.get("environment") || "dev";
const projectTag = { Project: "integrated-aws-system", Environment: env };

// ─────────────────────────────────────────────
// 1. VPC / NETWORKING
// ─────────────────────────────────────────────
const defaultVpc = aws.ec2.getVpc({ default: true });
const defaultSubnets = defaultVpc.then(vpc =>
    aws.ec2.getSubnets({ filters: [{ name: "vpc-id", values: [vpc.id] }] })
);

// Elastic IP for persistent address (declared early to avoid circular deps)
const eip = new aws.ec2.Eip("web-app-eip", {
    vpc: true,
    tags: { ...projectTag, Name: "web-app-eip" },
});

// Security Group for EC2 (Allow SSH and Web)
const ec2Sg = new aws.ec2.SecurityGroup("web-app-sg", {
    description: "Allow SSH and HTTP access",
    vpcId: defaultVpc.then(v => v.id),
    ingress: [
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 3000, toPort: 3000, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    tags: { ...projectTag, Name: "web-app-sg" },
});

// ─────────────────────────────────────────────
// 2. S3 BUCKET (With CORS for Direct Uploads)
// ─────────────────────────────────────────────
const s3Bucket = new aws.s3.BucketV2("integrated-project-uploads", {
    tags: { ...projectTag, Name: "integrated-project-uploads" },
});

// Enable CORS for direct uploads from React
new aws.s3.BucketCorsConfigurationV2("bucket-cors", {
    bucket: s3Bucket.id,
    corsRules: [{
        allowedHeaders: ["*"],
        allowedMethods: ["PUT", "POST", "GET"],
        allowedOrigins: ["*"], // In production, restrict this to EC2 IP
        maxAgeSeconds: 3000,
    }],
});

// Block public access (we use pre-signed URLs)
new aws.s3.BucketPublicAccessBlock("bucket-pab", {
    bucket: s3Bucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
});

// ─────────────────────────────────────────────
// 3. IAM ROLES
// ─────────────────────────────────────────────

// EC2 Role (Allow S3 Access)
const ec2Role = new aws.iam.Role("ec2-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
});

new aws.iam.RolePolicyAttachment("ec2-s3-access", {
    role: ec2Role.name,
    policyArn: aws.iam.ManagedPolicy.AmazonS3FullAccess,
});

new aws.iam.RolePolicyAttachment("ec2-ssm-access", {
    role: ec2Role.name,
    policyArn: aws.iam.ManagedPolicy.AmazonSSMManagedInstanceCore,
});

const ec2InstanceProfile = new aws.iam.InstanceProfile("ec2-profile", {
    role: ec2Role.name,
});

// Lambda Role
const lambdaRole = new aws.iam.Role("lambda-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

new aws.iam.RolePolicyAttachment("lambda-basic", {
    role: lambdaRole.name,
    policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
});

new aws.iam.RolePolicyAttachment("lambda-s3", {
    role: lambdaRole.name,
    policyArn: aws.iam.ManagedPolicy.AmazonS3ReadOnlyAccess,
});

// ─────────────────────────────────────────────
// 4. LAMBDA FUNCTION (S3 Triggered)
// ─────────────────────────────────────────────
const lambdaFn = new aws.lambda.Function("thank-you-lambda", {
    runtime: aws.lambda.Runtime.NodeJS20dX,
    handler: "index.handler",
    role: lambdaRole.arn,
    code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(`
exports.handler = async (event) => {
    console.log("Lambda triggered by S3 event!");
    for (const record of event.Records) {
        const bucket = record.s3.bucket.name;
        const key = record.s3.object.key;
        console.log(\`THANK YOU for uploading \${key} to \${bucket}! 🚀\`);
    }
    return { statusCode: 200, body: "Thank you message logged." };
};
`),
    }),
    tags: projectTag,
});

// S3 Permission to trigger Lambda
new aws.lambda.Permission("s3-permission", {
    action: "lambda:InvokeFunction",
    function: lambdaFn.name,
    principal: "s3.amazonaws.com",
    sourceArn: s3Bucket.arn,
});

// Bucket Notification
new aws.s3.BucketNotification("bucket-notification", {
    bucket: s3Bucket.id,
    lambdaFunctions: [{
        lambdaFunctionArn: lambdaFn.arn,
        events: ["s3:ObjectCreated:*"],
    }],
}, { dependsOn: [lambdaFn] });

// ─────────────────────────────────────────────
// 3.5. AWS COGNITO (Authentication)
// ─────────────────────────────────────────────
const userPool = new aws.cognito.UserPool("user-pool", {
    name: "cloud-app-user-pool",
    passwordPolicy: {
        minimumLength: 8,
        requireLowercase: true,
        requireNumbers: true,
        requireSymbols: true,
        requireUppercase: true,
    },
    autoVerifiedAttributes: ["email"],
});

const userPoolDomain = new aws.cognito.UserPoolDomain("user-pool-domain", {
    domain: pulumi.interpolate`cloud-app-${pulumi.getStack()}`,
    userPoolId: userPool.id,
});

const userPoolClient = new aws.cognito.UserPoolClient("user-pool-client", {
    userPoolId: userPool.id,
    generateSecret: false,
    allowedOauthFlows: ["code", "implicit"],
    allowedOauthFlowsUserPoolClient: true,
    allowedOauthScopes: ["phone", "email", "openid", "profile", "aws.cognito.signin.user.admin"],
    callbackUrls: [
        "http://localhost:5173",
        pulumi.interpolate`https://${eip.publicIp}`,
    ],
    logoutUrls: [
        "http://localhost:5173",
        pulumi.interpolate`https://${eip.publicIp}`,
    ],
    idTokenValidity: 60,
    accessTokenValidity: 60,
    refreshTokenValidity: 30,
    tokenValidityUnits: {
        idToken: "minutes",
        accessToken: "minutes",
        refreshToken: "days",
    },
    supportedIdentityProviders: ["COGNITO", "Google"],
});

// ─────────────────────────────────────────────
// 5. EC2 INSTANCE (The Web App)
// ─────────────────────────────────────────────

const al2023Ami = aws.ec2.getAmi({
    mostRecent: true,
    owners: ["amazon"],
    filters: [
        { name: "name", values: ["al2023-ami-*-x86_64"] },
    ],
});

const userData = pulumi.all([
    s3Bucket.bucket, 
    aws.getRegionOutput().name,
    userPool.id,
    userPoolClient.id,
    userPoolDomain.domain
]).apply(([bucketName, awsRegion, upId, clientId, domain]) => `#!/bin/bash
set -e
yum update -y
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
yum install -y nodejs git

# Setup Swap space for t3.micro
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Setup App
PROJECT_ROOT=/home/ec2-user/project
mkdir -p $PROJECT_ROOT
cd $PROJECT_ROOT

yum install -y unzip

# Download and Unzip App
aws s3 cp s3://${bucketName}/deploy/app.zip .
unzip -o app.zip

# Setup Nginx with HTTPS
yum install -y nginx
mkdir -p /etc/nginx/ssl
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/nginx.key \
  -out /etc/nginx/ssl/nginx.crt \
  -subj "/C=US/ST=State/L=City/O=Organization/OU=Unit/CN=${awsRegion}"

cat > /etc/nginx/conf.d/default.conf << EOF
server {
    listen 80;
    server_name _;
    return 301 https://\\$host\\$request_uri;
}

server {
    listen 443 ssl;
    server_name _;

    ssl_certificate /etc/nginx/ssl/nginx.crt;
    ssl_certificate_key /etc/nginx/ssl/nginx.key;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \\$host;
        proxy_cache_bypass \\$http_upgrade;
    }
}
EOF

systemctl enable nginx
systemctl start nginx

# The zip contains src/backend and src/frontend/dist
cd src/frontend/dist
cat > config.js << EOF
window.config = {
    COGNITO_USER_POOL_ID: "${upId}",
    COGNITO_CLIENT_ID: "${clientId}",
    COGNITO_DOMAIN: "${domain}.auth.${awsRegion}.amazoncognito.com",
    AWS_REGION: "${awsRegion}"
};
EOF

cd $PROJECT_ROOT/src/backend
npm install

# Create a permanent .env file for persistence
cat > .env << EOF
S3_BUCKET_NAME=${bucketName}
AWS_REGION=${awsRegion}
COGNITO_USER_POOL_ID=${upId}
COGNITO_CLIENT_ID=${clientId}
COGNITO_DOMAIN=${domain}.auth.${awsRegion}.amazoncognito.com
PORT=3000
EOF

npm install -g pm2
# Use pm2 to start the app and save the process list
pm2 start index.js --name "cloud-app"
pm2 save
# Enable pm2 to start on system boot
pm2 startup | tail -n 1 | bash
`);

const ec2Instance = new aws.ec2.Instance("web-app-instance", {
    ami: al2023Ami.then(a => a.id),
    instanceType: "t3.micro",
    subnetId: defaultSubnets.then(s => s.ids[0]),
    vpcSecurityGroupIds: [ec2Sg.id],
    iamInstanceProfile: ec2InstanceProfile.name,
    associatePublicIpAddress: true,
    userData: userData,
    rootBlockDevice: {
        volumeSize: 30,
        volumeType: "gp3",
    },
    tags: { ...projectTag, Name: "web-app-instance" },
});

// Link the Elastic IP to the instance
new aws.ec2.EipAssociation("eip-assoc", {
    instanceId: ec2Instance.id,
    allocationId: eip.id,
});


// ─────────────────────────────────────────────
// OUTPUTS
// ─────────────────────────────────────────────
export const appUrl = pulumi.interpolate`https://${eip.publicIp}`;
export const bucketName = s3Bucket.bucket;
export const lambdaName = lambdaFn.name;
