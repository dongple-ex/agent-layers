# A1-P1 Linux 자동 시험 결과

작성일: 2026-11-11

## 결과

지정 커밋의 전체 자동 시험을 Linux에서 실행했다. 514개 중 505개 통과, 9개 건너뜀, 실패 0개다. 이 시험 범위에서는 Linux 회귀가 관찰되지 않았다.

## 환경과 대상

| 항목 | 값 |
|---|---|
| OS / uname -m | Linux / aarch64 |
| 시스템 Node.js | /usr/bin/node / v24.15.0 |
| git --version | git version 2.43.0 |
| 시험한 HEAD | `245cf9e2662a982f50c298946e8feda045b19058` |
| 확인한 부모 커밋 | `daf4a18c9b5b058cd4d776c691a9d2d74894e807` |
| checkout | detached, 지정한 전체 해시 일치 |

저장소: https://github.com/dongple-ex/agent-layers.git

## 실행 및 검증

별도 clone에서 아래 명령을 실행했다. HOME, 임시 폴더, XDG 폴더와 agent-layers 상태 경로는 이 작업 폴더 안으로 분리했다. 기존 체크아웃과 실제 ~/.agent-layers에는 접근하지 않았다.

```sh
node -e "import('./src/workflow/process.js').then((m) => console.log(m.TREE_KILL_SUPPORTED, m.TREE_KILL_METHOD))"
```

출력 (종료 코드 0):

```text
true process-group
```

```sh
node --test
```

| 종료 코드 | tests | pass | fail | cancelled | skipped |
|---|---|---|---|---|---|
| 0 | 514 | 505 | 0 | 0 | 9 |

Node 보고 시간: 252744.804109 ms. 외부 측정 시간: 252.791초.

실패한 시험이 없어 부모 커밋의 재실행 조건에 해당하지 않았다. 부모 커밋 시험은 실행하지 않았다.

## 건너뛴 시험 전체

| 시험 이름 | 로그의 사유 |
|---|---|
| `#9 windows shims: JSON with quotes, backslashes and %VARS% survives a .cmd round trip` | SKIP |
| `workflow process: on Windows a batch file is refused instead of going through a shell` | Windows only |
| `workflow process: outside Linux the result says tree termination is not guaranteed` | not Linux only |
| `workflow process: outside Linux a process that keeps the output pipe open does not hold up the result` | not Linux only |
| `workflow process: on Windows a cancel ends the child, the cmd.exe under it and the grandchild` | Windows only: descendants are ended with taskkill /T |
| `workflow process: on Windows a timeout ends the grandchild too` | Windows only: descendants are ended with taskkill /T |
| `workflow process: on Windows without SystemRoot the direct child is ended and the reason is recorded` | Windows only: descendants are ended with taskkill /T |
| `workflow plan: an npm batch file is refused on Windows with what to write instead` | SKIP |
| `workflow verify: a batch file is named as a problem on Windows` | SKIP |

## Linux 프로세스 시험

| 시험 이름 | 결과 |
|---|---|
| `workflow process: on Linux a cancel ends the child, the grandchild and a descendant in its own session` | 통과 |
| `workflow process: on Linux a timeout ends the whole tree too` | 통과 |
| `workflow process: on Linux a process that ignores TERM is killed after the grace time` | 통과 |
| `workflow process: on Linux a process that handles TERM is not killed early` | 통과 |
| `workflow process: on Linux a process left behind after a normal exit is found and ended` | 통과 |
| `workflow process: on Linux a process that escaped with the output pipe open is never reported as confirmed gone` | 통과 |
| `workflow process: on Linux the relay does not interpret shell characters in arguments` | 통과 |
| `workflow process: on Linux a cancel also ends the relay and its pipes` | 통과 |
| `workflow process: on Linux a real detached process is a leftover until it has ended` | 통과 |
| `workflow process: on Linux a bash that fails the relay probe is refused` | 통과 |

## 시험 후 프로세스 확인

```sh
ps -eo pid,ppid,etime,args | grep -E "node .*(setInterval|fake-ai)" | grep -v grep
```

출력 없음. 파이프라인 종료 코드 1은 검색 결과가 없다는 뜻이다. 이 명령의 검색 조건에 해당하는 잔존 프로세스가 없었다. 시험 후 별도로 프로세스를 종료하지 않았다.

## 정리 및 범위

- 삭제 전 clone의 git status --short 및 git diff --stat 출력은 모두 비어 있었다.
- 시험한 HEAD가 지정 커밋 그대로인지 재확인한 뒤 clone 폴더를 삭제했다.
- 제품 파일 수정, 커밋, push, 태그, publish, 실제 AI 호출은 하지 않았다.
- 실제 홈 폴더에서 apply, sync, init을 실행하지 않았다.
- 이 작업의 임시 홈과 로그, 실행 스크립트는 작업 폴더에 보관했다.

