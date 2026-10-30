export const REVIEW_STEP_ID = 'review';
export const AUDIT_STEP_ID = 'audit';

export function graphIssues(steps) {
  const issues = [];
  const add = (where, msg) => issues.push({ where, msg });
  const index = new Map();
  steps.forEach((s, i) => {
    if (index.has(s.id)) {
      add(`steps[${i}].id`, `duplicate step id "${s.id}" (first at steps[${index.get(s.id)}])`);
    } else {
      index.set(s.id, i);
    }
  });
  steps.forEach((s, i) => {
    const seen = new Set();
    s.dependsOn.forEach((d, j) => {
      const where = `steps[${i}].dependsOn[${j}]`;
      if (seen.has(d)) {
        add(where, `duplicate dependency "${d}"`);
      } else if (d === s.id) {
        add(where, 'a step must not depend on itself');
      } else if (!index.has(d)) {
        add(where, `unknown step id "${d}"`);
      }
      seen.add(d);
    });
  });
  if (index.size !== steps.length) {
    return issues;
  }
  const edges = steps.map((s) => s.dependsOn.filter((d) => d !== s.id && index.has(d)));
  const { order } = kahn(steps.map((s) => s.id), edges);
  if (order.length < steps.length) {
    const done = new Set(order);
    const left = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
    add('steps', `dependency cycle; steps in or after the cycle: ${left.join(', ')}`);
  }
  return issues;
}

function kahn(ids, edges) {
  const remaining = edges.map((deps) => new Set(deps));
  const done = new Set();
  const order = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < ids.length; i += 1) {
      if (done.has(ids[i])) {
        continue;
      }
      if ([...remaining[i]].every((d) => done.has(d))) {
        done.add(ids[i]);
        order.push(ids[i]);
        progressed = true;
        break;
      }
    }
  }
  return { order };
}

export function withProgramSteps(steps) {
  const work = steps.map((s) => s.id);
  return [
    ...steps.map((s) => ({ id: s.id, dependsOn: [...s.dependsOn] })),
    { id: REVIEW_STEP_ID, dependsOn: [...work] },
    { id: AUDIT_STEP_ID, dependsOn: [...work, REVIEW_STEP_ID] },
  ];
}

export function topologicalOrder(nodes) {
  const { order } = kahn(nodes.map((n) => n.id), nodes.map((n) => n.dependsOn));
  if (order.length < nodes.length) {
    throw new Error('topologicalOrder: graph has a cycle or unknown dependency; run graphIssues first');
  }
  return order;
}

export function executionOrder(steps) {
  return topologicalOrder(withProgramSteps(steps));
}

export function downstreamOf(nodes, ids) {
  const known = new Set(nodes.map((n) => n.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`downstreamOf: unknown step id ${unknown.map((id) => JSON.stringify(id)).join(', ')}`);
  }
  const affected = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (!affected.has(n.id) && n.dependsOn.some((d) => affected.has(d))) {
        affected.add(n.id);
        grew = true;
      }
    }
  }
  return topologicalOrder(nodes).filter((id) => affected.has(id));
}
