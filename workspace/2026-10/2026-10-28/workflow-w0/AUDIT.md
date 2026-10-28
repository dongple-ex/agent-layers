# workflow W0 계약과 실행 가능성 확인

> 이 문서는 2026-10-28 W0 실행 기록이며, 2026-10-29에 계약 문서와 함께 Git으로 공유한다. 아래 제외 범위와 미수행 항목은 W0 실행 당시 기준이다. 실험 스크립트·결과 JSON·진단 로그는 로컬 작업 기록으로 보관하며 이번 문서 커밋에는 포함하지 않는다. 파일명으로 표시한 근거와 재현 명령은 해당 로컬 자료가 있을 때 확인할 수 있다.

| 항목 | 내용 |
| --- | --- |
| 작성일 | 2026-10-28 |
| 상태 | W0 확인 완료. 현재 환경·합성 fixture 범위에서 통과 |
| 기준 | agent-layers `0137742`, 공유 계획 11절 W0 |
| 요청 범위 | 계약 구체화와 실제 실행 가능성 확인 |
| 제외 | 서비스 소스 수정, 전역 설정의 영구 변경, push, 게시, 운영 반영 |
| 실행 환경 | Linux aarch64, codex-cli 0.165.0 |
| 인증·모델 | 기존 ChatGPT 로그인, 설정된 gpt-6-astra / high 유지 |
| 모델 호출 범위 | 합성 fixture의 읽기·쓰기 확인 최대 2회, 호출별 120초 제한 |
| 산출물 | 이 폴더의 시험 스크립트, 정제된 결과 JSON, 계약 문서 |

## 1. 시험 범위

1. 모델 없이 읽기 전용·제한 쓰기·검증 명령 격리를 실제 실행한다.
2. 합성 fixture의 로컬 네트워크 접근 차단과 프로세스 그룹 종료를 확인한다.
3. 실행 가능한 범위에서 최소 모델 읽기·쓰기 호출을 한다.
4. 결과에 따라 계약을 확정하고 미확인·미지원 조건을 분리한다.

## 참고 자료

