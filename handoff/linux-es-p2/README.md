# ES-P2 · Linux ARM64 전체 시험 결과

`feat/workflow-worktree-root`의 `97e1d8fbd6700ea0ca3417a6f958b6d490c70438`에서 전체 579개 중 568개가 통과했다. 실패와 취소는 0개이며 운영체제 조건으로 11개를 건너뛰었다. ES-P1보다 통과 4개, 건너뜀 1개가 늘어 예상과 일치했다.

| 확인 항목 | 결과 |
|---|---|
| 시험 대상 | 새 clone의 detached HEAD와 원격 브랜치 해시 일치 |
| 환경 | Linux aarch64 · Node.js v18.17.0 · npm 9.6.7 · Git 2.53.0 |
| 런타임 | ES-P1에서 사용한 Linux ARM64 공식 배포본 재사용. SHA-256 `fbd2904178ee47da6e0386bc9704a12b1f613da6ad194878a517d4a69ba56544` 일치 |
| 시험 명령 | clone에서 별도 프로세스 세션으로 `node --test` 실행 |
| 전달한 환경 변수 | HOME, TMPDIR, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, PATH |
| 격리 | 다섯 환경 폴더가 실행 전에 모두 비어 있었으며 TMPDIR과 그 realpath가 일치했다. |
| 종료 코드와 시간 | 0 · 351340.93268 ms |
| 종료 후 점검 | 시험이 띄운 잔여 Node 프로세스 0개. 제품 파일 변경 0개. |
| 기준 커밋 비교 시험 | 실패가 없어 생략 |

새 worktreeRoot 시험은 4개가 통과했고 Windows의 짧은 경로 시험 1개를 건너뛰었다. 원문에서 이름이 잘린 2개는 소스와 TAP에서 전체 이름을 확인했다.

- [새 시험 5개와 결과](new-tests.tsv)
- [건너뛴 시험 11개와 사유](skipped.tsv)
- [전체 TAP 출력](final-run/full.tap)
- [Node 종료 코드](final-run/exit-code)
- [결과 파일 SHA-256](SHA256SUMS)
