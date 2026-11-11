# 요구사항·계획·작업 결과·검토 근거 연결 보완안

- 저장소 사본 정리일: 2026-11-11 KST. 아래 외부 작업 기록은 이번 커밋에 포함하지 않는다. 해당 자료 없이 표본 준비·과거 실행 재검증을 완료한 것으로 판단하지 않는다.
- 검증 기록: validation-review-fixes.json의 sourceValidation은 이전 원본 문서 기준이고, repositoryValidation은 링크를 정리한 현재 저장소 사본 기준이다.
- 작성일·근거 기준: 2026-11-10 KST.
- 현재 상태: **설계 문서만 작성. 제품·시험 도구 구현, 실제 AI 호출, 개인 설정 적용 없음. 이번 Git 반영 범위는 이 폴더의 문서 6개뿐이다.**
- 기준 소스: agent-layers `5f2ec4c4a72847cc7314e207ae5e9930deb0b9c3`.
- 목적: 사용자 요구사항이 계획에서 누락되거나, 구현 결과와 검토 근거가 요구사항에 대응하지 않는 문제를 줄이는 방안을 정의한다.
- 다음 문서: [PLAN.md](PLAN.md). Luna·Terra 각각 3개 방식으로 비교할 표본·예산·판정·준비 기준을 정의한다.
- 이 문서의 `trace`, adapter, manifest와 추가 검사는 **제안**이며 현재 제품에 존재한다고 해석하지 않는다.

| 근거 이름 | 위치 | 확인할 부분 |
|---|---|---|
| 현재 계획 계약 | [planner-v2.md](../../../../templates/workflow/roles/planner-v2.md) | 원래 요구사항 보존, instruction·acceptance |
| 현재 결과 계약 | [result-format-v2.md](../../../../templates/workflow/result-format-v2.md) | Final message: 결과 본문 schemaVersion 1 |
| 형식 검사 | [schema.js](../../../../src/workflow/schema.js) | STEP_KEYS, RESULT_KEYS, validateRoleResult |
| 역할 간 전달 | [assignment.js](../../../../src/workflow/assignment.js) | buildHandoff: originalGoal·dependencies·해시 검사 |
| 저장 검증 | [store.js](../../../../src/workflow/store.js) | createRun·readRun의 contextHash 및 배정 검증 |
| Symbol 수정 근거 | 보완 기록 — 외부 작업 기록 `2026-11/2026-11-09/workflow-expanded-defect-kit/checks/t3-symbol-input-fix/README.md` | 재현과 검증 결과 |
| 최신 실제 시험 | 실행 결과 — 외부 작업 기록 `2026-11/2026-11-09/workflow-expanded-defect-kit/checks/t3-symbol-live/README.md` | 결과·동일 조건·실행 근거 |

| PART | 내용 |
|---|---|
| 1 | 현재 동작·문제·범위 |
| 2 | 요구사항과 단계별 연결 계약 |
| 3 | 검증·예외·호환성 |
| 4 | 도입 순서와 완료 기준 |

---
---
# PART 1 — 현재 동작과 보완 범위

## 1. 확인한 사실과 가설

| 구분 | 내용 |
|---|---|
| 현재 입력 | v2 workflow는 원래 목표, 단계 지시와 완료 조건, 선행 작업 요약·파일 해시·검사 결과를 전달한다 |
| 현재 계획 | Planner가 원문을 instruction·acceptance로 옮기지만, 원문 요구사항과 각 항목의 대응을 형식으로 강제하지 않는다 |
| 현재 응답 | summary·artifacts·findings·needsInput을 반환한다. 요구사항마다 처리 결과·검증 근거를 제출하는 필드는 없다 |
| 현재 검증 한계 | 문자열이 존재하고 계획 그래프가 유효하다는 사실은 모든 요구사항의 의미가 보존됐다는 증거가 아니다 |
| 관찰 사례 | T3 Luna의 이전 구현에서 enumerable Symbol을 누락했고, 기존 10개 검사도 이를 발견하지 못했다. 보강 검사는 수정 전 3건 실패를 재현했다 |
| 최신 관찰 | 이후 같은 T3 v2 계약의 새 실제 실행에서 Luna·Terra 모두 15/15를 통과했다. 새 연결 방식은 사용하지 않았으므로 연결 방식의 효과로 해석하지 않는다 |
| 검증할 가설 | 요구사항별 질문·결과·근거를 연결하면 누락·잘못된 완료 주장이 줄 수 있다. 계획 단계부터 연결하면 계획에서 시작된 누락도 줄 수 있다 |

