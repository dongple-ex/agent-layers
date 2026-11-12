# Data mutation: task-local reports and deletion of this task's disposable clone only.
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess
from run import ROOT, CLONE, TARGET, ENV, capture

metadata = json.loads((ROOT / 'node-test-full.json').read_text())
log = (ROOT / metadata['log']).read_text()
counts = {}
for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped']:
    matches = re.findall(r'^(?:ℹ|#) ' + key + r' (\d+)$', log, re.M)
    assert len(matches) == 1, (key, matches)
    counts[key] = int(matches[0])
if metadata['exitCode'] != 0 or counts['fail']:
    raise SystemExit('Failed tests require the requested previous-commit comparison before cleanup.')
skipped = []
linux = []
for line in log.splitlines():
    line = line.strip()
    match = re.match(r'^([✔✖﹣]) (.*?) \([0-9.]+ms\)(?: # (.*))?$', line)
    if not match:
        continue
    status, name, reason = match.groups()
    if status == '﹣':
        skipped.append({'name': name, 'reason': reason})
    if name.startswith('workflow process: on Linux'):
        linux.append({'name': name, 'passed': status == '✔', 'raw': line})
assert len(skipped) == counts['skipped'], (len(skipped), counts)
assert len(linux) > 0 and all(x['passed'] for x in linux)
status = capture(['git', '--no-optional-locks', 'status', '--short'], 'clone-final-status', CLONE)
diff = capture(['git', '--no-optional-locks', 'diff', '--stat'], 'clone-final-diff', CLONE)
assert status['exitCode'] == 0 and diff['exitCode'] == 0
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CLONE, env=ENV, text=True).strip()
assert head == TARGET
command = 'ps -eo pid,ppid,etime,args | grep -E "node .*(setInterval|fake-ai)" | grep -v grep'
processes = capture(['/bin/sh', '-c', command], 'remaining-processes')
output = (ROOT / processes['log']).read_text()
assert processes['exitCode'] in [0, 1]
result = {
    'environment': json.loads((ROOT / 'environment.json').read_text()),
    'treeKillOutput': (ROOT / 'logs/tree-kill-capability.log').read_text().strip(),
    'fullSuite': {**metadata, **counts}, 'skippedTests': skipped, 'linuxProcessTests': linux,
    'failures': [], 'previousCommitComparison': 'not needed: no failing tests',
    'remainingProcesses': {**processes, 'output': output, 'terminatedByThisTaskAfterTests': False},
    'cloneTrackedChanges': (ROOT / status['log']).read_text(),
    'fullLogSha256': hashlib.sha256((ROOT / metadata['log']).read_bytes()).hexdigest(),
    'existingCheckoutAccessed': False, 'realAgentLayersHomeAccessed': False, 'actualAIInvocations': 0,
}
assert CLONE.parent == ROOT and CLONE.name == 'clone' and not CLONE.is_symlink()
shutil.rmtree(CLONE)
result['cloneRemoved'] = not CLONE.exists()
assert result['cloneRemoved']
(ROOT / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