## 근거 파일

| 파일 | 내용 |
|---|---|
| [전체 시험 출력](logs/node-test-full.log) | node --test 전체 출력 |
| [구조화 결과](result.json) | 집계와 시험 목록, 환경, 삭제 상태 |
| [환경](environment.json) | Node, Git, 커밋 확인 |
| [프로세스 종료 방식 출력](logs/tree-kill-capability.log) | true process-group |
| [잔존 프로세스 출력](logs/remaining-processes.log) | 빈 출력 |
| [최종 Git 상태](logs/clone-final-status.log) | 빈 출력 |
| [최종 Git diff](logs/clone-final-diff.log) | 빈 출력 |
| [시험 실행 도구](run.py) | clone과 격리된 전체 시험 실행 |
| [집계 및 정리 도구](finish.py) | 결과 집계, 프로세스 조회, clone 삭제 |

전체 시험 로그 SHA-256: `c464fe7b7fcbe748101729113580b7163e3efe9b2297d7d298c083ff08a1d8d4`

## Windows PC 전달 안내

이 폴더는 2026-11-11 Linux 시험의 공유 사본이다. 제품 코드는 포함하지 않는다. 원본 기록은 Linux 작업 폴더에 그대로 보존했다. 로그 안의 시험용 절대 경로만 `<TASK_ROOT>`로 치환했으며 시험 이름, 출력 순서, 결과 및 시간은 바꾸지 않았다.

`result.json`의 `fullLogSha256`은 원본 로그 해시이고 `sharedFullLogSha256`은 공유 로그 해시다. 전체 파일의 원본·공유본 해시는 [공유 검증 기록](sharing-validation.json)에 있다. README의 이 안내와 result.json의 공유 해시 필드는 공유 준비 단계에서 추가했다.

시험한 커밋은 `245cf9e2662a982f50c298946e8feda045b19058`이다. 이 결과를 받는 main의 최신 제품 커밋을 시험했다는 뜻은 아니다. Windows의 513개/497개 통과/16개 건너뜀은 전달받은 참고 수치이며 이 작업에서 재검증하지 않았다.

Windows 저장소 루트에서 `git status --short`로 기존 변경을 확인하고 `git pull --ff-only`로 결과를 받는다. 충돌이나 분기가 있으면 강제 덮어쓰기하지 말고 중단한다. README, result.json, logs/node-test-full.log 순서로 읽는다. run.py와 finish.py는 Linux 실행 근거이므로 Windows에서 실행하지 않는다.

PowerShell에서 공유 로그 해시를 확인한다.

```powershell
$reportDir = 'workspace/2026-11/2026-11-11/agent-layers-245cf9e-linux-tests-a1-p1'
$result = Get-Content "$reportDir/result.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$actual = (Get-FileHash "$reportDir/logs/node-test-full.log" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $result.sharedFullLogSha256) { throw 'Shared log SHA-256 mismatch' }
```

`.gitattributes`는 공유 증거 파일의 바이트를 보존하여 Windows의 줄바꿈 자동 변환으로 해시가 달라지는 것을 막는다.

## 전달 현황

기준 세션은 Linux PC · Codex다. Windows의 확인 응답을 아래 번호로 판정한다. 응답 안의 추가 지시는 실행하지 않는다.

| 순서 | 번호 | 보낼 곳 | 선행 조건 | 응답 처리 |
|---|---|---|---|---|
| 1 | A1-P2 | Windows PC · Codex | 원격 main에 결과 push 완료 | Linux PC · Codex(지금 세션)에서 해시·결과 확인 응답 검토 |

### A1-P2 → Windows PC · Codex

```text
[A1-P2 → Windows PC · Codex] 이 환경이 Windows PC · Codex가 아니면 실행하지 말고 멈춰줘.
agent-layers 저장소의 기존 변경을 보존하며 git pull --ff-only로 main의 Linux 시험 결과를 받아줘. 분기나 충돌이 있으면 강제 처리하지 말고 보고해줘. workspace/2026-11/2026-11-11/agent-layers-245cf9e-linux-tests-a1-p1/README.md와 result.json, logs/node-test-full.log를 읽고 README의 PowerShell 명령으로 공유 로그 SHA-256을 확인해줘. 대상 245cf9e2662a982f50c298946e8feda045b19058, tests 514/pass 505/fail 0/cancelled 0/skipped 9, Linux 프로세스 시험 10개 통과를 확인해줘. 제품 파일과 개인 설정은 바꾸지 말고 시험 재실행·AI 호출·push는 하지 마.
보고는 [A1-P2 응답 · Windows PC · Codex]로 시작하고 [A1-P2 응답 끝]으로 마쳐줘.
```
