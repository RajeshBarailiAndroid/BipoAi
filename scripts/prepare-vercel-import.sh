#!/usr/bin/env bash
# Build vercel-import.env from .env for paste/import in Vercel dashboard.
# Usage: npm run vercel:import-file
# Then: Vercel → Settings → Environment Variables → paste file contents (or Import)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/vercel-import.env"

if [[ ! -f .env ]]; then
  echo "Error: .env not found"
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
)

: > "$OUT"
count=0
for key in "${KEYS[@]}"; do
  val="$(read_env "$key" || true)"
  if [[ -z "$val" ]]; then
    echo "# skip $key (not in .env)" >> "$OUT"
    continue
  fi
  printf '%s=%s\n' "$key" "$val" >> "$OUT"
  count=$((count + 1))
done

echo "Wrote $count variables to: $OUT"
echo ""
echo "Next steps:"
echo "  1. Open https://vercel.com/dashboard → your BipoAi project"
echo "  2. Settings → Environment Variables"
echo "  3. Click 'Add Environment Variable' dropdown → 'Import .env' (or paste all lines)"
echo "  4. Select Production + Preview + Development"
echo "  5. Save, then Deployments → Redeploy"
echo "  6. Check https://www.bipoai.com/api/env/check"
