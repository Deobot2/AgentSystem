#!/usr/bin/env node
// watchdog-target-date.js — which triage day should daily-triage-watchdog.yml judge?
//
// The watchdog is scheduled at 20:00 UTC, but GitHub's own scheduler regularly fires it hours
// late under load (the workflow's cron comment documents this). A naive `today=$(date -u +%F)`
// at fire time breaks the moment lateness crosses midnight UTC: issue #254 fired at
// 2026-08-07T00:49Z — 4h49m late — computed `today=2026-08-07`, and found no daily-triage run for
// a day whose 05:00/13:00 UTC slots hadn't happened yet. False alarm, every time firing slips
// past midnight.
//
// Fix: don't ask "what day is it right now", ask "what is the most recent day whose triage
// window has already closed". The later of the two daily-triage slots is 13:00 UTC, so: if it's
// currently before 13:00 UTC, that day's window isn't closed yet — judge yesterday instead. This
// is robust to arbitrary lateness (not just a fixed "N hours ago" offset), and a fire that's
// merely late but still same-day (e.g. 20:00 -> 23:00) is unaffected since 23:00 >= 13:00.

import { isMainModule } from './is-main.js';

/** @param {Date} now */
export function targetDate(now = new Date()) {
  const d = new Date(now.getTime());
  if (d.getUTCHours() < 13) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

if (isMainModule(import.meta.url)) {
  // Optional arg for manual testing: node tools/watchdog-target-date.js 2026-08-07T00:49:00Z
  const arg = process.argv[2];
  process.stdout.write(targetDate(arg ? new Date(arg) : new Date()) + '\n');
}
