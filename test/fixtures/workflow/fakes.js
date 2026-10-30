import fs from 'node:fs';

export const POLICY = JSON.parse(fs.readFileSync(new URL('./policy.json', import.meta.url), 'utf8'));
export const PLAN = JSON.parse(fs.readFileSync(new URL('./plan.json', import.meta.url), 'utf8'));

export function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    advance(seconds) {
      now += seconds * 1000;
    },
  };
}

function queues(script) {
  return new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
}

export function fakeProvider(script = {}, { clock = null, secondsPerCall = 0 } = {}) {
  const pending = queues(script);
  const calls = [];
  return {
    calls,
    async call(req) {
      calls.push(req);
      if (clock) {
        clock.advance(secondsPerCall);
      }
      const q = pending.get(`${req.role}:${req.stepId}`);
      const next = q && q.length > 0 ? q.shift() : {};
      if (next.transport) {
        throw Object.assign(new Error(`fake transport error ${next.transport}`), { transport: true, code: next.transport });
      }
      if (next.timeout) {
        throw Object.assign(new Error('fake role call timeout'), { timeout: true });
      }
      if (Object.prototype.hasOwnProperty.call(next, 'raw')) {
        return next.raw;
      }
      return {
        schemaVersion: 1,
        stepId: req.stepId,
        attempt: req.attempt,
        status: 'completed',
        summary: `${req.role} ${req.stepId} attempt ${req.attempt}`,
        artifacts: [],
        findings: [],
        needsInput: [],
        ...next,
      };
    },
  };
}

export function fakeVerifier(script = {}, { clock = null, secondsPerRun = 0 } = {}) {
  const pending = queues(script);
  const runs = [];
  return {
    runs,
    async run({ stepId, checkIds }) {
      runs.push({ stepId, checkIds: [...checkIds] });
      if (clock) {
        clock.advance(secondsPerRun);
      }
      return checkIds.map((id) => {
        const q = pending.get(id);
        const next = q && q.length > 0 ? q.shift() : {};
        return { id, exitCode: next.exitCode === undefined ? 0 : next.exitCode, failedTests: next.failedTests || [] };
      });
    },
  };
}