계획 작성이 먼저라는 점이 핵심이다. 계획이 불완전한 상태에서 그 계획만 정확히 실행하고 검토하면 원래 요청을 충족하지 못할 수 있다. Reviewer·Auditor는 계획과 함께 원래 요구사항도 확인해야 한다.

## 2. 포함·제외 범위

포함 범위는 요구사항 원문 보존, 계획 대응, 결과 주장과 실행 증거 구분, 검토 판정, 재개 시 버전·해시 검증, 기존 형식과 공존하는 시험 설계다.

제외 범위는 모델 학습·모델 자동 교체, 새 제품 UI, 운영 DB, 병렬 실행 기능, 설정 배포, 기존 정책·실행 기록의 재작성이다. 요구사항 추출용 추가 AI와 별도 AI 채점자를 기본 구성에 넣지 않는다.

```mermaid
flowchart LR
    Source(["<b>사용자 요구사항</b><br/><small>원문 · 버전 · 번호</small>"])
    Plan(["<b>계획</b><br/><small>단계 · 완료 기준 · 검사 예정</small>"])
    Gate(["<b>계획 확인</b><br/><small>누락 · 의미 보존</small>"])
    Work(["<b>작업 결과</b><br/><small>요구사항별 처리 주장</small>"])
    Evidence(["<b>실행 근거</b><br/><small>코드 해시 · 검사 원본</small>"])
    Review(["<b>검토·감사</b><br/><small>원문 · 계획 · 결과 대조</small>"])
    Source ==> Plan
    Plan ==> Gate
    Gate ==> Work
    Work ==> Evidence
    Evidence ==> Review
    Source -.-> Review
    Plan -.-> Review
    classDef core fill:#e0f2fe,stroke:#0284c7,stroke-width:2.5px,color:#0c4a6e,rx:16,ry:16
    classDef context fill:#f3f4f6,stroke:#4b5563,stroke-width:2px,color:#1f2937,rx:16,ry:16
    classDef point fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#78350f,rx:16,ry:16
    classDef muted fill:#fafafa,stroke:#e5e7eb,stroke-width:1.5px,color:#9ca3af,rx:16,ry:16
    class Source,Evidence context
    class Plan,Work core
    class Gate,Review point
```

| 상태 | 요소 | 역할 |
|---|---|---|
| ⚫ 참조 `context` | 요구사항·실행 근거 | 실행기가 보존하는 원문과 실제 관측값 |
| 🔵 핵심 `core` | 계획·작업 결과 | AI가 작성하되 원문의 범위와 의미를 바꾸지 못하는 제안 |
| 🟡 분기 `point` | 계획 확인·검토·감사 | 형식 검사와 의미 판단을 구분하고 미확인 항목을 남김 |

---
---
# PART 2 — 연결 계약

## 3. 요구사항 기준표

실행 담당자가 원문에서 원자적 의무를 정리한 `requirements.json`을 작업 폴더에 준비한다. 모델이 기준표를 임의로 고치지 못한다. 시험에서는 표본 작성 담당자가 작성하고 원문 대조를 마친 뒤 동결한다. 실제 업무에서 의미가 바뀌는 분해·추가가 필요하면 사용자에게 그 부분만 확인한다.

| 필드 | 의미·검사 |
|---|---|
| documentVersion·sourceHash | 원문 버전과 SHA-256. 원문 변경은 새 버전·새 계획으로 처리 |
| id | 실행 안에서 유일한 `R-001` 같은 번호. AI가 새 필수 ID를 만들거나 번호를 바꾸지 못함 |
| sourceSpan·sourceQuote | 원문 UTF-8 바이트 구간과 정확한 인용. 인용과 구간이 원문에 일치해야 함 |
| obligation | 결과로 확인할 한 가지 의무. 인용을 대체하는 권위 있는 새 원문으로 사용하지 않음 |
| kind | behavior, rejection, preservation, scope, verification 중 하나 |
| applicability | required 또는 사용자 확인이 필요한 unresolved. AI 단독으로 제외 처리하지 못함 |
| verificationRefs | 공개 검사 또는 수동 확인 기준의 ID. 숨겨진 정답·witness는 포함하지 않음 |

