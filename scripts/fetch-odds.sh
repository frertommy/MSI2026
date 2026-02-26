#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# fetch-odds.sh
# Pull daily h2h odds snapshots from The Odds API historical endpoint.
# One snapshot per day for 3 days before each match kickoff.
# Resumable: skips files that already exist on disk.
# ─────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load API key from .env
if [[ -f "$ROOT/.env" ]]; then
  export $(grep -v '^#' "$ROOT/.env" | xargs)
fi
API_KEY="${ODDS_API_KEY:?Missing ODDS_API_KEY in .env}"

MATCHES_FILE="$ROOT/data/processed/matches.json"
RAW_DIR="$ROOT/data/odds-api/raw"
PROCESSED_DIR="$ROOT/data/odds-api/processed"
PROGRESS_FILE="$ROOT/data/odds-api/.progress"
ODDS_OUTPUT="$PROCESSED_DIR/odds.json"

BUDGET_CAP=30000
CREDITS_USED=0
MIN_REMAINING=500
RATE_LIMIT_DELAY=1  # seconds between requests

# League mappings are handled in the python queue builder below

mkdir -p "$RAW_DIR" "$PROCESSED_DIR"

# ─────────────────────────────────────────────────────────────
# Build the fetch queue from matches.json
# ─────────────────────────────────────────────────────────────
echo "Reading matches from $MATCHES_FILE ..."

