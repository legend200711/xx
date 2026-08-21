#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  deploy-firestore-rules.sh — Shadow Nexus SOCIAL Firestore rules deploy
#
#  TARGET PROJECT : horr-a08f4  (Shadow Nexus Social)
#  WARNING        : This script deploys to Shadow Nexus SOCIAL only.
#                   For Shadow Nexus Wave, use deploy-wave.sh instead.
# ═══════════════════════════════════════════════════════════════════════════

set -e

echo "════════════════════════════════════════════════"
echo "  Shadow Nexus SOCIAL — Firestore Rules Deploy"
echo "  TARGET PROJECT: horr-a08f4"
echo "  DO NOT use this for Shadow Nexus Wave!"
echo "  For Wave: ./deploy-wave.sh rules"
echo "════════════════════════════════════════════════"
echo ""

# Check firebase CLI
if ! command -v firebase &>/dev/null; then
  echo "ERROR: firebase CLI not found. Install with: npm install -g firebase-tools"
  exit 1
fi

# Explicit project verification
echo "Verifying target project is horr-a08f4 (Shadow Nexus Social)..."
echo ""

echo "Deploying Firestore security rules..."
firebase deploy --only firestore:rules --project horr-a08f4

echo ""
echo "Deploying Firestore indexes..."
firebase deploy --only firestore:indexes --project horr-a08f4

echo ""
echo "Deploying updated hosting files..."
firebase deploy --only hosting --project horr-a08f4

echo ""
echo "=== DONE ==="
echo "The following change is now live:"
echo "  - Removed sign_in_provider check from videos create rule"
echo "  - Videos can now be published by any signed-in user who owns the doc"
echo ""
echo "Test: go to sfl-upload.html and click 'Retry Publishing' on the"
echo "already-uploaded video, or upload a new one."
