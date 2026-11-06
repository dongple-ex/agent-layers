import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];

if (args.includes('--fixture')) {
  const scenarioFile = option('--fixture');
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const prompt = args.includes('--prompt') ? option('--prompt') : fs.readFileSync(0, 'utf8');
  const body = prompt.slice(prompt.indexOf('## Request'));
  const request = JSON.parse(body.slice(body.indexOf('```json') + 7, body.lastIndexOf('```')));
  const callsFile = `${scenarioFile}.calls`;
  const earlier = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((s) => JSON.parse(s)) : [];
  const key = `${request.role}:${request.stepId}`;
  const actor = option('--actor');
  fs.appendFileSync(callsFile, `${JSON.stringify({ actor, model: option('--model'), request, prompt, pid: process.pid, cwd: process.cwd(), env: Object.keys(process.env) })}\n`);
  const actions = scenario[key] || scenario[request.role] || {};
  const action = Array.isArray(actions) ? actions[Math.min(earlier.filter((c) => `${c.request.role}:${c.request.stepId}` === key).length, actions.length - 1)] : actions;
  for (const [file, content] of Object.entries(action.write || {})) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  if (action.sleep) {
    await new Promise((resolve) => setTimeout(resolve, action.sleep));
  }
  const result = request.role === 'planner' ? (action.plan || scenario.plan) : {
    schemaVersion: 1, stepId: request.stepId, attempt: request.attempt, status: 'completed', summary: `${actor} did ${request.stepId}`, artifacts: [], findings: [], needsInput: [], ...action.result,
  };
  if (!action.exit) {
    const json = JSON.stringify(result);
    if (args.includes('--envelope')) {
      process.stdout.write(JSON.stringify({ response: json, error: action.error ?? null, meta: { model: 'reported-fixture-model', tokens: 7, cost: 0.01 } }));
    } else if (args.includes('--transcript')) {
      process.stdout.write(`• Done\n  \`\`\`json\n  ${json}\n  \`\`\`\n`);
    } else {
      process.stdout.write(action.stdout ?? json);
    }
  }
  process.exitCode = action.exit || 0;
}
