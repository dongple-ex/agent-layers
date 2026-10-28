# workflow W0 확정 계약

| 항목 | 내용 |
| --- | --- |
| 작성일·근거 기준일 | 2026-10-28 |
| 기준 구현 | agent-layers `0137742` |
| 대상 | 후속 W1의 형식·DAG 구현과 W4의 Codex 실행기 |
| 확인 환경 | Linux aarch64, Node.js 24.15.0, codex-cli 0.165.0 |
| 상태 | 현재 환경에서 최소 실행 가능성 확인 완료. 제품 실행기는 미구현 |
| 상위 계획 | 공유 스킬 `agent-layers-workflow-plan/references/PLAN.md` |
| 실제 시험 근거 | [AUDIT.md](AUDIT.md)의 2절 「검증 결과」와 3절 「발견과 변경 이유」 |

| PART | 내용 |
| --- | --- |
| PART 1 | 첫 버전 범위와 실행기 결정 |
| PART 2 | CLI·정책·계획·결과 계약 |
| PART 3 | 실행·검증·취소의 연결 조건 |
| PART 4 | W1 인계와 남은 검증 |

---
---
# PART 1 — 범위와 실행기

## 1. 범위

첫 버전은 로컬 Git 저장소, Linux, Codex CLI 한 종류, 동시 실행 1개로 제한한다. 계획은 DAG 형식이며 실행은 위상 순서대로 한다. 역할별 호출은 독립된 세션이다. 기존 agent-layers 설정 배포 명령과 상태 파일은 수정하지 않는다.

W0에서 사용한 모델은 기존 설정의 `gpt-6-astra`, 추론 설정은 `high`, 인증은 기존 ChatGPT 로그인이다. 이 값은 이번 측정 환경이며 제품의 하드코딩 기본값이 아니다. 제품에서는 정책 또는 명시적 실행 옵션으로 모델을 결정하고 확정된 값을 실행 기록에 남긴다.

## 2. W0에서 추가로 확정한 결정

| ID | 결정 | 근거 |
| --- | --- | --- |
| W0-D1 | 역할별 permission profile을 컴파일하고 legacy `--sandbox`와 혼용하지 않는다 | 읽기·쓰기·보호 파일·외부 경로·네트워크 경계 실제 확인 |
| W0-D2 | 기존 인증은 사용하되 실행별 설정을 명시한다 | `--ignore-user-config`와 명시적 모델·정책으로 실제 호출 성공 |
| W0-D3 | stdout이 비어 있으면 종료 코드 0이어도 완료로 인정하지 않는다 | 자동 시험에서 빈 출력·종료 코드 0 재현 |
| W0-D4 | 검증 명령에는 검증된 OS 파이프 연결을 사용한다 | Node의 직접 stdio 연결에서는 출력 누락, OS 파이프에서는 수집 성공 |
| W0-D5 | 취소 시 샌드박스가 만든 별도 프로세스 그룹도 추적한다 | 부모 그룹만 종료하면 3개 프로세스 잔존, 두 그룹 종료 후 0개 |
| W0-D6 | 원문 실행 이벤트와 업무 완료 증거를 구분한다 | 구조화된 최종 응답·실제 파일·종료 상태를 별도로 확인 |
| W0-D7 | exec의 전역 설정 부작용을 검사하고 자신이 추가한 항목만 정리한다 | ignore-user-config·ephemeral 사용 중에도 임시 프로젝트 trusted 항목 추가 관찰 |

별도 설명: W0-D4의 내부 커널·Node 원인은 확정하지 않았다. 확정한 사실은 현재 조합에서 나타난 연결 방식별 차이와 우회 방식의 동작이다. 실행 환경이나 CLI 버전이 바뀌면 capability 시험을 다시 한다.

---
---
# PART 2 — 데이터와 CLI

## 3. CLI 계약

상위 계획 4절의 `workflow plan`, `validate`, `run`, `status`, `resume`, `cancel`, `report`를 유지한다. `--source`는 설정 저장소, `--path`는 작업 저장소다. 상태 ID는 프로그램이 만든 UUID이며 외부에서 경로 조각으로 사용하지 않는다.

