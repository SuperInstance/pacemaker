// pacemaker — the agent's CLOCK.
//
// A vanilla Cloudflare Worker (ES module, no build step) that gives zero-poc
// an unthrottled, externally-observable sense of time:
//
//   scheduled()  Cron triggers (wrangler.toml) dispatch think.yml through the
//                GitHub workflow_dispatch API on a circadian schedule.
//                (workflow_dispatch is NOT subject to the ~4-5 runs/day
//                throttling GitHub applies to repo cron schedules.)
//   fetch()      GET  /health — last beat + last tick from KV (failure-visible)
//                POST /tick   — record a tick (future interoception node)
//
// The schedule truth lives in wrangler.toml [triggers]; TRIGGERS below must
// match it, because decideAction() pattern-matches the exact cron string that
// fired.
//
// Philosophy: missed beat > double beat. Exactly one POST per beat, no
// retries, KV-deduped on scheduledTime. Every outcome (including failures)
// is written to KV and served by /health — failure-visible, never silent.

// ---------------------------------------------------------------------------
// Schedule constants — keep in sync with wrangler.toml [triggers]
// ---------------------------------------------------------------------------

export const TRIGGERS = {
  // Weekday wake window: every 15 min from 08:00 through 23:45 UTC.
  // Day names, NOT numbers: Cloudflare day-of-week is 1-7 with SUNDAY=1
  // (Quartz-style), so `1-5` would mean Sun-Thu, not Mon-Fri as in Unix cron.
  wake: "*/15 8-23 * * MON-FRI",
  // Optional weekend reduced cadence, disabled by default (docs/schedule.md).
  weekend: "0 10-20 * * SAT,SUN",
  // Daily sleep/consolidation job at 02:17 UTC (off the top-of-hour herd).
  consolidation: "17 2 * * *",
};

export const DEFAULT_REPO = "SuperInstance/zero-poc";
export const DEFAULT_REF = "main";
export const WORKFLOW_FILE = "think.yml";

// ---------------------------------------------------------------------------
// Pure schedule logic (no Cloudflare APIs — imported by test/simulate.js)
// ---------------------------------------------------------------------------

export const DOW_NAMES = { SUN: 1, MON: 2, TUE: 3, WED: 4, THU: 5, FRI: 6, SAT: 7 };
export const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

function toVal(token, names) {
  const t = token.trim().toUpperCase();
  if (names && names[t] !== undefined) return names[t];
  const n = Number.parseInt(token, 10);
  if (!Number.isInteger(n)) throw new Error(`bad cron value: "${token}"`);
  return n;
}

function expand(token, min, max, names) {
  // token: "*", "*/n", "a", "a-b", "a-b/n"
  if (token === "") throw new Error("empty cron token");
  let body = token;
  let step = 1;
  const slash = token.indexOf("/");
  if (slash !== -1) {
    step = Number.parseInt(token.slice(slash + 1), 10);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${token}"`);
    body = token.slice(0, slash);
  }
  let lo;
  let hi;
  if (body === "*") {
    lo = min;
    hi = max;
  } else if (body.includes("-")) {
    const [a, b] = body.split("-");
    lo = toVal(a, names);
    hi = toVal(b, names);
  } else {
    lo = hi = toVal(body, names);
    if (slash !== -1) hi = max; // "a/n" = a,a+n,... up to max
  }
  if (lo < min || hi > max || lo > hi) throw new Error(`out of range: "${token}" (valid ${min}-${max})`);
  const out = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

// Parse one cron field into a Set of integers. Accepts "*", lists ("1,15"),
// ranges ("8-23"), steps ("*/15", "10-20/5"), and (for weekday/month fields)
// case-insensitive three-letter names ("MON-FRI", "SAT,SUN", "oct").
export function parseField(field, min, max, names = null) {
  const values = new Set();
  for (const token of String(field).trim().split(",")) {
    for (const v of expand(token.trim(), min, max, names)) values.add(v);
  }
  if (values.size === 0) throw new Error(`empty cron field: "${field}"`);
  return values;
}

// Pure: does a 5-field cron expression fire at `date` (evaluated in UTC)?
// Semantics follow Cloudflare cron triggers (Quartz-flavoured):
//   - day-of-week is 1-7 with SUNDAY=1 (names SUN-SAT recommended);
//   - when both day-of-month and day-of-week are restricted they are ANDed
//     (vixie cron would OR them — the shipped schedule never restricts both).
export function cronMatches(expr, date) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`expected 5 cron fields, got ${fields.length} in "${expr}"`);
  const [mf, hf, domf, monf, dowf] = fields;
  const minutes = parseField(mf, 0, 59);
  const hours = parseField(hf, 0, 23);
  const dom = parseField(domf, 1, 31);
  const months = parseField(monf, 1, 12, MONTH_NAMES);
  const dow = parseField(dowf, 1, 7, DOW_NAMES);

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  // JS getUTCDay(): 0=Sun..6=Sat  ->  Cloudflare/Quartz: 1=Sun..7=Sat
  const weekday = date.getUTCDay() + 1;

  if (!minutes.has(minute) || !hours.has(hour) || !months.has(month)) return false;
  const domRestricted = domf !== "*";
  const dowRestricted = dowf !== "*";
  if (domRestricted && dowRestricted) return dom.has(day) && dow.has(weekday); // AND (Quartz)
  if (domRestricted) return dom.has(day);
  if (dowRestricted) return dow.has(weekday);
  return true;
}

