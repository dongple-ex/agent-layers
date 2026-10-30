import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphIssues, withProgramSteps, topologicalOrder, executionOrder, downstreamOf } from '../src/workflow/graph.js';

function step(id, dependsOn = []) {
  return { id, dependsOn };
}

test('workflow graph: valid DAG has no issues and keeps the original order for ties', () => {
  const steps = [step('c'), step('a'), step('b', ['c']), step('d', ['a', 'b'])];
  assert.deepEqual(graphIssues(steps), []);
  assert.deepEqual(topologicalOrder(steps), ['c', 'a', 'b', 'd']);
});

test('workflow graph: a later step listed first still runs after its dependency', () => {
  const steps = [step('test', ['impl']), step('impl'), step('docs')];
  assert.deepEqual(topologicalOrder(steps), ['impl', 'test', 'docs']);
});

test('workflow graph: duplicate ids, self, missing and repeated dependencies are reported in a fixed order', () => {
  assert.deepEqual(graphIssues([step('a'), step('a')]), [
    { where: 'steps[1].id', msg: 'duplicate step id "a" (first at steps[0])' },
  ]);
  assert.deepEqual(graphIssues([step('a', ['a', 'x', 'b', 'b']), step('b')]), [
    { where: 'steps[0].dependsOn[0]', msg: 'a step must not depend on itself' },
    { where: 'steps[0].dependsOn[1]', msg: 'unknown step id "x"' },
    { where: 'steps[0].dependsOn[3]', msg: 'duplicate dependency "b"' },
  ]);
});

test('workflow graph: a missing dependency alone is not also reported as a cycle', () => {
  const issues = graphIssues([step('a', ['missing']), step('b', ['a'])]);
  assert.equal(issues.length, 1);
  assert.match(issues[0].msg, /unknown step id "missing"/);
});

test('workflow graph: cycles are rejected and name the steps that cannot be ordered', () => {
  const issues = graphIssues([step('ok'), step('a', ['c']), step('b', ['a']), step('c', ['b']), step('after', ['c'])]);
  assert.deepEqual(issues, [{ where: 'steps', msg: 'dependency cycle; steps in or after the cycle: a, b, c, after' }]);
  assert.throws(() => topologicalOrder([step('a', ['b']), step('b', ['a'])]), /cycle/);
});

test('workflow graph: review and audit are appended after every work step, audit after review', () => {
  const steps = [step('impl'), step('docs'), step('tests', ['impl'])];
  const nodes = withProgramSteps(steps);
  assert.deepEqual(nodes.slice(-2), [
    { id: 'review', dependsOn: ['impl', 'docs', 'tests'] },
    { id: 'audit', dependsOn: ['impl', 'docs', 'tests', 'review'] },
  ]);
  assert.deepEqual(executionOrder(steps), ['impl', 'docs', 'tests', 'review', 'audit']);
  assert.deepEqual(steps[0], step('impl'));
});

test('workflow graph: downstream invalidation returns the step and every later dependent in run order', () => {
  const nodes = withProgramSteps([step('a'), step('b', ['a']), step('c'), step('d', ['b'])]);
  assert.deepEqual(downstreamOf(nodes, ['b']), ['b', 'd', 'review', 'audit']);
  assert.deepEqual(downstreamOf(nodes, ['c']), ['c', 'review', 'audit']);
  assert.deepEqual(downstreamOf(nodes, ['review']), ['review', 'audit']);
  assert.deepEqual(downstreamOf(nodes, ['audit']), ['audit']);
  assert.throws(() => downstreamOf(nodes, ['nope']), /unknown step id "nope"/);
});
