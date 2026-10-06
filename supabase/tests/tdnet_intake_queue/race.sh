#!/bin/sh
# Two concurrent sessions run the worker's claim UPDATE on the same row. The first holds its transaction open
# (pg_sleep) so the second really contends for the row lock; exactly one may win.
# Usage: PGHOST=/tmp/... PGPORT=... PGDATABASE=... sh supabase/tests/tdnet_intake_queue/race.sh
set -eu
psql -v ON_ERROR_STOP=1 -Atq -c "update public.tdnet_intake_queue set state='queued', attempt_count=0, claimed_by=null, lease_expires_at=null"
CLAIM="update public.tdnet_intake_queue set state='enriching', claimed_by='%s', claimed_at=now(), lease_expires_at=now()+interval '3 minutes', attempt_count=1
 where source_url='https://www.release.tdnet.info/inbs/a.pdf' and attempt_count=0
 and (state='queued' or (state='enriching' and lease_expires_at<now())) returning claimed_by"
A=$(mktemp); B=$(mktemp)
( psql -v ON_ERROR_STOP=1 -Atq -c "begin; $(printf "$CLAIM" w1); select pg_sleep(1.5); commit;" > "$A" ) &
sleep 0.4
( psql -v ON_ERROR_STOP=1 -Atq -c "$(printf "$CLAIM" w2)" > "$B" ) &
wait
echo "session1: $(grep -c . "$A") row(s) [$(grep -v -e '^$' -e COMMIT -e BEGIN "$A" | tr '\n' ' ')]"
echo "session2: $(grep -c . "$B") row(s) [$(tr '\n' ' ' < "$B")]"
WA=$(grep -c '^w' "$A" || true); WB=$(grep -c '^w' "$B" || true)
WON=$((WA + WB))
rm -f "$A" "$B"
[ "$WON" = 1 ] && echo "race: exactly one winner" || { echo "race: FAILED winners=$WON"; exit 1; }