| 명령군 | 모델 호출 | 쓰기 범위 | 성공의 의미 |
| --- | --- | --- | --- |
| `plan` | Planner 호출 | 별도 workflow 기록 | 실행 가능한 계획 생성·검사 완료 |
| `validate`, `status`, `report` | 없음 | 없음 | 검사·조회 성공이며 업무 완료를 뜻하지 않음 |
| `run`, `resume` | 역할별 호출 | 전용 worktree와 기록 | 모든 필수 검사·역할·산출물 통과 |
| `cancel` | 새 호출 없음 | 취소 요청과 종료 기록 | 관리 대상 프로세스 종료 확인 |

계획 실행 확인은 `planHash`와 정책 범위에 연결한다. `--yes`는 그 범위의 확인만 대신한다. JSON 출력과 사람이 읽는 메시지를 섞지 않으며 진단은 stderr로 보낸다.

종료 코드는 0(완료 또는 정상 조회), 1(실행 실패), 2(잘못된 입력·미지원 환경), 3(입력·확인·복구 대기), 130(취소)으로 정한다. 실제 검증 명령의 원래 종료 코드는 별도 `exitCode`에 보존한다.

## 4. 정책 계약

정책은 실행 담당이 관리하며 모델이 생성하지 않는다. 알 수 없는 필드·중복 ID·유효하지 않은 값은 거부한다. 상위 계획 5.1절의 항목을 다음 객체 구조로 구체화한다.

| 필드 | 형식 | 검사 |
| --- | --- | --- |
| `schemaVersion` | 정수 1 | 다른 버전 거부 |
| `provider` | 객체 | `id: codex`, 명시적 `model`, `reasoningEffort`, 실행 파일 선택 |
| `limits` | 객체 | 상위 계획의 8개 수치 항목, `maxConcurrent`는 1 |
| `allowedWritePaths` | 상대 경로 배열 | 중복 정규화, 절대 경로·상위 이탈·NUL 거부 |
| `protectedPaths` | 상대 경로 배열 | 허용 경로보다 우선, 런타임 필수 보호 항목 축소 불가 |
| `checks` | 검사 객체 배열 | 고유 ID, 실행 파일·인자 배열·상대 cwd·timeout·입력 해시 대상 |
| `requiredChecks` | 검사 ID 배열 | `checks`의 ID만 허용, 빈 목록 거부 |
| `requiredRoles` | 역할 배열 | 첫 버전은 `reviewer`, `auditor` 필수 |
| `exceptions` | 명시적 예외 배열 | `replace-limit`, `add-check`만 허용, 원래 검사·권한 약화 금지 |

`limits`의 8개 항목은 `maxConcurrent`, `maxSteps`, `maxRepairAttempts`, `maxTransportRetries`, `maxPlanRepairs`, `maxAgentCalls`, `stepTimeoutSeconds`, `runTimeoutSeconds`다. timeout·최대 단계·호출 수는 양수, 재시도 수는 0 이상의 정수다. 상위 계획의 제안값을 초기값으로 사용하되 실행 시 정책에 펼쳐 기록한다.

검사 정의의 `command`는 실행 파일이고 `args`는 문자열 배열이다. 모델이 만든 셸 문자열을 실행하지 않는다. OS 파이프 중계용 고정 셸 코드에 명령을 문자열 보간하지 않고 별도 argv로 전달한다.

경로 배열은 임의 glob이 아닌 파일 또는 디렉터리 경로로 시작한다. 기존 경로는 realpath를, 새 파일은 가장 가까운 기존 부모를 검사한다. `.git`, `.codex`, `.agents`, 정책·기존 검사 입력 등 필수 보호 대상은 W4에서 실제 실행 정책으로 검증한다. W0의 `protected.txt` 시험만으로 이 전체 목록의 강제 여부를 보증하지 않는다.

## 5. 계획과 결과 계약

모델이 반환하는 계획은 `schemaVersion`, `goal`, `steps`만 포함한다. 각 step은 `id`, `role`, `dependsOn`, `instruction`, `writePaths`, `checkIds`, `acceptance`를 갖는다. 첫 버전의 업무 step 역할은 `coder`이며 Planner·Verifier·Reviewer·Auditor의 단계는 프로그램이 배치한다. 모델은 필수 검증·검토 단계를 삭제할 수 없다.

