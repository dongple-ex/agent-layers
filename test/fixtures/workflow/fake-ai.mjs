import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function readRequest(prompt) {
  const body = prompt.slice(prompt.indexOf('## Request'));
  return JSON.parse(body.slice(body.indexOf('```json') + '```json'.length, body.lastIndexOf('```')));
}

function earlierCalls(file, key) {
  if (!fs.existsSync(file)) {
    return 0;
  }
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).filter((line) => JSON.parse(line).key === key).length;
}

function pick(scenario, keys, callsFile) {
  for (const key of keys) {
    const entry = scenario[key];
    if (entry !== undefined) {
      const list = Array.isArray(entry) ? entry : [entry];
      return { key, action: list[Math.min(earlierCalls(callsFile, key), list.length - 1)] };
    }
  }
  return { key: keys[keys.length - 1], action: {} };
}

function applyFiles(action) {
  for (const [file, content] of Object.entries(action.write || {})) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(file, content);
  }
  for (const file of action.remove || []) {
    fs.rmSync(file, { force: true });
  }
}

function answerFor(request, action, scenario) {
  if (request.role === 'planner') {
    return action.plan || scenario.plan;
  }
  return { schemaVersion: 1, stepId: request.stepId, attempt: request.attempt, status: 'completed', summary: `fake ${request.role} result`, artifacts: [], findings: [], needsInput: [], ...action.result };
}

function print(answer) {
  const text = JSON.stringify(answer);
  process.stdout.write(argv.includes('--fenced') ? `I am done.\n\n\`\`\`text\nnot this one\n\`\`\`\n\n\`\`\`json\n${text}\n\`\`\`\n` : `${text}\n`);
}

async function main(scenarioFile) {
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const callsFile = `${scenarioFile}.calls.jsonl`;
  const request = readRequest(await readStdin());
  const { key, action } = pick(scenario, [`${request.role}:${request.stepId}:${request.attempt}`, `${request.role}:${request.stepId}`, request.role], callsFile);
  fs.appendFileSync(callsFile, `${JSON.stringify({ key, request, argv, pid: process.pid, cwd: process.cwd(), envNames: Object.keys(process.env) })}\n`);
  applyFiles(action);
  if (action.sleepMs) {
    await new Promise((resolve) => {
      setTimeout(resolve, action.sleepMs);
    });
  }
  if (action.stderr) {
    process.stderr.write(`${action.stderr}\n`);
  }
  if (action.stdout !== undefined) {
    process.stdout.write(action.stdout);
  } else if (!action.exit) {
    print(answerFor(request, action, scenario));
  }
  process.exitCode = action.exit || 0;
}

if (argv.includes('--scenario')) {
  await main(argv[argv.indexOf('--scenario') + 1]);
}
