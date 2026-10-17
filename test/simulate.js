// pacemaker — pure-function schedule tests (node, stdlib only).
// The decision logic lives in ../worker/src.js as pure functions; this file
// imports them and checks which crons fire at which moments in time.
//
// Run:  node test/simulate.js     (exit 0 = all green)

import assert from "node:assert/strict";
import { TRIGGERS, DOW_NAMES, parseField, cronMatches, decideAction, shouldDispatch } from "../worker/src.js";

let passed = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(`      ${e.message.split("\n")[0]}`);
  }
}
const at = (iso) => new Date(iso); // all times UTC

// Reference dates (verified weekdays):
//   2026-10-13 Tue   2026-10-15 Thu   2026-10-17 Sat   2026-10-18 Sun
//   2026-10-20 Tue   2026-11-01 Sun   2026-11-13 Fri

console.log("-- parseField -------------------------------------------------");

t("*/15 expands to 0,15,30,45", () => {
  assert.deepEqual([...parseField("*/15", 0, 59)].sort((a, b) => a - b), [0, 15, 30, 45]);
});
t("8-23 expands to 16 hours", () => assert.equal(parseField("8-23", 0, 23).size, 16));
t("MON-FRI expands to 5 weekdays (CF numbering 2-6)", () => {
  assert.deepEqual([...parseField("MON-FRI", 1, 7, DOW_NAMES)].sort((a, b) => a - b), [2, 3, 4, 5, 6]);
});
t("SAT,SUN expands to 7,1", () => {
  assert.deepEqual([...parseField("SAT,SUN", 1, 7, DOW_NAMES)].sort((a, b) => a - b), [1, 7]);
});
t("names are case-insensitive", () => assert.equal(parseField("mon-fri", 1, 7, DOW_NAMES).size, 5));
t("step over a range: 10-20/5 = 10,15,20", () => {
  assert.deepEqual([...parseField("10-20/5", 0, 59)].sort((a, b) => a - b), [10, 15, 20]);
});
t("out-of-range value throws", () => assert.throws(() => parseField("8-25", 0, 23)));
t("garbage token throws", () => assert.throws(() => parseField("xyz", 0, 59)));
t("wrong field count throws in cronMatches", () => assert.throws(() => cronMatches("*/15 8-23 * * ", at("2026-10-13T09:15:00Z"))));

console.log("-- cronMatches: weekday wake window ---------------------------");

const wake = TRIGGERS.wake; // */15 8-23 * * MON-FRI
t("Tue 08:00 fires (window opens)", () => assert.equal(cronMatches(wake, at("2026-10-13T08:00:00Z")), true));
t("Tue 09:15 fires (on the 15s)", () => assert.equal(cronMatches(wake, at("2026-10-13T09:15:00Z")), true));
t("Tue 09:07 does not fire (minute off-grid)", () => assert.equal(cronMatches(wake, at("2026-10-13T09:07:00Z")), false));
t("Tue 07:45 does not fire (before window)", () => assert.equal(cronMatches(wake, at("2026-10-13T07:45:00Z")), false));
t("Tue 23:00 fires (nominal close)", () => assert.equal(cronMatches(wake, at("2026-10-13T23:00:00Z")), true));
t("Tue 23:45 fires (wind-down tail of hour 23)", () => assert.equal(cronMatches(wake, at("2026-10-13T23:45:00Z")), true));
t("Sat 12:00 does not fire (weekend)", () => assert.equal(cronMatches(wake, at("2026-10-17T12:00:00Z")), false));
t("Sun 12:00 does not fire (weekend)", () => assert.equal(cronMatches(wake, at("2026-10-18T12:00:00Z")), false));
t("Thu 14:30 fires (mid-week spot check)", () => assert.equal(cronMatches(wake, at("2026-10-15T14:30:00Z")), true));

console.log("-- cronMatches: consolidation (02:17 daily) --------------------");

const sleep = TRIGGERS.consolidation; // 17 2 * * *
t("Tue 02:17 fires", () => assert.equal(cronMatches(sleep, at("2026-10-13T02:17:00Z")), true));
t("Sat 02:17 fires (every day, weekends included)", () => assert.equal(cronMatches(sleep, at("2026-10-17T02:17:00Z")), true));
t("Tue 02:00 does not fire", () => assert.equal(cronMatches(sleep, at("2026-10-13T02:00:00Z")), false));
t("Tue 02:15 does not fire (not :17)", () => assert.equal(cronMatches(sleep, at("2026-10-13T02:15:00Z")), false));

