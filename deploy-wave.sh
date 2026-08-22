#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
#  deploy-wave.sh — Shadow Nexus Wave deployment script
#
#  TARGET PROJECT:  shadow-nexus-wave
#  DO NOT TOUCH:    horr-a08f4  (Shadow Nexus Social — PRODUCTION)
# ═══════════════════════════════════════════════════════════════════════════
#
# Usage:
#   chmod +x deploy-wave.sh
#   ./deploy-wave.sh              # deploy everything to Wave project
#   ./deploy-wave.sh rules        # deploy only Firestore rules
#   ./deploy-wave.sh indexes      # deploy only Firestore indexes
#   ./deploy-wave.sh storage      # deploy only Storage rules
#   ./deploy-wave.sh hosting      # deploy only hosting files
#   ./deploy-wave.sh verify       # print project info without deploying

set -e

# ── HARD-CODED TARGET — NEVER CHANGE THIS ────────────────────────────────────
WAVE_PROJECT="shadow-nexus-wave"
SOCIAL_PROJECT="horr-a08f4"
WAVE_CONFIG="firebase-wave.json"

# ── Safety check function ─────────────────────────────────────────────────────
check_project() {
  echo ""
  echo "════════════════════════════════════════════════"
  echo "  🌊 Shadow Nexus Wave — Deployment Script"
  echo "════════════════════════════════════════════════"
  echo "  TARGET PROJECT : $WAVE_PROJECT"
  echo "  SOCIAL PROJECT : $SOCIAL_PROJECT (DO NOT TOUCH)"
  echo "  CONFIG FILE    : $WAVE_CONFIG"
  echo "════════════════════════════════════════════════"
  echo ""

  # Verify firebase CLI is available
  if ! command -v firebase &>/dev/null; then
    echo "ERROR: firebase CLI not found."
    echo "Install with: npm install -g firebase-tools"
    exit 1
  fi

  # Verify the target project exists and is accessible
  echo "Verifying project access to $WAVE_PROJECT..."
  if ! firebase projects:list --json 2>/dev/null | grep -q "\"$WAVE_PROJECT\""; then
    echo "ERROR: Cannot access project $WAVE_PROJECT."
    echo "Make sure you are logged in: firebase login"
    exit 1
  fi

  # SAFETY: refuse to deploy if the current default project is Social
  local current
  current=$(firebase use 2>&1 | grep "Active Project" | awk '{print $NF}' || echo "")
  if [[ "$current" == "$SOCIAL_PROJECT" ]]; then
    echo "⛔  SAFETY STOP: Current default project is $SOCIAL_PROJECT (Shadow Nexus Social)."
    echo "    Switching to Wave project for this deployment..."
  fi

  echo "✅  Project check passed. Deploying to: $WAVE_PROJECT"
  echo ""
}

# ── Deployment functions ──────────────────────────────────────────────────────

deploy_database_rules() {
  echo "--- Deploying Realtime Database rules → $WAVE_PROJECT ---"
  firebase deploy --only database \
    --project "$WAVE_PROJECT" \
    --config "$WAVE_CONFIG"
  echo "✅  RTDB rules deployed to $WAVE_PROJECT"
}

deploy_firestore_rules() {
  echo "--- Deploying Firestore security rules → $WAVE_PROJECT ---"
  firebase deploy --only firestore:rules \
    --project "$WAVE_PROJECT" \
    --config "$WAVE_CONFIG"
  echo "✅  Firestore rules deployed to $WAVE_PROJECT"
}

deploy_firestore_indexes() {
  echo "--- Deploying Firestore indexes → $WAVE_PROJECT ---"
  firebase deploy --only firestore:indexes \
    --project "$WAVE_PROJECT" \
    --config "$WAVE_CONFIG"
  echo "✅  Firestore indexes deployed to $WAVE_PROJECT"
}

deploy_storage_rules() {
  echo "--- Deploying Storage security rules → $WAVE_PROJECT ---"
  firebase deploy --only storage \
    --project "$WAVE_PROJECT" \
    --config "$WAVE_CONFIG"
  echo "✅  Storage rules deployed to $WAVE_PROJECT"
}

deploy_hosting() {
  echo "--- Deploying hosting → $WAVE_PROJECT ---"
  firebase deploy --only hosting \
    --project "$WAVE_PROJECT" \
    --config "$WAVE_CONFIG"
  echo "✅  Hosting deployed to $WAVE_PROJECT"
}

# ── Main ──────────────────────────────────────────────────────────────────────

MODE="${1:-all}"

check_project

case "$MODE" in
  verify)
    echo "Verification complete. No deployment performed."
    ;;
  rules)
    deploy_firestore_rules
    ;;
  indexes)
    deploy_firestore_indexes
    ;;
  storage)
    deploy_storage_rules
    ;;
  hosting)
    deploy_hosting
    ;;
  database)
    deploy_database_rules
    ;;
  all)
    echo "=== Deploying all Wave resources ==="
    deploy_database_rules
    echo ""
    deploy_firestore_rules
    echo ""
    deploy_firestore_indexes
    echo ""
    deploy_storage_rules
    echo ""
    deploy_hosting
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo "Valid modes: verify | database | rules | indexes | storage | hosting | all"
    exit 1
    ;;
esac

echo ""
echo "════════════════════════════════════════════════"
echo "  ✅  Shadow Nexus Wave deployment complete"
echo "  Project: $WAVE_PROJECT"
echo "  Shadow Nexus Social ($SOCIAL_PROJECT): UNTOUCHED"
echo "════════════════════════════════════════════════"
echo ""
