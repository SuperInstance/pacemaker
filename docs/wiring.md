# Wiring think.yml (zero-poc side)

The pacemaker dispatches `think.yml` with **`inputs.reason`**. This doc is the
exact change zero-poc needs to accept it. **This repo does not touch
zero-poc** — another lane owns it — so everything here is copy-paste material
for that lane.

> **Order of operations matters.** The GitHub dispatch API rejects requests
> whose `inputs` are not declared in the workflow file (HTTP 422,
> "Unexpected inputs provided"). The pacemaker sends `inputs.reason` from its
> very first beat. **Wire think.yml first, deploy the worker second** —
> otherwise every beat fails visibly with `outcome: "rejected"` in `/health`.

## 1. Declare the dispatch trigger + input

In `.github/workflows/think.yml`, add `workflow_dispatch` under `on:`,
keeping every existing trigger (the throttled `schedule:` cron is the
fallback clock — it stays):

```yaml
on:
  workflow_dispatch:
    inputs:
      reason:
        description: "Why this run started: pacemaker:<cron> | pacemaker:sleep:<cron> | manual"
        required: false
        default: "manual"
        type: string
  # keep existing schedule:/push:/etc. triggers exactly as they are
```

If `on:` already has a `workflow_dispatch:` key, just merge the `inputs:`
block into it.

## 2. Hand the reason to the agent

Anywhere the workflow invokes `agent.py`, pass the reason through the
environment (works identically for scheduled, pushed, and dispatched runs):

```yaml
jobs:
  think:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ...existing steps...
      - name: Run agent
        env:
          WAKE_REASON: ${{ github.event.inputs.reason || 'schedule' }}
        run: python agent.py
```

## 3. Branch the 02:17 sleep job (optional, later)

The consolidation dispatch carries a `sleep` token. A separate job (or an
early branch inside the main one) can key on it:

```yaml
  sleep:
    # consolidation pass — runs only on the pacemaker's 02:17 dispatch
    if: contains(github.event.inputs.reason, 'sleep')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python agent.py --consolidate   # or whatever the sleep entrypoint becomes
```

`contains('', 'sleep')` is false for plain scheduled runs, so the fallback
cron never triggers consolidation by accident.

## 4. Later: log the reason into .agent-state.json

When the agent is ready to *feel* its clock (the interoception lane), a small
bounded append in `agent.py` is enough — each wake records who woke it and
when, capped so state can't grow without bound:

```python
import json, os
from collections import deque
from datetime import datetime, timezone

STATE = ".agent-state.json"
state = json.load(open(STATE)) if os.path.exists(STATE) else {}
wakes = deque(state.get("wakes", []), maxlen=50)   # bounded: last 50 wakes
wakes.append({
    "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    "reason": os.environ.get("WAKE_REASON", "schedule"),
})
state["wakes"] = list(wakes)
json.dump(state, open(STATE, "w"), indent=2, sort_keys=True)
```

(Commit `.agent-state.json` back at the end of the run, the same way other
agent state is persisted.) With that, the agent can distinguish "I was woken
by my clock at 14:30" from "GitHub throttled me awake" — and, paired with
`POST /tick` to the pacemaker, can start comparing its felt time against the
clock's record.

## 5. Test the wiring before the worker exists

```bash
gh workflow run think.yml --ref main -f reason="manual:wiring-test"

# or plain curl, with a PAT that has Actions write on zero-poc:
curl -X POST \
  -H "Authorization: Bearer $GH_PAT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/SuperInstance/zero-poc/actions/workflows/think.yml/dispatches \
  -d '{"ref":"main","inputs":{"reason":"manual:wiring-test"}}'
```

Expect HTTP 204 and a run in the Actions tab whose summary includes the
dispatch reason. 422 means step 1 isn't merged yet; 403 means the token is
wrong (see below).

## 6. The GH_PAT the worker needs

Fine-grained PAT (GitHub → Settings → Developer settings → Fine-grained
tokens):

- **Repository access:** only `SuperInstance/zero-poc`
- **Permissions:** Actions → **Read and write**. Nothing else.

Then `wrangler secret put GH_PAT` in `worker/`. The token never appears in
either repo. If it expires, beats fail with `auth_or_rate_limited` in
`/health` — visible, not silent, per the failure philosophy.