# Use python3 to generate the queue: fixtureId|date|league|homeTeam|awayTeam
# For each match, emit 7 rows (day -7 through day -1 before kickoff)
QUEUE=$(python3 -c "
import json, datetime, sys

with open('$MATCHES_FILE') as f:
    matches = json.load(f)

league_map = {
    'Premier League': 'soccer_epl',
    'La Liga': 'soccer_spain_la_liga',
    'Bundesliga': 'soccer_germany_bundesliga',
    'Serie A': 'soccer_italy_serie_a',
    'Ligue 1': 'soccer_france_ligue_one',
}

for m in matches:
    sport = league_map.get(m['league'])
    if not sport:
        continue
    kickoff = datetime.date.fromisoformat(m['date'])
    for day_offset in range(1, 4):
        snap_date = kickoff - datetime.timedelta(days=day_offset)
        iso = snap_date.isoformat() + 'T12:00:00Z'
        # fixtureId|sport|iso_date|homeTeam|awayTeam|kickoff_date|day_offset
        print(f\"{m['fixtureId']}|{sport}|{iso}|{m['homeTeam']}|{m['awayTeam']}|{m['date']}|{day_offset}\")
")

TOTAL=$(echo "$QUEUE" | wc -l | tr -d ' ')
echo "Total snapshots to fetch: $TOTAL"
echo "Budget cap: $BUDGET_CAP credits (10 per snapshot)"

# Count already fetched
SKIPPED=0
REMAINING_QUEUE=""
while IFS='|' read -r fid sport iso home away kickoff dayoff; do
  FNAME="${fid}_${kickoff}_d${dayoff}.json"
  if [[ -f "$RAW_DIR/$FNAME" ]]; then
    SKIPPED=$((SKIPPED + 1))
  else
    REMAINING_QUEUE+="${fid}|${sport}|${iso}|${home}|${away}|${kickoff}|${dayoff}"$'\n'
  fi
done <<< "$QUEUE"

# Remove trailing newline
REMAINING_QUEUE=$(echo -n "$REMAINING_QUEUE" | sed '/^$/d')
REMAINING=$(echo -n "$REMAINING_QUEUE" | wc -l | tr -d ' ')
if [[ -n "$REMAINING_QUEUE" ]]; then
  REMAINING=$((REMAINING))
else
  REMAINING=0
fi

echo "Already cached: $SKIPPED"
echo "Remaining to fetch: $REMAINING"

if [[ "$REMAINING" -eq 0 ]]; then
  echo "All snapshots already fetched. Skipping to processing."
else
  # Check budget
  CREDITS_NEEDED=$((REMAINING * 10))
  if [[ "$CREDITS_NEEDED" -gt "$BUDGET_CAP" ]]; then
    echo "WARNING: Need $CREDITS_NEEDED credits but budget cap is $BUDGET_CAP."
    echo "Will fetch up to $((BUDGET_CAP / 10)) snapshots and stop."
  fi

  EST_MIN=$(( (REMAINING * RATE_LIMIT_DELAY) / 60 ))
  echo "Estimated time: ~${EST_MIN} minutes at ${RATE_LIMIT_DELAY}s/req"
  echo ""

  # ─────────────────────────────────────────────────────────────
  # Fetch loop
  # ─────────────────────────────────────────────────────────────
  COUNT=0
  OK=0
  FAILED=0

  while IFS='|' read -r fid sport iso home away kickoff dayoff; do
    [[ -z "$fid" ]] && continue

    COUNT=$((COUNT + 1))
    FNAME="${fid}_${kickoff}_d${dayoff}.json"
    OUTFILE="$RAW_DIR/$FNAME"

    # Budget check
    if [[ "$CREDITS_USED" -ge "$BUDGET_CAP" ]]; then
      echo ""
      echo "BUDGET CAP reached ($CREDITS_USED / $BUDGET_CAP credits). Stopping."
      break
    fi

    printf "[%d/%d] %s vs %s (%s d-%s) ... " "$COUNT" "$REMAINING" "$home" "$away" "$kickoff" "$dayoff"

    URL="https://api.the-odds-api.com/v4/historical/sports/${sport}/odds?apiKey=${API_KEY}&date=${iso}&regions=eu&markets=h2h"

    # Fetch with curl, capture headers + body
    HTTP_CODE=""
    HEADER_FILE=$(mktemp)
    BODY=$(curl -s -w "\n%{http_code}" -D "$HEADER_FILE" "$URL" 2>/dev/null) || true
    HTTP_CODE=$(echo "$BODY" | tail -1)
    BODY=$(echo "$BODY" | sed '$d')

    # Parse x-requests-remaining from headers
    REQ_REMAINING=$(grep -i 'x-requests-remaining' "$HEADER_FILE" 2>/dev/null | tr -d '\r' | awk '{print $2}') || true
    REQ_USED=$(grep -i 'x-requests-used' "$HEADER_FILE" 2>/dev/null | tr -d '\r' | awk '{print $2}') || true
    rm -f "$HEADER_FILE"

    if [[ "$HTTP_CODE" == "200" ]]; then
      echo "$BODY" > "$OUTFILE"
      CREDITS_USED=$((CREDITS_USED + 10))
      OK=$((OK + 1))
      printf "OK (credits: %d used, %s remaining)\n" "$CREDITS_USED" "${REQ_REMAINING:-?}"
    elif [[ "$HTTP_CODE" == "422" ]]; then
      # 422 = no data for that date (before odds were posted) — save empty marker
      echo '{"data":[]}' > "$OUTFILE"
      CREDITS_USED=$((CREDITS_USED + 10))
      OK=$((OK + 1))
      printf "NO DATA (422) — saved empty marker\n"
    elif [[ "$HTTP_CODE" == "429" ]]; then
      printf "RATE LIMITED (429) — waiting 5s and retrying\n"
      sleep 5
      # Retry once
      HEADER_FILE=$(mktemp)
      BODY=$(curl -s -w "\n%{http_code}" -D "$HEADER_FILE" "$URL" 2>/dev/null) || true
      HTTP_CODE=$(echo "$BODY" | tail -1)
      BODY=$(echo "$BODY" | sed '$d')
      REQ_REMAINING=$(grep -i 'x-requests-remaining' "$HEADER_FILE" 2>/dev/null | tr -d '\r' | awk '{print $2}') || true
      rm -f "$HEADER_FILE"
      if [[ "$HTTP_CODE" == "200" ]]; then
        echo "$BODY" > "$OUTFILE"
        CREDITS_USED=$((CREDITS_USED + 10))
        OK=$((OK + 1))
        printf "  RETRY OK\n"
      else
        printf "  RETRY FAILED (HTTP %s)\n" "$HTTP_CODE"
        FAILED=$((FAILED + 1))
      fi
    else
      printf "ERROR (HTTP %s)\n" "$HTTP_CODE"
      FAILED=$((FAILED + 1))
    fi

    # Check x-requests-remaining guard
    if [[ -n "$REQ_REMAINING" && "$REQ_REMAINING" =~ ^[0-9]+$ ]]; then
      if [[ "$REQ_REMAINING" -lt "$MIN_REMAINING" ]]; then
        echo ""
        echo "x-requests-remaining ($REQ_REMAINING) dropped below $MIN_REMAINING. Stopping."
        break
      fi
    fi

    # Rate limit
    sleep "$RATE_LIMIT_DELAY"

  done <<< "$REMAINING_QUEUE"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Fetch complete: $OK OK, $FAILED failed"
  echo "Credits used this run: $CREDITS_USED"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi

# ─────────────────────────────────────────────────────────────
# Process raw files → data/odds-api/processed/odds.json
# ─────────────────────────────────────────────────────────────
echo ""
echo "Processing raw snapshots into $ODDS_OUTPUT ..."

python3 -c "
import json, os, glob, sys

raw_dir = '$RAW_DIR'
matches_file = '$MATCHES_FILE'
output_file = '$ODDS_OUTPUT'

with open(matches_file) as f:
    matches = json.load(f)

# Build match lookup: fixtureId -> match info
match_map = {m['fixtureId']: m for m in matches}

# Process all raw files
odds_by_fixture = {}

for filepath in sorted(glob.glob(os.path.join(raw_dir, '*.json'))):
    fname = os.path.basename(filepath)
    # Parse: {fixtureId}_{kickoff}_d{offset}.json
    parts = fname.replace('.json', '').split('_')
    if len(parts) < 3:
        continue
    try:
        fixture_id = int(parts[0])
        kickoff_date = parts[1]
        day_offset = int(parts[2].replace('d', ''))
    except (ValueError, IndexError):
        continue

    try:
        with open(filepath) as f:
            raw = json.load(f)
    except (json.JSONDecodeError, IOError):
        continue

    # Extract h2h odds from the response
    snap_data = raw.get('data', [])
    if not snap_data and isinstance(raw, list):
        snap_data = raw

    snapshot_odds = []
    timestamp = raw.get('timestamp', None)

    if isinstance(snap_data, list):
        for event in snap_data:
            bookmakers = event.get('bookmakers', [])
            for bk in bookmakers:
                for market in bk.get('markets', []):
                    if market.get('key') == 'h2h':
                        outcomes = {}
                        for o in market.get('outcomes', []):
                            outcomes[o['name']] = o['price']
                        snapshot_odds.append({
                            'bookmaker': bk.get('key', bk.get('title', '')),
                            'home': outcomes.get(event.get('home_team', ''), None),
                            'away': outcomes.get(event.get('away_team', ''), None),
                            'draw': outcomes.get('Draw', None),
                            'last_update': market.get('last_update', ''),
                        })

    if fixture_id not in odds_by_fixture:
        match_info = match_map.get(fixture_id, {})
        odds_by_fixture[fixture_id] = {
            'fixtureId': fixture_id,
            'homeTeam': match_info.get('homeTeam', ''),
            'awayTeam': match_info.get('awayTeam', ''),
            'league': match_info.get('league', ''),
            'kickoff': match_info.get('date', ''),
            'snapshots': [],
        }

    odds_by_fixture[fixture_id]['snapshots'].append({
        'daysBeforeKickoff': day_offset,
        'timestamp': timestamp,
        'bookmakers': snapshot_odds,
    })

# Sort snapshots within each fixture
for entry in odds_by_fixture.values():
    entry['snapshots'].sort(key=lambda s: s['daysBeforeKickoff'], reverse=True)

result = sorted(odds_by_fixture.values(), key=lambda e: (e['kickoff'], e['fixtureId']))

with open(output_file, 'w') as f:
    json.dump(result, f, indent=2)

print(f'Processed {len(result)} fixtures with odds data')
total_snaps = sum(len(e['snapshots']) for e in result)
print(f'Total snapshots: {total_snaps}')
"

echo "Done. Output: $ODDS_OUTPUT"
