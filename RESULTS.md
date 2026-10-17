# RESULTS

PoC build results for the pacemaker (agent's clock), captured 2026-10-17T05:41:16Z, node v24.21.0.

## Test run

Command: `node test/simulate.js` (pure-function tests of the schedule logic in `worker/src.js`; stdlib only, no dependencies.)

```
-- parseField -------------------------------------------------
  ok  */15 expands to 0,15,30,45
  ok  8-23 expands to 16 hours
  ok  MON-FRI expands to 5 weekdays (CF numbering 2-6)
  ok  SAT,SUN expands to 7,1
  ok  names are case-insensitive
  ok  step over a range: 10-20/5 = 10,15,20
  ok  out-of-range value throws
  ok  garbage token throws
  ok  wrong field count throws in cronMatches
-- cronMatches: weekday wake window ---------------------------
  ok  Tue 08:00 fires (window opens)
  ok  Tue 09:15 fires (on the 15s)
  ok  Tue 09:07 does not fire (minute off-grid)
  ok  Tue 07:45 does not fire (before window)
  ok  Tue 23:00 fires (nominal close)
  ok  Tue 23:45 fires (wind-down tail of hour 23)
  ok  Sat 12:00 does not fire (weekend)
  ok  Sun 12:00 does not fire (weekend)
  ok  Thu 14:30 fires (mid-week spot check)
-- cronMatches: consolidation (02:17 daily) --------------------
  ok  Tue 02:17 fires
  ok  Sat 02:17 fires (every day, weekends included)
  ok  Tue 02:00 does not fire
  ok  Tue 02:15 does not fire (not :17)
-- cronMatches: optional weekend cadence -----------------------
  ok  Sat 10:00 fires (window opens)
  ok  Sat 09:00 does not fire (early)
  ok  Sat 20:00 fires (window closes)
  ok  Sat 21:00 does not fire (late)
  ok  Sat 10:30 does not fire (hourly grid)
  ok  Wed 10:00 does not fire (weekday)
-- the Cloudflare day-of-week quirk, pinned as tests -----------
  ok  CF dialect: '0 12 * * 1' matches SUNDAY (2026-11-01)
  ok  CF dialect: '0 12 * * 2-6' is Mon-Fri (fires Tue, not Sat)
  ok  CF dialect: '1-5' is NOT Mon-Fri here — it includes Sunday
  ok  month names parse ('* * * oct *')
  ok  DOM & DOW both restricted AND together (Quartz semantics)
-- decideAction ------------------------------------------------
  ok  wake cron dispatches a beat, reason 'pacemaker:<cron>'
  ok  weekend cron dispatches a beat too
  ok  02:17 cron dispatches the sleep job
  ok  unknown cron does not dispatch
  ok  cron strings normalize whitespace before matching
-- shouldDispatch (double-beat guard) --------------------------
  ok  first sighting of a scheduledTime dispatches
  ok  same scheduledTime never dispatches twice
  ok  even a failed beat is not retried (missed beat > double beat)
  ok  a NEW scheduledTime dispatches even after a failed beat
  ok  unknown cron never dispatches
-- full-day simulations ----------------------------------------
  ok  Tuesday, default triggers: 65 dispatches (1 sleep + 64 beats)
  ok  Tuesday ordering: sleep at 02:17, first beat 08:00, last beat 23:45
  ok  Saturday, default triggers: only the 02:17 sleep job
  ok  Sunday with weekend cron enabled: 11 beats + 1 sleep = 12

summary: 47 passed, 0 failed

day plans (UTC), default triggers [wake + sleep]:
  Tue 2026-10-13: 65 dispatches — 02:17 sleep, 08:00..23:45 beats (64)
  Sat 2026-10-17: 1 dispatch  — 02:17 sleep only
  Sun 2026-10-18 (+optional weekend cron): 12 dispatches — 02:17 sleep, 10:00..20:00 beats (11)
  weekly volume, defaults: 5 weekdays x 65 + 2 weekend sleeps = 327 dispatches
```

Exit code: 0 — 47 passed, 0 failed.

## Cloudflare cron syntax verification (docs, 2026-10)

- Day-of-week in Cloudflare is **1-7 with SUNDAY=1** (Quartz-style), not Unix's 0-6. The intuitive `*/15 8-23 * * 1-5` would fire **Sun-Thu**, not Mon-Fri. The shipped schedule uses `MON-FRI` / `SAT,SUN` day names, which Cloudflare explicitly recommends to avoid this ambiguity. This quirk is pinned as executable tests (the 'CF dialect' group above).
- Minute/hour fields match standard cron: `*/15` steps and `8-23` ranges are supported exactly as intended. The daily `17 2 * * *` is plain standard syntax.
- Note: `8-23` includes the whole 23rd hour, so the nominal 08:00-23:00 window actually fires through 23:45 (a wind-down tail; exact-23:00 clamp variant documented in docs/schedule.md).
- Free plan: 5 cron triggers per account (we ship 2, +1 optional). Trigger changes propagate in up to ~15 minutes.

## Risk flagged to the deployer

**Ordering + token**: (1) think.yml must declare the `workflow_dispatch` `reason` input BEFORE the worker deploys — the dispatch API 422s on undeclared inputs, so every beat fails (visibly, via /health) until zero-poc merges the wiring snippet in docs/wiring.md. (2) The GH_PAT is a single fine-grained token with Actions:write on zero-poc; when it expires (fine-grained tokens have a max lifetime, default 90 days), beats fail with auth_or_rate_limited — /health shows it, but nothing rotates it automatically.
