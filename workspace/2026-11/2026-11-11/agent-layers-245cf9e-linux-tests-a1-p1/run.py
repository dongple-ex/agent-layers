# Data mutation: isolated task folder only; original checkout and real agent-layers home are not accessed.
from pathlib import Path
import json
import os
import platform
import subprocess
import time

ROOT = Path(__file__).resolve().parent
TARGET = '245cf9e2662a982f50c298946e8feda045b19058'
PREVIOUS = 'daf4a18c9b5b058cd4d776c691a9d2d74894e807'
CLONE = ROOT / 'clone'
ENV = {
    'PATH': '/usr/bin:/bin', 'HOME': str(ROOT / 'home'),
    'TMPDIR': str(ROOT / 'tmp'), 'TMP': str(ROOT / 'tmp'), 'TEMP': str(ROOT / 'tmp'),
    'XDG_CONFIG_HOME': str(ROOT / 'xdg-config'), 'XDG_CACHE_HOME': str(ROOT / 'xdg-cache'),
    'XDG_DATA_HOME': str(ROOT / 'xdg-data'), 'AGENT_LAYERS_HOME': str(ROOT / 'state'),
    'CODEX_HOME': str(ROOT / 'home/.codex'), 'CLAUDE_CONFIG_DIR': str(ROOT / 'home/.claude'),
    'GEMINI_CLI_HOME': str(ROOT / 'home/.gemini'), 'COPILOT_HOME': str(ROOT / 'home/.copilot'),
    'KIMI_CODE_HOME': str(ROOT / 'home/.kimi-code'), 'GROK_HOME': str(ROOT / 'home/.grok'),
    'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0',
    'LANG': 'C.UTF-8', 'TZ': 'Asia/Seoul',
}
for name in ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']:
    if name in os.environ:
        ENV[name] = os.environ[name]


def capture(args, name, cwd=ROOT):
    started = time.monotonic()
    with (ROOT / 'logs' / (name + '.log')).open('wb') as output:
        proc = subprocess.run(args, cwd=cwd, env=ENV, stdout=output, stderr=subprocess.STDOUT)
    result = {'command': args, 'cwd': '.' if cwd == ROOT else str(cwd.relative_to(ROOT)),
              'exitCode': proc.returncode, 'elapsedSeconds': round(time.monotonic() - started, 3),
              'log': 'logs/' + name + '.log'}
    (ROOT / (name + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


if __name__ == '__main__':
    if platform.system() != 'Linux':
        raise SystemExit('STOP: not Linux PC · Codex')
    environment = {'os': platform.system(), 'unameMachine': platform.machine(),
                   'node': subprocess.check_output(['/usr/bin/node', '-v'], env=ENV, text=True).strip(),
                   'git': subprocess.check_output(['/usr/bin/git', '--version'], env=ENV, text=True).strip(),
                   'nodeExecutable': '/usr/bin/node', 'targetCommit': TARGET, 'previousCommit': PREVIOUS,
                   'isolatedHomeAndState': True, 'actualAIInvocations': 0}
    (ROOT / 'environment.json').write_text(json.dumps(environment, indent=2) + '\n')
    cloned = capture(['git', 'clone', 'https://github.com/dongple-ex/agent-layers.git', 'clone'], 'clone')
    if cloned['exitCode']:
        raise SystemExit('STOP: clone failed; see logs/clone.log')
    checkout = capture(['git', 'checkout', '--detach', TARGET], 'checkout', CLONE)
    if checkout['exitCode']:
        capture(['git', 'fetch', 'origin', 'fix/windows-taskkill-tree'], 'fetch-fallback', CLONE)
        checkout = capture(['git', 'checkout', '--detach', TARGET], 'checkout-retry', CLONE)
        if checkout['exitCode']:
            raise SystemExit('STOP: requested commit unavailable from remote; no tests executed')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=CLONE, env=ENV, text=True).strip()
    assert head == TARGET, head
    parent = subprocess.check_output(['git', 'rev-parse', 'HEAD^'], cwd=CLONE, env=ENV, text=True).strip()
    assert parent == PREVIOUS, parent
    branch = subprocess.run(['git', 'symbolic-ref', '-q', 'HEAD'], cwd=CLONE, env=ENV, capture_output=True)
    assert branch.returncode == 1, 'checkout must be detached'
    environment.update({'verifiedHead': head, 'verifiedParent': parent, 'detached': True})
    (ROOT / 'environment.json').write_text(json.dumps(environment, indent=2) + '\n')
    capability = capture(['node', '-e', "import('./src/workflow/process.js').then((m) => console.log(m.TREE_KILL_SUPPORTED, m.TREE_KILL_METHOD))"], 'tree-kill-capability', CLONE)
    print(json.dumps({'stage': 'capability', **capability, 'output': (ROOT / capability['log']).read_text().strip()}), flush=True)
    if capability['exitCode']:
        raise SystemExit('STOP: process module import failed')
    print(json.dumps({'stage': 'full-test-start', 'head': head, 'node': environment['node']}), flush=True)
    result = capture(['node', '--test'], 'node-test-full', CLONE)
    print(json.dumps({'stage': 'full-test-complete', **result}), flush=True)