하나의 원문 문장에 여러 의무가 있으면 같은 sourceSpan을 여러 행이 공유할 수 있다. 모든 글자에 번호를 붙일 필요는 없지만, 행동·금지·보존·오류 의무가 빠진 구간이 없는지 작성 담당자가 대조한다. 이 대조가 불완전하면 후속 ID 검사로 복구되지 않는다.

## 4. 단계별 제출 항목

| 단계 | AI가 제출할 내용 | 실행기·검토자가 확인할 내용 |
|---|---|---|
| 계획 | requirementId, stepIds, acceptance의 구체 조건, 예정 verificationRefs | 모든 required 행의 수행 단계·최종 확인 담당이 존재하는지, 금지 조건이 유지되는지 |
| 작업 | requirementId, 처리 결과, 변경 파일·심볼, 실행했다고 주장하는 검사 ID, 미완료 이유 | 현재 단계에 배정된 의무와 답이 대응하는지, 코드와 실행 기록이 주장에 맞는지 |
| Reviewer | requirementId, 원문·계획·결과별 판정, 문제 위치, 재현 조건, 근거 참조 | 계획 자체의 누락과 구현 오류를 구분하고 실제 문제인지 재현 |
| Auditor | 전체 required 행의 최종 상태, 근거의 코드 버전 일치, 미실행 항목 | 검토 이후 코드 변경으로 이전 증거가 오래되지 않았는지, 완료 주장에 빈틈이 없는지 |

계획의 검사는 `plannedVerification`, 작업·검토의 관측은 `observedEvidence`로 분리한다. 예정 검사 이름이 있다는 이유로 통과 근거를 만들지 않는다. 현재 단계가 담당하지 않는 요구사항은 `pending_other_step`으로 표시하고 최종 검토에서 해소한다.

시험의 B/C는 같은 결과 trace 형식을 사용한다. 각 Coder도 전체 required ID를 한 번씩 반환하되, 다른 단계의 의무는 pending_other_step으로 표시할 수 있다. C에서는 planTrace의 현재 단계 배정과도 대조한다. Reviewer·Auditor의 최종 응답에는 해결되지 않은 pending 행을 완료로 처리하지 않는다. A는 이 형식을 요구하지 않으며 구조 연결률을 0점으로 매기지 않는다.

| traceVersion 1의 필수 항목 | 제약 |
|---|---|
| traceVersion·stepId·attempt | 버전 1, 기존 요청과 일치하는 단계와 시도 번호 |
| rows[].requirementId | 기준표 required ID별 정확히 한 행. 미등록·중복 ID 거부 |
| rows[].claim·disposition | 구체적 처리 설명과 addressed/pending_other_step/blocked/exclusion_requested |
| rows[].verificationClaim | passed/failed/not_run. 실행기가 계산한 증거 상태와 분리 |
| rows[].evidenceRefs | 공개 check ID 또는 허용된 파일·심볼 참조. 빈 목록이면 검증 근거 없음 |
| rows[].reason | blocked·exclusion_requested·not_run의 이유. 임의 제외 승인 효과 없음 |

planTrace는 traceVersion 1과 requirements 배열을 가지며 각 required ID를 한 번씩 포함한다. 각 행은 requirementId, 비어 있지 않은 stepIds, acceptanceText, verificationRefs, finalVerifierRole을 갖는다. 전역 보존 의무는 관련 단계 전체에 연결하고 finalVerifierRole을 auditor로 둔다. 호출·manifest 해시는 모델이 만들지 않고 adapter가 원본 응답과 함께 기록한다.

다음은 질문과 응답을 함께 표시할 때의 **표현 예시**이며 실제 결과가 아니다. 질문 원문은 실행기가 기준표에서 붙인다.

| 요구사항 | 계획 | 작업 주장 | 실행 근거 | 최종 판정 |
|---|---|---|---|---|
| R-003: own enumerable 키는 value 하나 | keys 단계에서 입력 키 검사 | Symbol 키도 거부하도록 구현 | 검사 ID·원본 로그·해당 코드 해시 | 근거를 확인한 뒤 통과/실패/미확인 |
| R-004: 잘못된 입력에 효과 없음 | store 단계에서 상태 변경 전 검증 | TypeError를 동기 발생 | 오류와 apply 0회 재현 결과 | 같은 입력·코드 버전인지 확인 |

## 5. 주장과 근거의 소유권

