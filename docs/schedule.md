# The circadian schedule

The pacemaker is the agent's clock. This document is the design of *when* it
beats, why, and what happens when it stops.

## TL;DR

| Trigger | Cron (UTC) | Fires | What it does |
|---|---|---|---|
| Weekday wake window | `*/15 8-23 * * MON-FRI` | 64 beats/day, Mon–Fri 08:00–23:45 | dispatches `think.yml`, `inputs.reason = "pacemaker:*/15 8-23 * * MON-FRI"` |
| Sleep / consolidation | `17 2 * * *` | 1/day, every day at 02:17 | dispatches `think.yml`, `inputs.reason = "pacemaker:sleep:17 2 * * *"` |
| Weekend cadence (optional, off) | `0 10-20 * * SAT,SUN` | 11 beats/day, Sat–Sun 10:00–20:00 | same as a wake beat |

Default volume: **327 dispatches/week** (5 x 65 + 2 weekend sleep jobs).
With the weekend cron enabled: ~351.

## Why an external clock at all

zero-poc's heartbeat (`think.yml` `schedule:` cron) is throttled by GitHub to
roughly 4–5 runs/day. `workflow_dispatch` events are **not** subject to that
throttling. So the repo's own cron stays as a slow fallback clock, and an
external pinger — this worker, outside GitHub's scheduling economy — makes
time *observable inside the repo* at whatever cadence we choose. The idle gate
(already live in zero-poc) keeps cost bounded: more wake-ups does not mean
more spend, it means more *opportunities* to notice, most of which the gate
cheaply declines.

## The wake window (weekdays 08:00–23:00 nominal)

`*/15 8-23 * * MON-FRI` — every 15 minutes from 08:00 UTC. Because the hour
range includes the whole 23rd hour, the last beat is **23:45**, a short
wind-down tail past the nominal 23:00 close. That is deliberate simplicity
(one trigger, one string); if you want the last beat at exactly 23:00, replace
it with two triggers: `*/15 8-22 * * MON-FRI` and `0 23 * * MON-FRI`.

Beat cadence (15 min) must comfortably exceed `think.yml`'s runtime, or runs
queue behind each other on GitHub's side. If runs start lasting >15 min, slow
the window to `*/30` before adding anything fancier (a future
`concurrency:` group in think.yml can cancel-in-progress; that's zero-poc's
lane, noted in wiring.md).

## Sleep / consolidation at 02:17

One daily dispatch, every day of the week, at 02:17 UTC. The reason string
carries a `sleep` token (`pacemaker:sleep:17 2 * * *`) so `think.yml` can
branch to the consolidation job — the pass that merges the day's thinking
into longer-term state — instead of a normal think turn.

Why :17 and not :00/:30: GitHub Actions' cron fleet (and everyone else's)
thundering-herds the top of the hour; an odd minute gives the dispatch a
quiet lane, and 02:00-ish is the deepest part of the agent's night — minimal
collision with wake beats (last beat 23:45, first 08:00) and with human
attention.

## Weekend policy

**Recommendation: reduced cadence, not zero** — `0 10-20 * * SAT,SUN`
(hourly, 10:00–20:00), shipped commented-out in `wrangler.toml`.

Why reduced rather than the full weekday firehose:

1. **Demand is lower.** The agent's social loops (humans reading, replying,
   reacting) run at weekday intensity. Weekend beats would mostly hit the
   idle gate and burn runs for nothing.
2. **Cost/run hygiene.** GitHub bills Actions minutes and queues runs; half
   the weekday volume on the two days nobody's watching is the first thing
   to cut if limits ever pinch.
3. **Degrade, don't disappear.** Zero weekend crons still leaves the agent on
   GitHub's own throttled cron (~4–5 runs/day) plus the 02:17 sleep job —
   weekends fall back to baseline metabolism, never to coma.

Why not zero-by-default right now: the circadian metaphor is load-bearing —
the agent should experience lighter *days*, not interrupted weeks. Start with
the default (weekdays + daily sleep); enable the weekend line if the agent's
logs show weekend hunger (e.g. the 6h duty probe firing because nothing else
woke it, or unanswered thoughts piling up).

## Failure semantics: accelerant, not dependency

The pacemaker is designed so that its total failure is **visible and
survivable**, never silent and never fatal:

- **If the pacemaker dies entirely** (worker deleted, cron triggers gone,
  token expired): `think.yml`'s own `schedule:` cron still fires — throttled
  to ~4–5 runs/day, but it fires. The agent keeps waking on GitHub's clock
  and self-probes on every wake.
- **The duty-cycle forced probe (6h) is the hard floor.** The agent's own
  loop guarantees it never sleeps longer than 6 hours without checking
  itself, *independent of any external pinger*. Worst case with a dead
  pacemaker: the agent drops from ~65 dispatches/day to ~4–5 self-wakes/day
  and still notices its own state at least every 6h. The pacemaker is an
  accelerant on top of that floor — never a dependency under it.
- **Missed beat > double beat.** Each cron firing makes exactly one POST to
  the dispatch API. No retries, ever — a lost HTTP response must never
  become a second dispatch. A KV dedupe on `scheduledTime` additionally
  guarantees the same beat is never processed twice.
- **Failure-visible, not failure-silent.** Every beat — success *or* failure
  — is written to KV and served by `GET /health` as `last_beat`, including
  `outcome` (`dispatched` / `rejected` / `auth_or_rate_limited` /
  `network_error`) and the GitHub error detail. A dead clock is a stale
  `last_beat` timestamp that anyone (including the agent itself, once
  interoception lands) can see. Silent decay is the anti-pattern this whole
  design exists to avoid.

## Observability

- `GET https://pacemaker.<account>.workers.dev/health` — `last_beat` +
  `last_tick` + now. This is the pulse check; put it in the vault worker's
  dashboards or a browser bookmark.
- `POST /tick` — the interoception node (future). Anything that *notices*
  time passing — the agent on each wake, a probe, a human — POSTs here.
  `/health` then shows both sides of the heartbeat: `last_beat` (the clock
  ticked) vs `last_tick` (someone observed it). A growing gap between them
  is precisely the "I'm being woken but I'm not processing" or "I'm awake
  but nothing is waking me" signal — interoception, cheaply. See
  docs/wiring.md for the think.yml-side step that would start ticking.
- `wrangler tail` — live JSON-line logs of every beat and skip.

## Cloudflare cron dialect notes (verified 2026-10)

- Day-of-week is **1–7 with SUNDAY = 1** (Quartz-style), not Unix's 0–6.
  `1-5` means Sun–Thu. This schedule uses names (`MON-FRI`, `SAT,SUN`)
  everywhere — Cloudflare's docs recommend names for exactly this reason.
- Minute/hour fields are standard: `*/15` steps and `8-23` ranges behave
  like Unix cron. All times are UTC only.
- Free plan allows 5 cron triggers per account; we ship 2 (+1 optional).
- Trigger changes take up to ~15 minutes to propagate after deploy.
