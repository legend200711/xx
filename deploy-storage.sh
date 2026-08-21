#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  deploy-storage.sh — Shadow Nexus SOCIAL Storage rules deploy
#
#  TARGET PROJECT : horr-a08f4  (Shadow Nexus Social)
#  WARNING        : This script deploys to Shadow Nexus SOCIAL only.
#                   For Shadow Nexus Wave storage, use deploy-wave.sh storage
# ═══════════════════════════════════════════════════════════════════════════
#
# Prerequisites:
#   gcloud CLI installed and authenticated:  gcloud auth login
#   firebase CLI installed and authenticated: firebase login
#
# Usage:
#   chmod +x deploy-storage.sh
#   ./deploy-storage.sh

set -e

PROJECT_ID="horr-a08f4"
BUCKET="horr-a08f4.firebasestorage.app"

echo "════════════════════════════════════════════════"
echo "  Shadow Nexus SOCIAL — Storage Rules Deploy"
echo "  TARGET PROJECT: $PROJECT_ID"
echo "  DO NOT use this for Shadow Nexus Wave!"
echo "  For Wave: ./deploy-wave.sh storage"
echo "════════════════════════════════════════════════"
echo ""

echo "=== Shadow Nexus Wave — Storage Deploy ==="
echo "Project : $PROJECT_ID"
echo "Bucket  : $BUCKET"
echo ""

# 1. Apply CORS configuration
echo "--- Applying CORS rules to gs://$BUCKET ---"
gcloud storage buckets update "gs://$BUCKET" --cors-file=cors.json --project="$PROJECT_ID"
echo "✓ CORS applied"

# 2. Deploy Firebase Storage security rules
echo ""
echo "--- Deploying Storage security rules ---"
firebase deploy --only storage --project "$PROJECT_ID"
echo "✓ Storage rules deployed"

echo ""
echo "=== Done ==="
echo ""
echo "NEXT STEPS:"
echo "  1. Open Chrome DevTools on Android (chrome://inspect)"
echo "  2. Go to Settings → Profile Picture"
echo "  3. Choose a small JPG (< 500 KB)"
echo "  4. Tap Save Photo"
echo "  5. Watch console for [SFL-Upload] logs"
echo "  6. Upload should complete and profile picture should update"