| 데이터 | 작성 주체 | 신뢰 범위 |
|---|---|---|
| 사용자 원문·정책·요구사항 기준 | 사용자·실행 담당 | 승인된 범위. AI 답변으로 변경 불가 |
| 계획·구현 설명·검토 의견 | 해당 AI | 검증 대상인 주장 |
| 실제 명령·종료 코드·stdout/stderr·파일 해시 | 실행기 | 관측 사실. 명령의 검사 범위까지 증명하지는 않음 |
| 의미·누락·오탐 판정 | 원문과 재현을 확인한 담당자 | 근거·판정자·미확인 사항을 기록 |

AI의 `verificationClaim`은 passed/failed/not_run으로 받더라도 검증된 상태와 분리한다. 실행기는 허용 목록의 검사 ID를 실제 기록에 연결하고 `evidenceStatus`를 verified_pass/verified_fail/unverified/stale로 계산한다. 검사 명령·절대 경로·새 권한을 모델 응답에서 실행하지 않는다.

같은 검사 하나가 여러 의무를 검증할 수 있지만 그 범위는 사전 작성한 검사 대응표로 정한다. `core 통과`만으로 Symbol 의무까지 충족했다고 확대하지 않는다. AI가 직접 실행한 도구 로그는 보조 근거이며 완료 판정에는 실행기가 다시 실행한 고정 검사 또는 명시적으로 확인한 수동 근거를 사용한다.

---
---
# PART 3 — 검증과 호환성

## 6. 계획 확인과 완료 판정

| 확인 시점 | 기계적으로 확인할 것 | 의미를 확인할 것 |
|---|---|---|
| 기준표 동결 | ID 유일성·원문 인용·해시 | 원문 의무가 기준표에서 빠지지 않았는가 |
| 계획 수락 전 | required ID의 대응, 존재하는 단계·검사 ID, 범위·DAG | 완료 조건이 원문 의무를 실제로 충족하는가 |
| 결과 저장 전 | 응답 형식·ID·시도 번호·근거 참조, 저장 파일 범위 | 주장과 구현이 일치하는가 |
| 검토·감사 | 모든 필수 행의 판정, 검사·코드 버전 연결 | 번호만 채웠거나 근거가 다른 동작을 검사하지 않는가 |
| 재개 | 원문·정책·계획·결과·추가 기록 해시 | 새 요구사항을 이전 승인으로 처리하지 않는가 |

ID가 전부 있다는 사실은 의미 보존을 증명하지 않는다. 자동 검사 결과에 `structuralCoverage`와 `semanticAssessment`를 별도로 남긴다. 의미 판단이 끝나지 않았으면 unknown으로 유지한다. 모든 검사를 통과한 것처럼 표시하지 않는다.

제품 도입 시 완료 조건은 기존 성공 조건 AND 필수 요구사항의 근거 확인이다. 파일 변경이 있으면 그 파일에 의존하는 근거를 stale로 바꾸고 필요한 검사를 재실행한다. 현재 엔진의 SUCCEEDED를 외부 시험 도구가 덮어쓰지 않고, 시험에서는 `engineStatus`와 `evaluationVerdict`를 별도 기록한다.

## 7. 예외·변경 기준표

| 조건 | 처리 | 기록 |
|---|---|---|
| 요구사항 누락·알 수 없는 ID | 연결 형식 실패. 통과로 보정하지 않음 | 누락 ID·단계·원문 참조 |
| 요구사항이 모호하거나 충돌 | unresolved로 중단·질문. AI 임의로 기준 변경 금지 | 서로 충돌하는 인용과 질문 |
| 검토에서 계획 자체의 누락 발견 | 계획 보완·새 계획 대상으로 분류. Coder에 코드만 고치라고 전환하지 않음 | 원문 의무·빠진 계획 단계·재계획 사유 |
| AI가 not applicable 주장 | 제외 요청으로만 저장. 원문상 근거 또는 사용자 결정 필요 | 근거·결정 주체·시각 |
| 필수 검사가 미실행 | 미확인. 실행 예정과 실행 완료 구분 | 이유·필요한 검사 |
| 근거가 이전 코드 기준 | stale 처리 후 재검증 | 이전·현재 코드 해시 |
| 길이 제한 초과 | 누락 없이 실패 표시. 계획 분할은 새 계획으로 | 원래 길이·한도·실패 단계 |
| 요구사항·담당·정책 변경 | 기존 기록 보존, 새 계획 생성 | 이전 실행 참조·변경 이유 |
| 보호 파일·설정 변경 | 남은 호출 중단, 자동 원복 금지 | 관측한 차이·현재 상태 |