console.log("-- cronMatches: optional weekend cadence -----------------------");

const weekend = TRIGGERS.weekend; // 0 10-20 * * SAT,SUN
t("Sat 10:00 fires (window opens)", () => assert.equal(cronMatches(weekend, at("2026-10-17T10:00:00Z")), true));
t("Sat 09:00 does not fire (early)", () => assert.equal(cronMatches(weekend, at("2026-10-17T09:00:00Z")), false));
t("Sat 20:00 fires (window closes)", () => assert.equal(cronMatches(weekend, at("2026-10-17T20:00:00Z")), true));
t("Sat 21:00 does not fire (late)", () => assert.equal(cronMatches(weekend, at("2026-10-17T21:00:00Z")), false));
t("Sat 10:30 does not fire (hourly grid)", () => assert.equal(cronMatches(weekend, at("2026-10-17T10:30:00Z")), false));
t("Wed 10:00 does not fire (weekday)", () => assert.equal(cronMatches(weekend, at("2026-10-14T10:00:00Z")), false));

console.log("-- the Cloudflare day-of-week quirk, pinned as tests -----------");

// Cloudflare (Quartz-style): 1=SUN .. 7=SAT. Unix cron: 0=SUN .. 6=SAT.
// This is why the shipped schedule uses names, never numeric weekdays.
t("CF dialect: '0 12 * * 1' matches SUNDAY (2026-11-01)", () => {
  assert.equal(cronMatches("0 12 * * 1", at("2026-11-01T12:00:00Z")), true); // Sunday
});
t("CF dialect: '0 12 * * 2-6' is Mon-Fri (fires Tue, not Sat)", () => {
  assert.equal(cronMatches("0 12 * * 2-6", at("2026-10-13T12:00:00Z")), true); // Tue
  assert.equal(cronMatches("0 12 * * 2-6", at("2026-10-17T12:00:00Z")), false); // Sat
});
t("CF dialect: '1-5' is NOT Mon-Fri here — it includes Sunday", () => {
  assert.equal(cronMatches("0 12 * * 1-5", at("2026-11-01T12:00:00Z")), true); // Sunday fires!
});
t("month names parse ('* * * oct *')", () => {
  assert.equal(cronMatches("0 12 1 oct *", at("2026-10-01T12:00:00Z")), true);
  assert.equal(cronMatches("0 12 1 oct *", at("2026-11-01T12:00:00Z")), false);
});
t("DOM & DOW both restricted AND together (Quartz semantics)", () => {
  const expr = "0 12 13 * 3"; // the 13th AND a Tuesday (CF: TUE=3)
  assert.equal(cronMatches(expr, at("2026-10-13T12:00:00Z")), true); // Tue Oct 13
  assert.equal(cronMatches(expr, at("2026-11-13T12:00:00Z")), false); // Fri Nov 13 (day matches, weekday does not)
  assert.equal(cronMatches(expr, at("2026-10-20T12:00:00Z")), false); // Tue Oct 20 (weekday matches, day does not)
});

console.log("-- decideAction ------------------------------------------------");

t("wake cron dispatches a beat, reason 'pacemaker:<cron>'", () => {
  const d = decideAction(TRIGGERS.wake);
  assert.equal(d.dispatch, true);
  assert.equal(d.kind, "beat");
  assert.equal(d.reason, "pacemaker:*/15 8-23 * * MON-FRI");
});
t("weekend cron dispatches a beat too", () => {
  const d = decideAction(TRIGGERS.weekend);
  assert.equal(d.dispatch, true);
  assert.equal(d.kind, "beat");
});
t("02:17 cron dispatches the sleep job", () => {
  const d = decideAction(TRIGGERS.consolidation);
  assert.equal(d.dispatch, true);
  assert.equal(d.kind, "sleep");
  assert.equal(d.reason, "pacemaker:sleep:17 2 * * *");
});
t("unknown cron does not dispatch", () => {
  const d = decideAction("*/5 * * * *");
  assert.equal(d.dispatch, false);
  assert.equal(d.kind, "unknown");
});
t("cron strings normalize whitespace before matching", () => {
  assert.equal(decideAction("  */15   8-23  *  *  MON-FRI ").dispatch, true);
});

