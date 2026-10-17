# pacemaker — the agent's clock

zero-poc is a GitHub repo that IS an AI agent. GitHub throttles its heartbeat
(`think.yml` cron) to ~4-5 runs/day, but does NOT throttle `workflow_dispatch`
events. The pacemaker is a tiny Cloudflare Worker that dispatches think.yml on
a circadian schedule — an external, unthrottled clock that makes time
observable inside the repo. The idle gate (already live in zero-poc) keeps
cost bounded; this repo only decides *when*.

Same trust domain and deploy pattern as the vault worker on
`casey-digennaro.workers.dev`. You own the deploy; nothing here touches
GitHub or Cloudflare until you run the commands below.

## Layout

- `worker/src.js` — the Worker: `scheduled` handler (dispatch beats) + `fetch`
  handler (`GET /health`, `POST /tick`). All schedule logic is pure functions.
- `worker/wrangler.toml` — cron triggers (the circadian schedule), KV binding.
- `docs/schedule.md` — the design: wake window, 02:17 sleep job, weekend
  policy, failure philosophy.
- `docs/wiring.md` — the think.yml change zero-poc needs. Read this first.
- `test/simulate.js` — pure-function schedule tests (node, stdlib only).

## Deploy (~10 minutes)

Step 0, before anything here: wire think.yml per `docs/wiring.md` — the
dispatch API returns 422 for inputs the workflow doesn't declare, so beats
fail (visibly) until that's merged.

    cd worker
    npx wrangler login
    npx wrangler kv namespace create BINDING_KV   # paste the printed id into wrangler.toml
    npx wrangler secret put GH_PAT                # fine-grained PAT: zero-poc only, Actions: Read and write
    npx wrangler deploy

Verify:

    curl https://pacemaker.<your-account>.workers.dev/health
    npx wrangler tail        # watch the next beat land

Cron trigger changes can take up to ~15 minutes to propagate after deploy.

## Cost

$0 on the free tier. Defaults are ~327 dispatches/week ≈ 47 GitHub API calls
per day (limit: 5,000/h per PAT); Workers free allows 100k requests/day and
5 cron triggers per account (we ship 2, one more optional); KV free allows
1k writes/day (this worker writes ~66). Even paid would be well under $1/mo.

## Failure philosophy

- **Missed beat > double beat.** One POST per beat, no retries, KV-deduped on
  `scheduledTime`. A lost response is a missed beat, never a double dispatch.
- **Accelerant, not dependency.** If the pacemaker dies entirely, think.yml's
  own throttled cron still wakes the agent ~4-5x/day, and the agent's 6h
  duty-cycle forced probe is the hard floor underneath everything.
- **Failure-visible, not failure-silent.** Every beat outcome — success or
  failure, with GitHub's error detail — lands in KV and is served by
  `/health`. A dead clock is a stale `last_beat` anyone (or the agent) can see.

Full design and the weekend-policy recommendation: `docs/schedule.md`.

## Test

    node test/simulate.js     # 47 assertions — see RESULTS.md