## 8. 기존 정책·실행 기록 호환성

현재 schemaVersion 2 정책·계획과 schemaVersion 1 역할 결과는 그대로 유지한다. 현재 validator는 새 최상위 필드를 거부하므로 `requirements` 필드를 기존 객체에 바로 추가하는 안은 채택하지 않는다.

**시험 단계의 권장안은 새 작업 폴더의 adapter와 별도 추가 기록이다.** 제품 소스는 동결하고 비교가 끝난 뒤 제품 도입을 판단한다.

| 역할·방식 | 제안하는 모델 출력 | 기존 엔진에 전달할 것 |
|---|---|---|
| A의 모든 역할, B의 Planner | 현재 계획·역할 결과 그대로 | 원문 그대로 |
| B·C의 Coder/Reviewer/Auditor | 하나의 JSON envelope: `roleResult`(현행 결과), `trace`(traceVersion 1) | roleResult만 현행 JSON으로 전달 |
| C의 Planner | 하나의 JSON envelope: `plan`(현행 v2 계획), `planTrace`(traceVersion 1) | plan만 현행 JSON으로 전달 |

adapter는 envelope 원본과 trace를 작업 폴더에 새 파일로 보존하고, 해시·역할·stepId·attempt·정책과 결합한다. 계획 전에는 jobId/callId로 결합하고 runId 생성 뒤 인덱스를 추가한다. 기존 기록의 해시를 바꾸거나 별도 데이터를 몰래 끼워 넣지 않는다. 엔진이 생성한 결과 해시와 adapter의 원문 해시는 서로 다른 값으로 보존한다.

계획 수락·저장이 끝난 뒤 A/B/C 모두의 Coder·Reviewer·Auditor에게 **각 실행의 확정된 계획 전체**를 같은 `confirmedPlan` 구조로 전달한다. 현재 엔진의 goal·평탄화된 acceptance·선행 결과 요약만으로 계획 전체가 전달된다고 보지 않는다. 계획 전 Planner 요청에는 아직 확정된 계획이 없으며, 계획 보정의 previousAnswer를 확정 계획으로 표시하지 않는다.

| 공통 전달 항목 | 출처·확인 규칙 |
|---|---|
| confirmedPlan.plan | 엔진이 저장한 plan.json 전체 객체. 모든 단계의 instruction, acceptance, dependsOn, writePaths, checkIds, agent와 프로그램 메타데이터를 생략 없이 포함 |
| confirmedPlan.runId·planHash | 실행기가 확인한 실행 ID와 현행 planHash. AI가 응답한 해시로 대체하지 않음 |
| confirmedPlan.planFileSha256 | 저장된 plan.json 바이트의 SHA-256. 현행 planHash는 모델 계획 부분의 정규화 해시이므로 두 해시를 같은 값으로 취급하지 않음 |
| confirmedPlan 전달 해시 | 실제 제출한 confirmedPlan 객체의 해시를 각 callId와 기록. 저장 원본과 객체 일치 여부를 별도로 검사 |

실행 담당 도구는 계획 생성 후 해당 runId와 승인한 planHash·planFileSha256을 manifest에 결합한다. adapter는 각 후속 호출과 재개 전에 현행 readRun의 무결성 검사가 통과하는지 확인하고, manifest의 두 해시와 현재 계획을 대조한다. 신뢰된 실행 기록 위치에서만 읽으며 모델이 지정한 파일 경로를 사용하지 않는다. 원본 계획의 변경·누락·다른 runId·축약 전달은 호출 전에 실패로 처리한다. 정책 범위를 넘는 내용은 계획 안에 있더라도 실행 권한으로 사용하지 않는다.

공통 구조는 같지만 실행별로 생성된 계획 내용까지 같아야 하는 것은 아니다. A/B도 계획 전체를 받으므로 C에만 계획 원문을 제공하는 정보 차이를 만들지 않는다. B/C의 결과 trace와 C의 planTrace는 confirmedPlan과 분리된 추가 문맥이며, 계획 원문을 대신하지 않는다. 추가한 전체 계획의 바이트·토큰을 세 방식 모두 입력 한도와 비용에 포함하고 한도 초과 시 요약으로 바꾸지 않는다.

