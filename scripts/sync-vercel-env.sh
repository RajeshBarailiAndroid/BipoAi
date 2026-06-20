#!/usr/bin/env bash
# Push .env variables to Vercel (Production, Preview, Development).
# Usage:
#   npx vercel link          # once, pick your BipoAi project
#   npm run vercel:env
#   npx vercel --prod        # redeploy after env sync

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Error: .env not found in $ROOT"
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "Error: npx not found. Install Node.js first."
  exit 1
fi

if [[ ! -d .vercel ]]; then
  echo "Run this first and select your Vercel project:"
  echo "  npx vercel link"
  exit 1
fi

read_env() {
  local key="$1"
  local line val
  line="$(grep -E "^${key}=" .env | tail -1 || true)"
  [[ -z "$line" ]] && return 1
  val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  printf '%s' "$val"
}

KEYS=(
  GEMINI_API_KEY
  GEMINI_MODEL
  GEMINI_SOLVE_MODEL
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_ANON_KEY
  SESSION_SECRET
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GOOGLE_REDIRECT_URI
)

gemini_key="$(read_env GEMINI_API_KEY || true)"
if [[ -n "$gemini_key" && "$gemini_key" == AQ.* ]]; then
  echo ""
  echo "WARNING: GEMINI_API_KEY starts with AQ. — this often fails on the Gemini API."
  echo "Create an AIzaSy… key at https://aistudio.google.com/apikey and update .env first."
  echo ""
fi

for key in "${KEYS[@]}"; do
  val="$(read_env "$key" || true)"
  if [[ -z "$val" ]]; then
    echo "Skip $key (not in .env)"
    continue
  fi
  echo "Setting $key on Vercel (production, preview, development)…"
  for env in production preview development; do
    printf '%s' "$val" | npx vercel env add "$key" "$env" --force 2>/dev/null \
      || printf '%s' "$val" | npx vercel env add "$key" "$env"
  done
done

echo ""
echo "Done. Redeploy so variables take effect:"
echo "  npx vercel --prod"
echo ""
echo "Then verify: https://www.bipoai.com/api/gemini/status"
