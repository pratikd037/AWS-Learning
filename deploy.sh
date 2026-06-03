#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  deploy.sh  —  One-command setup + deploy
#  Usage: bash deploy.sh
# ─────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. Load .env ─────────────────────────────────────────────
ENV_FILE="$SCRIPT_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "❌  .env file not found at $ENV_FILE"
  echo "    Copy .env.example to .env and fill in your credentials."
  exit 1
fi

echo "📦  Loading environment from .env ..."
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Validate required vars
for VAR in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION PULUMI_CONFIG_PASSPHRASE; do
  if [ -z "${!VAR}" ] || [[ "${!VAR}" == *"YOUR_"* ]]; then
    echo "❌  $VAR is not set in .env — please fill it in."
    exit 1
  fi
done

echo "✅  Region : $AWS_DEFAULT_REGION"
echo "✅  Key ID : ${AWS_ACCESS_KEY_ID:0:8}****************"

# ── 2. Add Pulumi to PATH ────────────────────────────────────
export PATH="$HOME/.pulumi/bin:$PATH"

if ! command -v pulumi &> /dev/null; then
  echo "⬇️   Pulumi not found — installing ..."
  curl -fsSL https://get.pulumi.com | sh
  export PATH="$HOME/.pulumi/bin:$PATH"
fi

echo "🔧  Pulumi version: $(pulumi version)"

# ── 3. Install Node deps ─────────────────────────────────────
echo "📦  Installing Node.js dependencies ..."
npm install

# ── 4. Pulumi login (local state) ────────────────────────────
echo "🔐  Logging in to Pulumi (local state) ..."
pulumi login --local

# ── 5. Create / select stack ─────────────────────────────────
STACK="dev"
if ! pulumi stack ls 2>/dev/null | grep -q "$STACK"; then
  echo "📚  Creating stack '$STACK' ..."
  pulumi stack init $STACK
else
  echo "📚  Selecting existing stack '$STACK' ..."
  pulumi stack select $STACK
fi

# ── 6. Set stack config from .env ────────────────────────────
pulumi config set aws:region "$AWS_DEFAULT_REGION"
pulumi config set aws-infra-demo:environment "dev"

# ── 7. Deploy ────────────────────────────────────────────────
echo ""
echo "🚀  Starting deployment ..."
echo "─────────────────────────────────────────────"
pulumi up --yes

# ── 8. Show outputs ──────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "📋  Stack Outputs:"
pulumi stack output