프로그램이 보관하는 계획에는 `runId`, `baseCommit`, `policyHash`, `planHash`, `providerFingerprint`, `createdAt`을 추가한다. 모델이 이 필드들을 반환하면 무시하지 말고 잘못된 입력으로 거부한다.

| 검증 종류 | 조건 |
| --- | --- |
| DAG | 고유 ID, 존재하는 선행 ID, 자기 참조·순환 금지 |
| 실행 순서 | 동률은 원래 steps 순서로 정하는 안정적 위상 정렬 |
| 범위 | 단계의 writePaths가 정책 허용 범위 안에 있어야 함 |
| 완료 조건 | instruction·acceptance가 비어 있지 않고 checkIds가 유효해야 함 |
| 규모 | maxSteps와 전체 호출 상한 안에서 검토 단계까지 실행할 수 있어야 함 |
| 해시 | 키 순서를 정규화한 직렬화에 SHA-256 적용, 모델이 계산하지 않음 |

역할 결과의 필드는 `schemaVersion`, `stepId`, `attempt`, `status`, `summary`, `artifacts`, `findings`, `needsInput`이다. `status`는 `completed`, `needs_changes`, `blocked`로 제한한다. `artifacts`는 상대 경로와 용도, `findings`는 검사 코드·심각도·경로·근거를 가진다. 실제 파일 존재와 해시는 프로그램이 계산한다.

JSON Schema는 공급자 출력 유도를 위한 수단이다. W1의 독립 검사기가 타입·필수 필드·추가 필드·경로·참조·DAG 의미를 다시 검사한다. 필드 검사 통과를 업무 내용의 정확성으로 보고하지 않는다.

---
---
# PART 3 — 실행·검증·취소

## 6. Codex 실행기 계약

```mermaid
flowchart LR
    A[기능과 정책 확인] --> B[역할별 새 exec 호출]
    B --> C[JSONL 이벤트 수집]
    C --> D[최종 JSON 독립 검사]
    D --> E[실제 파일과 검사 결과 대조]
    E --> F[단계 상태 갱신]
```

설치된 CLI의 실제 실행에서 사용한 옵션은 `exec --ignore-user-config --strict-config --ephemeral --json --output-schema`다. 모델과 추론 설정, `approval_policy=never`, `web_search=disabled`, 역할별 `default_permissions`를 명시했다. hooks, multi_agent, multi_agent_v2, apps, plugins, memories, browser_use, computer_use, unbounded_connection_retries를 호출 단위로 비활성화했다.

이 프로필을 모든 설치에 그대로 강요하지 않는다. 필수 조직 지침과 승인 정책은 유지한다. 필요한 인증·공급자 설정을 명시적으로 구성할 수 없거나 필수 지침을 잃게 되는 환경은 지원 불가로 판정한다. 설정을 생략한 채 더 넓은 기본 권한으로 실행하지 않는다.

`--ignore-user-config`와 `--ephemeral`은 전역 설정 무변경 보장이 아니다. W0에서는 새 임시 저장소의 trusted 항목이 실제 설정 파일에 추가됐다. 그 항목 하나를 제거한 후보의 해시가 실행 전과 같음을 확인한 뒤 해당 블록만 정리했다. W4에서는 이 부작용을 예방할 수 있는 호출 방식 또는 소유 항목 정리 절차를 자동 검증한다. 다른 세션의 설정 변경을 이전 파일 전체로 덮어쓰지 않는다. 예상 밖 변경이나 충돌은 기록하고 자동 정리를 중단한다.

MCP·플러그인·브라우저 권한과 모델 서비스 통신은 셸 네트워크 정책과 별개다. 이번 실제 호출에서 관찰된 도구 항목은 `command_execution`이며 MCP와 서브에이전트 호출은 관찰되지 않았다. 전체 우회 가능성을 검증한 보안 감사 결과로 해석하지 않는다.

최종 성공은 종료 코드 0, 정상 terminal 이벤트, 최종 JSON, 실제 산출물·검증 근거가 모두 있는 경우에만 인정한다. `turn.failed`, `error`, 끊긴 JSONL, 비어 있는 최종 결과는 독립 실패 조건이다. 사용량이 제공되면 원래 값과 호출 ID에 연결해 저장하며 임의 금액으로 환산하지 않는다.

