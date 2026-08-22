#!/bin/bash
# Shadow Nexus Wave — Deploy Firestore rules fix
# Run this once to apply the publishing permission fix.
#
# Usage:
#   chmod +x deploy-firestore-rules.sh
#   ./deploy-firestore-rules.sh

set -e

echo "=== Shadow Nexus Wave — Deploying Firestore rules + indexes ==="
echo ""

# Check firebase CLI
if ! command -v firebase &>/dev/null; then
  echo "ERROR: firebase CLI not found. Install with: npm install -g firebase-tools"
  exit 1
fi

# Check login status
echo "Checking Firebase authentication..."
firebase projects:list --json &>/dev/null || {
  echo "Not logged in. Running firebase login..."
  firebase login
}

echo ""
echo "Deploying Firestore security rules..."
firebase deploy --only firestore:rules --project horr-a08f4

echo ""
echo "Deploying Firestore indexes..."
firebase deploy --only firestore:indexes --project horr-a08f4

echo ""
echo "Deploying updated hosting files (sfl-upload.html etc.)..."
firebase deploy --only hosting --project horr-a08f4

echo ""
echo "=== DONE ==="
echo "The following change is now live:"
echo "  - Removed sign_in_provider check from videos create rule"
echo "  - Videos can now be published by any signed-in user who owns the doc"
echo ""
echo "Test: go to sfl-upload.html and click 'Retry Publishing' on the"
echo "already-uploaded video, or upload a new one."