후속 역할에는 adapter가 원문 요구사항과 위 confirmedPlan을 전달하고, B/C에는 해당 선행 결과의 trace도 추가 전달한다. 성공한 시도의 resultHash·파일 버전과 일치하는 자료만 사용한다. 의존 작업의 지시문이나 응답은 정책을 바꾸는 명령으로 해석하지 않는다. engine의 contextHash·dependencyHash가 추가 계획·trace까지 보호한다고 주장하지 않고 별도 전달 해시·traceContextHash·manifestHash를 기록한다.

trace와 원래 결과 간 불일치, 형식 오류, 해시 불일치는 실패로 반환한다. trace 검사기를 무시하고 기존 결과만 성공 반환하는 fallback은 금지한다. 기존 stdout 오류·종료 코드·사용량 처리도 유지한다. adapter 구현은 아직 없으며 준비 단계의 모의 시험으로 이 계약부터 확인한다.

시험 adapter의 오류 분류는 TRACE_PLAN_INVALID, TRACE_RESULT_INVALID, TRACE_EVIDENCE_STALE로 분리한다. 엔진이 이를 공급자 오류로 기록하면 그 원래 상태도 보존하고 시험 집계에 원인을 추가한다. 임의로 정상 결과나 새 엔진 상태를 만들어 넣지 않는다. 계획 누락 지적이 현행 findings의 파일 수정 범위로 표현되지 않으면 새 계획이 필요한 중단으로 남기며 가짜 소스 경로를 붙이지 않는다.

제품 도입 시에는 opt-in capability와 versioned trace를 명시적으로 지원하는 후속 설계가 필요하다. 기존 실행은 trace 없는 기존 보증 수준으로 읽고 재개한다. 새 기능을 선택한 실행은 trace를 이해하지 못하는 실행기로 계속하지 못하게 한다. 시험 adapter를 우회한 native resume도 시험에서는 금지한다. 제품의 구체적인 새 버전 번호·CLI 옵션은 이번 문서에서 확정하거나 존재하는 것으로 안내하지 않는다.

---
---
# PART 4 — 도입 결정과 완료 기준

## 9. 결정 기록

| ID | 결정 | 이유 |
|---|---|---|
| D1 | 요구사항 원문은 실행기가 표시 | AI가 질문을 바꿔 답하는 문제와 불필요한 원문 재생성을 줄임 |
| D2 | 계획 예정과 실행 관측을 분리 | 계획에 적힌 검사를 완료 근거로 오인하지 않음 |
| D3 | 원문·계획·결과를 검토자에게 함께 제공 | 잘못된 계획을 충실히 수행한 경우를 검출 |
| D4 | 번호·해시 검사와 의미 판단 분리 | 형식상 완전함을 실제 완전함으로 과장하지 않음 |
| D5 | 제품 변경 전에 외부 adapter로 시험 | 현행 JSON·v1/v2 기록·재개 계약을 보존하며 효과 측정 |
| D6 | 기본 AI 직접 작업 대비 우월성은 주장하지 않음 | 이번 비교는 workflow 내부의 전달 방식 차이만 검증 |

## 10. 준비 순서와 채택 조건

준비 순서는 비교용 요구사항 기준표 동결, adapter·trace validator의 모의 검증, 원문·계획 누락 및 정상 표본의 재현, 호출 예산·순서표 확정, 실제 호출 범위 승인, 시험 실행이다. 상세 수량과 중단 기준은 [PLAN.md](PLAN.md) 4~9절을 따른다.

문서 완료 기준은 요구사항→계획→작업→검토의 필수 연결, 의미 판단의 한계, 예외·호환성, 3개 방식의 비교 조건과 계산 가능한 예산이 모두 정의된 것이다. 구현 완료나 성능 향상은 이번 문서의 완료 조건이 아니다. 검토 지적 2건 반영 후 정적 확인 결과는 [validation-review-fixes.json](validation-review-fixes.json)에 남긴다. [validation.json](validation.json)은 수정 전 문서의 최초 확인 기록으로 보존하며 최신 검증으로 사용하지 않는다.

채택은 반복 시험에서 누락·오탐·잘못된 성공이 줄고 추가 토큰·시간·형식 오류가 감당 가능한지 확인한 뒤 결정한다. 특정 모델에서만 이득이 있으면 그 모델·과제에 한정한다.
