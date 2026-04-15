#!/bin/bash
set -e

STACK_NAME="intrlock-camera-relay"
REGION="us-east-1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  Intrlock Camera Relay - AWS Deploy"
echo "============================================"
echo ""

# Check AWS CLI
if ! command -v aws &> /dev/null; then
  echo "ERROR: AWS CLI not installed"
  exit 1
fi

# Check credentials
if ! aws sts get-caller-identity --region "$REGION" &>/dev/null; then
  echo "ERROR: AWS credentials not configured"
  exit 1
fi

echo "[1/3] Deploying CloudFormation stack..."
aws cloudformation deploy \
  --template-file "$SCRIPT_DIR/cloudformation.yml" \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --no-fail-on-empty-changeset

echo "[2/3] Waiting for instance to initialize..."
sleep 10

echo "[3/3] Getting outputs..."
echo ""

OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output json)

PUBLIC_IP=$(echo "$OUTPUTS" | python3 -c "import sys,json;[print(o['OutputValue']) for o in json.load(sys.stdin) if o['OutputKey']=='PublicIP']")
WEBRTC_URL=$(echo "$OUTPUTS" | python3 -c "import sys,json;[print(o['OutputValue']) for o in json.load(sys.stdin) if o['OutputKey']=='WebRTCUrl']")
HLS_URL=$(echo "$OUTPUTS" | python3 -c "import sys,json;[print(o['OutputValue']) for o in json.load(sys.stdin) if o['OutputKey']=='HLSUrl']")
RTSP_URL=$(echo "$OUTPUTS" | python3 -c "import sys,json;[print(o['OutputValue']) for o in json.load(sys.stdin) if o['OutputKey']=='RTSPUrl']")

echo "============================================"
echo "  Relay Deployed!"
echo "============================================"
echo ""
echo "  Public IP:  $PUBLIC_IP"
echo "  WebRTC:     $WEBRTC_URL"
echo "  HLS:        $HLS_URL"
echo "  RTSP:       $RTSP_URL"
echo ""
echo "  On the Pi, run:"
echo "  sudo nano /opt/intrlock-bridge/config.json"
echo "  Add: \"relay_host\": \"$PUBLIC_IP\""
echo "  Then: sudo systemctl restart intrlock-bridge"
echo ""
echo "  Note: Allow ~60s for EC2 UserData to finish installing MediaMTX"
echo ""
