# ES-P1 Linux ARM64 전체 시험

전체 574개 중 564개가 통과했고 10개가 운영체제 조건으로 건너뛰어졌다. 실패와 취소는 0개다. 요청한 22개 중 Windows 전용 1개를 제외한 21개가 통과했다.

대상 브랜치 `feat/workflow-env-and-scope`에서 pull 결과는 `Already up to date.`였다.
detached HEAD와 원격 브랜치 모두 `f08516fd221acbb5b0e0acd7dff8e9d4574ae53e`였다.
origin/main은 `0623bc2aaee60acb28782673d1befcfa00204e32`이며 대상 브랜치에 커밋이 4개 더 있다.

- Linux aarch64, Node.js v18.17.0, npm 9.6.7, git version 2.53.0
- LR-P1 런타임 SHA-256 일치 `fbd2904178ee47da6e0386bc9704a12b1f613da6ad194878a517d4a69ba56544`
- 환경 변수 이름은 PATH, HOME, TMPDIR, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME이다.
- 전체 출력은 [final-run/full.tap](final-run/full.tap), Node 종료 코드는 [final-run/exit-code](final-run/exit-code)에 있다.
- [요청한 22개 시험](new-tests.tsv)과 [건너뛴 시험과 사유](skipped.tsv)는 TAP 결과를 기준으로 작성했다.
- [추가 시험 선언](added-tests.txt)은 e349ea3과 HEAD를 비교한 결과다.

```text
1..556
# tests 574
# suites 0
# pass 564
# fail 0
# cancelled 0
# skipped 10
# todo 0
# duration_ms 332046.954145
```

첫 샌드박스 실행은 자식 Git 프로세스가 EPERM으로 차단됐다. 진단 출력은 diagnostic.tap에 있다.
두 번째 실행은 전체 TAP 집계를 남겼으나 바깥 셸이 종료 코드 143으로 종료됐다.
최종 실행에서는 별도 프로세스 세션에서 Node의 종료 코드를 직접 수집했다.
최종 종료 코드 0. 최초 샌드박스 실행에서 남은 Node 5개를 확인하고 종료했다. 정리 후 잔여 Node 0개. 시험용 clone 삭제 확인.