- 공유 계획: `agent-layers-workflow-plan/references/PLAN.md`.
- 설치 CLI: `codex exec --help`, `codex sandbox --help`, `codex features list`.
- 인증 확인: `codex login status`는 `Logged in using ChatGPT`. 실제 모델 호출 성공 여부와 구분한다.
- 공식 문서: [Permissions](https://learn.chatgpt.com/docs/permissions), [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## 2. 검증 결과

| 항목 | 실제 결과 | 근거 |
| --- | --- | --- |
| 실제 AI 읽기 호출 | 종료 코드 0, 파일의 임의 marker와 JSON 응답 일치, 쓰기 없음 | `live-results-2026-10-28T13-46-30-634Z.json` › live_read |
| 실제 AI 제한 쓰기 호출 | 종료 코드 0, output.txt 내용 일치, 보호 파일 유지 | 같은 파일 › live_write |
| 읽기 전용 명령 | 읽기 허용, 내부 쓰기 EROFS, 외부 읽기·쓰기 ENOENT | `results-2026-10-28T13-56-23-632Z.json` › sandbox_read |
| 제한 쓰기 명령 | 내부 쓰기 허용, 보호 파일 EROFS, 외부·symlink 차단 | 같은 파일 › sandbox_write |
| 네트워크 | 대조군은 로컬 fixture 서버 접속, sandbox는 같은 서버 접속 EPERM | 같은 파일 › 대조군과 sandbox 항목 |
| 검증 실패 전달 | stdout·stderr와 원래 종료 코드 7 보존 | 같은 파일 › verifier_failure_propagation |
| 일반 프로세스 취소 | 부모·자식 종료, 잔존 0개 | 같은 파일 › process_group_cancel |
| sandbox 프로세스 취소 | 별도 그룹을 포함해 7개 관찰 대상 종료, 잔존 0개 | 같은 파일 › sandbox_process_group_cancel |
| 설정 보존 | 일반 probe에서는 동일. 실제 모델 호출의 trusted 항목 추가는 정리 후 원래 해시로 복원 | 3.4절 및 최종 정리 확인 |
| 모델 실행 시간 | 읽기 17.074초, 쓰기 23.177초 | live-results의 durationMs |
| 모델 사용량 | 입력 102,149, 그중 캐시 입력 60,800, 출력 387 토큰 | live-results의 호출별 usage 합계 |

사용량은 공급자가 반환한 값이다. 캐시 입력을 전체 입력에 다시 더하지 않는다. ChatGPT 계정의 실제 금액·한도 차감은 조회하지 않았다.

원격 main은 `f56cac1`이며 새 workflow 파일은 확인되지 않았다. 로컬의 이전 계획 작업 기록은 보존했다. 서비스 소스와 공유 스킬은 수정하지 않았다. 전역 설정은 CLI가 추가한 임시 신뢰 항목을 제거해 원래 바이트 내용으로 복원했다.

## 3. 발견과 변경 이유

### 3.1 시험 서버 오류

처음 합성 TCP 서버가 연결 종료 시 `Error: read ECONNRESET`을 처리하지 못해 시험 스크립트가 종료됐다. 서버가 보내는 불필요한 응답을 없애고 예상한 연결 종료를 집계하도록 수정했다. 최종 실행의 serverResets는 0이다. 최초 실패에서 남은 fixture는 후속 수동 비교에 사용한 뒤 파일별로 확인해 모두 정리했다.

### 3.2 빈 출력과 종료 코드 0

자동 sandbox 시험에서 `code: 0`, `stdout: ""`, `stderr: ""`가 반복됐다. 세 번째 관찰 뒤 동일 방식 반복을 중단하고 직접 CLI와 stdio 연결 방식별 최소 재현으로 구분했다.

- `stdio-results.json`: Node 직접 stdio 연결은 sentinel 없음, 일반 파일과 OS 파이프는 sentinel 수집.
- `startup-probe.mjs`: echo는 detached·stdin 조건과 관계없이 출력돼, 단순한 detached 실행 문제와 구분했다.
- `startup-trace.log`: 프로그램이 실제로 실행된 것을 확인한 진단 기록. 자격증명 원문은 조회하지 않았다.
- 고정 OS 파이프 중계 적용 후 같은 경계 시험에서 필요한 모든 출력과 실패 코드가 관찰됐다.

내부 커널·Node 원인은 아직 확정하지 않았다. 빈 출력을 성공으로 처리하지 않는 계약과 현재 환경에서 검증한 연결 방식을 [CONTRACT.md](CONTRACT.md) 7절에 반영했다.

### 3.3 취소 후 남는 sandbox 자식

`results-2026-10-28T13-51-24-368Z.json`에서 부모 그룹 종료 후 3개 프로세스가 별도 세션에 남았다. 정확히 해당 시험 그룹만 종료해 정리했다. 자식 관계와 별도 프로세스 그룹까지 추적한 `results-2026-10-28T13-54-20-711Z.json`는 잔존 0개다. 최종 전체 probe도 잔존 0개로 통과했다.

실제 모델 생성 중 취소는 하지 않았다. 정상 종료시킨 최소 모델 호출과 sandbox 자식 종료 시험을 구분한다.

### 3.4 실제 호출의 설정 부작용과 복원

실제 호출 결과 파일의 `configUnchanged`는 `false`였다. `--ignore-user-config --ephemeral`을 사용해도 CLI가 임시 프로젝트 경로 아래 `trust_level = "trusted"` 블록을 전역 설정에 추가했다.

추가된 항목은 이번 시험 경로와 정확히 일치했다. 그 블록 하나만 제거한 후보의 SHA-256이 기존 `9d9b053b423542ba4ee66cf18761d9122797237eaef801098b20a57cab147092`와 같음을 확인한 뒤, 그 블록만 제거했다. 최종 실제 설정의 해시도 같은 값이다. 원래 결과 JSON의 `false`는 수정하지 않고 최초 관찰을 보존한다.

기존 지침의 최종 SHA-256은 `51e756219ff158228c4a60f0076597f91b96345d22d61e57e8afa670665a94a1`로 변경 전과 같다. 최종 임시 fixture와 시험 프로세스는 모두 정리했다.

## 4. 산출물과 재현 방법

| 파일 | 목적 |
| --- | --- |
| [CONTRACT.md](CONTRACT.md) | W1과 W4에 적용할 확정 계약 |
| `run-probes.mjs` | 모델 호출 없이 경계·검증 실패·프로세스 취소 시험 |
| `boundary-probe.mjs` | 합성 파일과 로컬 네트워크에 대한 접근 관찰 |
| `cancel-probe.mjs` | 부모·자식 수명 확인 fixture |
| `live-probe.mjs` | 실제 모델 읽기·쓰기 시험, 최대 2회 호출 |
| `probe-result.schema.json` | 최소 실제 호출의 JSON 출력 형식 |
| `stdio-probe.mjs` | 직접 연결·파일·OS 파이프의 비교 |

작업 폴더에서 `node run-probes.mjs`로 비용 없는 최종 시험을 실행한다. 취소만 재확인하려면 `node run-probes.mjs --cancel-only`를 사용한다. 실제 모델 호출은 자동 전체 시험에 포함하지 않는다. `live-probe.mjs`는 이번 측정 모델·설정이 명시된 관찰용 스크립트이며 재실행 전에 실행 파일과 모델 범위를 확인한다.

`live-probe.mjs`는 전역 설정 부작용을 재현한 원래 시험 코드다. 자동 복원 기능은 포함하지 않는다. 재실행할 경우 3.4절처럼 전후 변경을 확인해야 하며, 제품 실행기로 재사용하지 않는다.

## 5. 한계와 다음 작업

현재 환경의 최소 실행 가능성과 계약을 확인했다. W1(형식·DAG) 구현으로 진행할 수 있다. W4에서는 PID 재사용·이탈 프로세스·강제 종료·모든 보호 경로와 중계 프로세스의 수명 관리를 추가 검증해야 한다.

기존 npm 전체 시험은 서비스 소스를 변경하지 않아 이번 W0에서 다시 실행하지 않았다. 이전 116개 시험 결과를 신규 기능의 검증으로 계산하지 않았다. 다른 OS·Node 18.17·실제 복잡한 계획과 장시간 실행은 미검증이다.

Git commit, push, npm 게시, 새 workflow 활성화는 하지 않았다. 공유 계획 스킬은 이번에 재적용하지 않았으며 W0 근거는 이 작업 폴더에 보관한다.