## 7. 검증 명령의 stdio 계약

현재 Linux 조합에서는 Node `spawn`의 직접 `stdio: pipe` 연결로 sandbox 안의 Node 명령을 실행했을 때 stdout·stderr가 비어 있고 종료 코드 0인 사례가 재현됐다. 일반 파일 또는 OS 파이프 연결에서는 같은 sentinel을 받았다.

W0에서 확인한 고정 중계 구조는 Bash의 `pipefail`, `"$@"`, stdout의 `cat`, stderr의 별도 `cat`이다. 명령과 인자는 셸 코드에 보간하지 않는다. 검증 명령이 종료 코드 7을 반환할 때 stdout·stderr와 코드 7이 그대로 전달되는 것을 확인했다.

제품 구현에서는 이 중계의 버전·존재 여부를 capability 검사에 포함한다. 일반 파일 캡처는 합성 시험의 비교용으로만 사용했으며 제품의 원문 로그 영구 저장 기본값으로 삼지 않는다. stderr·출력 한도·중계 프로세스 종료·문자열 안전성은 W4의 회귀 시험에 포함한다.

## 8. 취소 계약

첫 취소 시험에서 부모 프로세스 그룹만 종료하자 sandbox가 만든 별도 세션의 3개 프로세스가 남았다. 해당 시험 프로세스를 정리한 뒤, 자식 관계에서 발견한 별도 그룹까지 종료하는 방식으로 같은 시험을 통과했다.

| 단계 | 프로그램이 확인할 것 |
| --- | --- |
| 시작 | 실행 ID, PID, 프로세스 시작 시각, 소유 그룹 기록 |
| 실행 중 | 자식 관계·별도 그룹 변화를 추적 |
| 취소 요청 | 소유가 확인된 자식 그룹부터 TERM, 그 다음 주 그룹 종료 |
| 유예 후 | 동일 시작 시각의 잔여 프로세스만 확인하고 필요 시 KILL |
| 완료 | 남은 실행 프로세스·중계·자식이 없음을 확인한 뒤 CANCELLED 저장 |

이 방식은 W0의 정상 부모·자식과 실제 sandbox 세션 경계에서 검증했다. double-fork로 먼저 이탈하는 프로세스, PID 재사용 경쟁, cgroup 기반 완전한 수명 관리와 SIGKILL 경로는 아직 미검증이다. W4에서는 이 조건을 추가 시험하고 격리를 보장할 수 없는 경우 취소 완료로 기록하지 않는다.

실제 모델 서버의 생성 중단과 과금 종료까지 증명한 것은 아니다. 이번 실제 모델 호출 2회는 정상 완료시켰다.

---
---
# PART 4 — W1 인계와 한계

## 9. 다음 구현 범위

W1은 `src/workflow/schema.js`, `src/workflow/graph.js`와 해당 시험의 구현이다. 이 계약의 정책·계획·결과 검사를 코드로 옮기며 모델 호출과 실제 파일 수정은 하지 않는다. 기존 파일이 생겼다면 먼저 통합할 위치를 확인한다.

W0 시험 스크립트는 관찰용 코드다. 그대로 서비스 공용 코드에 복사해 완료로 취급하지 않는다. 프로세스 취소·출력 한도·권한 표면과 원자적 상태 저장은 각각 해당 구현 단계에서 제품 수준으로 검증한다.

## 10. 검증하지 않은 항목

- Node.js 18.17, 다른 CPU·운영체제·CLI 버전.
- 실제 Planner가 복잡한 목표를 나누는 품질, Reviewer·Auditor의 판단 정확성.
- worktree 생성과 원본 Git 메타데이터 보호, 모든 필수 보호 경로.
- 실행 중 강제 장애·잠금·지속 상태 복구·재시도 예산.
- 모든 종류의 프로세스 이탈과 원격 모델 작업 취소.
- 최소 읽기·쓰기 외의 대규모 저장소, 장시간 실행, 비용 상한.

W0 통과는 위 항목의 검증을 대체하지 않는다. 계약과 최소 실행 가능성이 확인되어 W1을 진행할 수 있다는 뜻이다.