export function normalizeCron(cron) {
  return String(cron).trim().split(/\s+/).join(" ");
}

// Pure: what should the worker do when `cron` fires?
//   wake crons       -> dispatch think.yml, inputs.reason = "pacemaker:<cron>"
//   consolidation    -> dispatch think.yml, inputs.reason = "pacemaker:sleep:<cron>"
//   anything else    -> no dispatch (log + skip)
export function decideAction(cron) {
  const norm = normalizeCron(cron);
  if (norm === TRIGGERS.consolidation) {
    return { dispatch: true, kind: "sleep", reason: `pacemaker:sleep:${TRIGGERS.consolidation}` };
  }
  if (norm === TRIGGERS.wake || norm === TRIGGERS.weekend) {
    return { dispatch: true, kind: "beat", reason: `pacemaker:${norm}` };
  }
  return { dispatch: false, kind: "unknown", reason: null };
}

// Pure: double-beat guard. Never dispatch twice for the same scheduledTime,
// whatever the previous outcome was — a lost HTTP response must never turn
// into a retry. A *new* scheduledTime dispatches even if the last beat failed.
export function shouldDispatch(decision, scheduledTime, lastBeat) {
  if (!decision || decision.dispatch !== true) return false;
  if (lastBeat && Number(lastBeat.scheduledTime) === Number(scheduledTime)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Worker runtime (Cloudflare APIs below this line)
// ---------------------------------------------------------------------------

function log(obj) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

async function kvGet(env, key) {
  if (!env.BINDING_KV) {
    log({ event: "kv-unbound", key, hint: "run: wrangler kv namespace create BINDING_KV" });
    return null;
  }
  try {
    return await env.BINDING_KV.get(key, "json");
  } catch (e) {
    log({ event: "kv-read-error", key, error: String(e) });
    return null;
  }
}

async function kvPut(env, key, value) {
  if (!env.BINDING_KV) return; // already logged by the read path in practice
  try {
    await env.BINDING_KV.put(key, JSON.stringify(value));
  } catch (e) {
    log({ event: "kv-write-error", key, error: String(e) });
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function repoOf(env) {
  return env.REPO || DEFAULT_REPO;
}

function refOf(env) {
  return env.REPO_REF || DEFAULT_REF;
}

function outcomeFor(status) {
  if (status === 204) return "dispatched";
  if (status === 404 || status === 422) return "rejected"; // wrong repo/workflow, or dispatch inputs not declared in think.yml
  if (status === 401 || status === 403) return "auth_or_rate_limited";
  return "unexpected_status";
}

// Exactly one attempt. No retries — ever. Missed beat > double beat.
async function dispatchOnce(env, reason) {
  const url = `https://api.github.com/repos/${repoOf(env)}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_PAT}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "pacemaker-worker",
      },
      body: JSON.stringify({ ref: refOf(env), inputs: { reason } }),
    });
    if (res.status === 204) return { status: 204, outcome: "dispatched", detail: null };
    const detail = (await res.text()).slice(0, 300);
    return { status: res.status, outcome: outcomeFor(res.status), detail };
  } catch (e) {
    return { status: null, outcome: "network_error", detail: String(e).slice(0, 300) };
  }
}

export default {
  async scheduled(event, env, ctx) {
    const decision = decideAction(event.cron);
    const last = await kvGet(env, "beat:last");
    if (!shouldDispatch(decision, event.scheduledTime, last)) {
      log({
        event: "skip",
        cron: normalizeCron(event.cron),
        kind: decision.kind,
        why: decision.dispatch ? "duplicate-scheduledTime" : "unknown-cron",
      });
      return;
    }
    const result = await dispatchOnce(env, decision.reason);
    const record = {
      cron: normalizeCron(event.cron),
      kind: decision.kind,
      reason: decision.reason,
      repo: repoOf(env),
      ref: refOf(env),
      scheduledTime: event.scheduledTime,
      scheduledAt: new Date(event.scheduledTime).toISOString(),
      attemptedAt: new Date().toISOString(),
      outcome: result.outcome,
      status: result.status,
      detail: result.detail,
    };
    await kvPut(env, "beat:last", record); // failure-visible: failures land here too
    log({ event: "beat", ...record });
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "pacemaker",
        repo: repoOf(env),
        now: new Date().toISOString(),
        last_beat: await kvGet(env, "beat:last"),
        last_tick: await kvGet(env, "tick:last"),
      });
    }

    if (request.method === "POST" && url.pathname === "/tick") {
      // Interoception node (future): anything that notices time passing — the
      // agent itself, a probe, a curious human — may record a tick here.
      // /health then shows both sides: clock beats vs. observed ticks, and a
      // growing gap between them is the "am I awake?" signal. See docs/schedule.md.
      if (env.TICK_SECRET && request.headers.get("x-tick-secret") !== env.TICK_SECRET) {
        return json({ ok: false, error: "missing or wrong x-tick-secret" }, 401);
      }
      let note = null;
      try {
        const body = await request.json();
        note = body?.note ?? null;
      } catch {
        // empty/non-JSON body is fine
      }
      const last_tick = { at: new Date().toISOString(), note };
      await kvPut(env, "tick:last", last_tick);
      return json({ ok: true, last_tick });
    }

    return json({ ok: false, error: "not found", routes: ["GET /health", "POST /tick"] }, 404);
  },
};