console.log("-- shouldDispatch (double-beat guard) --------------------------");

const st = 1792200000000; // some scheduledTime, ms epoch
t("first sighting of a scheduledTime dispatches", () => {
  assert.equal(shouldDispatch(decideAction(TRIGGERS.wake), st, null), true);
});
t("same scheduledTime never dispatches twice", () => {
  assert.equal(shouldDispatch(decideAction(TRIGGERS.wake), st, { scheduledTime: st, outcome: "dispatched" }), false);
});
t("even a failed beat is not retried (missed beat > double beat)", () => {
  assert.equal(shouldDispatch(decideAction(TRIGGERS.wake), st, { scheduledTime: st, outcome: "network_error" }), false);
});
t("a NEW scheduledTime dispatches even after a failed beat", () => {
  assert.equal(shouldDispatch(decideAction(TRIGGERS.wake), st + 15 * 60 * 1000, { scheduledTime: st, outcome: "network_error" }), true);
});
t("unknown cron never dispatches", () => {
  assert.equal(shouldDispatch(decideAction("*/5 * * * *"), st, null), false);
});

console.log("-- full-day simulations ----------------------------------------");

function dayPlan(crons, ymd) {
  const fires = [];
  for (let h = 0; h < 24; h += 1) {
    for (let m = 0; m < 60; m += 1) {
      const hh = String(h).padStart(2, "0");
      const mm = String(m).padStart(2, "0");
      const d = at(`${ymd}T${hh}:${mm}:00Z`);
      for (const c of crons) {
        if (cronMatches(c, d)) {
          const decision = decideAction(c);
          fires.push({ time: `${hh}:${mm}`, kind: decision.kind, reason: decision.reason });
        }
      }
    }
  }
  return fires;
}

const tuesday = dayPlan([TRIGGERS.wake, TRIGGERS.consolidation], "2026-10-13");
const saturday = dayPlan([TRIGGERS.wake, TRIGGERS.consolidation], "2026-10-17");
const sundayFull = dayPlan([TRIGGERS.wake, TRIGGERS.weekend, TRIGGERS.consolidation], "2026-10-18");

t("Tuesday, default triggers: 65 dispatches (1 sleep + 64 beats)", () => {
  assert.equal(tuesday.length, 65);
  assert.equal(tuesday.filter((f) => f.kind === "sleep").length, 1);
  assert.equal(tuesday.filter((f) => f.kind === "beat").length, 64);
});
t("Tuesday ordering: sleep at 02:17, first beat 08:00, last beat 23:45", () => {
  assert.equal(tuesday[0].time, "02:17");
  assert.equal(tuesday[1].time, "08:00");
  assert.equal(tuesday[tuesday.length - 1].time, "23:45");
});
t("Saturday, default triggers: only the 02:17 sleep job", () => {
  assert.equal(saturday.length, 1);
  assert.equal(saturday[0].reason, "pacemaker:sleep:17 2 * * *");
});
t("Sunday with weekend cron enabled: 11 beats + 1 sleep = 12", () => {
  assert.equal(sundayFull.length, 12);
  assert.equal(sundayFull.filter((f) => f.kind === "beat").length, 11);
});

console.log("");
console.log(`summary: ${passed} passed, ${failures.length} failed`);
console.log("");
console.log("day plans (UTC), default triggers [wake + sleep]:");
console.log(`  Tue 2026-10-13: ${tuesday.length} dispatches — 02:17 sleep, 08:00..23:45 beats (64)`);
console.log(`  Sat 2026-10-17: ${saturday.length} dispatch  — 02:17 sleep only`);
console.log(`  Sun 2026-10-18 (+optional weekend cron): ${sundayFull.length} dispatches — 02:17 sleep, 10:00..20:00 beats (11)`);
console.log(`  weekly volume, defaults: 5 weekdays x 65 + 2 weekend sleeps = ${5 * 65 + 2} dispatches`);

if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
