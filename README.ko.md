# agent-layers

여러 AI 코딩 에이전트의 설정을 git 저장소 하나에 모아 두고, 어느 PC에서든 명령 한 번으로 같은 환경을 구성하는 도구입니다.

- **base 레이어**: 모든 PC에 따라가는 개인 설정입니다. 작업 규칙, 스킬, 슬래시 명령, MCP 서버, 도구별 설정이 여기에 들어갑니다.
- **project 레이어**: 프로젝트 폴더 하나에만 적용하고, 프로젝트가 끝나면 폐기하는 설정입니다.
- **PC 전용 값**: 경로와 비밀값처럼 PC마다 다른 값입니다. 저장소에는 들어가지 않습니다.

원본 하나를 Claude Code, OpenAI Codex, Gemini CLI, Google Antigravity, GitHub Copilot, Cursor, OpenCode, Zed, Junie, Kiro, Amp, Factory Droid, Devin, Qwen Code, Cline, Goose가 각자 읽는 파일 형식으로 변환합니다. 에이전트가 스스로 다시 쓰는 파일(`~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.claude.json`)은 통째로 덮어쓰지 않고, agent-layers가 관리하는 키와 블록만 병합합니다.

외부 의존성은 없고 Node.js 18.17 이상에서 동작합니다. Windows, macOS, Linux, WSL을 지원합니다.

처음 쓰는 분은 [처음 사용자 가이드](docs/GUIDE.ko.md)부터 읽으십시오. 설치부터 매일 쓰는 방법까지 순서대로 정리되어 있습니다.

## 해결하는 문제

| 문제 | agent-layers의 처리 방식 |
|---|---|
| 에이전트마다 지시문, 스킬, MCP 서버를 읽는 위치와 형식이 다르다 | 중립 형식의 원본 하나를 도구별 형식으로 변환한다 (AGENTS.md, Claude rules, GEMINI.md, Copilot instructions, Cursor `.mdc`, Kiro steering 등) |
| 개인 설정에 PC 경로와 고객사 정보가 섞여 있다 | team/org, 개인 base, project, PC 전용 값의 4단계 레이어로 나눈다 |
| 설정 파일에 `C:\Users\me\...` 같은 절대 경로가 들어 있다 | `{{home}}`, `{{homeSlash}}`, `{{os}}`, `{{vars.x}}` 변수와 운영체제별 파일(`name@windows.ext`)로 대체한다 |
| `.mcp.json`에 MCP 비밀번호가 평문으로 들어 있다 | `${secret:NAME}`으로 적고 값은 OS 키체인에 둔다. 변환할 때 환경 변수 참조로 바꾸거나, 서버가 시작될 때 `agent-layers exec`가 주입한다 |
| 에이전트가 설정 파일을 다시 써서 심볼릭 링크나 파일 통째 동기화가 깨진다 | 관리 블록과 관리 키만 고치고, 바깥에서 바뀐 부분을 감지하고, 고치기 전에 백업한다 |
| 프로젝트가 끝나도 고객사 정보가 PC에 남는다 | `project purge`가 생성한 파일과 에이전트의 프로젝트별 대화 기록, 메모리, 세션을 지운다 |

## 동작 방식

```mermaid
flowchart LR
  T["team 레이어<br/>(extends)"] --> M{"agent-layers<br/>plan / apply"}
  B["base 레이어<br/>개인, 모든 PC"] --> M
  P["project 레이어<br/>프로젝트 하나"] --> M
  L["PC 전용 값<br/>~/.agent-layers/config.jsonc<br/>OS 키체인 비밀값"] --> M
  M --> U["홈 폴더<br/>~/.claude ~/.codex ~/.gemini<br/>~/.copilot ~/.agents ..."]
  M --> R["프로젝트 폴더<br/>AGENTS.md, .claude/rules,<br/>.agents/, .github/, .cursor/ ..."]
  style T fill:#1f3a5a,stroke:#63a8f0,color:#e3f0fd
  style B fill:#1f4a30,stroke:#5ddb8f,color:#eafaf0
  style P fill:#4a3a12,stroke:#f5c542,color:#fdf3d8
  style L fill:#4a3018,stroke:#f59b4a,color:#fdeadb
  style M fill:#1f3a5a,stroke:#63a8f0,color:#e3f0fd
  style U fill:#1f4a30,stroke:#5ddb8f,color:#eafaf0
  style R fill:#4a3a12,stroke:#f5c542,color:#fdf3d8
```

agent-layers가 쓰는 내용은 아래 세 가지 중 하나이며, 무엇을 썼는지 `~/.agent-layers/state.json`에 기록합니다.

| 종류 | 예 | 소유 범위 |
|---|---|---|
| 소유 파일·폴더 | `~/.claude/rules/agent-layers/00-core.md`, `~/.agents/skills/<name>/` | 파일 전체 |
| 관리 블록 | `~/.codex/AGENTS.md` 안의 `<!-- agent-layers:begin base -->` | 블록만 소유하고 파일의 나머지는 보존 |
| 관리 키 | `~/.gemini/settings.json`의 `mcpServers.<name>`, `config.toml`의 `[mcp_servers.<name>]` | 해당 키만 소유하고 다른 키와 표는 보존한다. TOML 주석은 보존하고, 주석이 있는 JSON 파일은 `--force` 없이는 다시 쓰지 않는다 |

마지막 적용 뒤에 바깥에서 바뀐 경우(**drift**)와, agent-layers가 소유하지 않은 파일이 이미 있는 경우(**conflict**)는 `--force`를 주기 전까지 건너뜁니다. `--force`로 덮어쓸 때는 원본을 `~/.agent-layers/backups/`에 먼저 백업합니다.

## 시작하기

```sh
# CLI 설치
npm install --global agent-layers

# 템플릿으로 새 설정 저장소 만들기
agent-layers init
agent-layers doctor          # 설치된 에이전트, 위험한 설정, 평문 비밀값 점검
agent-layers plan --diff     # 미리 보기 (아무것도 쓰지 않음)
agent-layers apply           # base 레이어 적용 (확인을 받은 뒤 씀)

# 새 PC에서 기존 저장소 가져오기
agent-layers init --from https://github.com/you/my-agent-layers.git
agent-layers secrets check   # 이 PC에 아직 없는 비밀값 확인
agent-layers apply
```

git과 Node.js 설치까지 하는 부트스트랩 스크립트는 `install/install.ps1`(winget 사용)과 `install/install.sh`(Homebrew 또는 기존 Node.js 사용)입니다. 실행하기 전에 내려받아 내용을 확인하십시오.

이 PC에 이미 있는 설정을 base 레이어로 가져올 수도 있습니다.

```sh
agent-layers import --from claude,codex,gemini,copilot
```

가져올 때 홈 폴더 절대 경로는 `{{home}}`으로 바뀌고, 평문 비밀번호는 `${secret:NAME}` 참조로 바뀝니다.

## 설정 저장소 구조

```text
agent-layers.jsonc            대상 에이전트, extends, 변수, 옵션
base/
  instructions/*.md          항상 적용되는 규칙. front matter에 "paths:"를 쓰면 경로 한정 규칙
  instructions/*.md.tmpl     {{변수}}가 들어간 규칙
  skills/<name>/SKILL.md     Agent Skills (agentskills.io)
  commands/*.md              $ARGUMENTS를 쓰는 슬래시 명령
  agents/*.md                서브에이전트 (Claude 형식)
  mcp/*.jsonc                중립 형식의 MCP 서버 정의
  settings/<agent>.json|toml 키 단위 설정 (claude.json, codex.toml, gemini.json 등)
  files/<agent>/...          에이전트 홈 폴더로 복사할 파일 (홈 폴더 자체는 files/home/...)
projects/<name>/
  project.jsonc              모드, 프로젝트 판별 규칙, 변수, 메모리, 폐기 옵션
  instructions/ skills/ commands/ agents/ mcp/ settings/ files/project/
```

다른 설정 저장소의 프로젝트는 `extends`의 `projects` 필드로 가져옵니다. 자세한 내용은 [가이드](docs/GUIDE.ko.md)의 "다른 설정 저장소의 프로젝트 가져오기"를 봅니다.

## 지원 에이전트

| 에이전트 | 사용자 지시문 | 사용자 스킬 | 사용자 MCP | 프로젝트 파일 |
|---|---|---|---|---|
| `claude` Claude Code | `~/.claude/rules/agent-layers/*.md` | `~/.claude/skills` | `claude mcp add-json -s user` | `AGENTS.md`, `.claude/rules`, `.mcp.json` |
| `codex` Codex | `~/.codex/AGENTS.md` (블록) | `~/.agents/skills` | `~/.codex/config.toml` | `AGENTS.md`, `.codex/config.toml` (`developer_instructions`) |
| `gemini` Gemini CLI | `~/.gemini/GEMINI.md` (블록) | `~/.agents/skills` | `~/.gemini/settings.json` | `AGENTS.md`, `.gemini/settings.json` |
| `antigravity` Antigravity | `~/.gemini/GEMINI.md`, `~/.gemini/config/rules` | `~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills` | `~/.gemini/config/mcp_config.json` | `.agents/rules`, `.agents/skills`, `.agents/mcp_config.json` |
| `copilot` Copilot CLI·VS Code | `~/.copilot/copilot-instructions.md`, `~/.copilot/instructions` | `~/.agents/skills` | `~/.copilot/mcp-config.json` | `AGENTS.md`, `.github/instructions`, `.mcp.json` |
| `cursor` Cursor | 계정 설정 화면에서만 가능 | `~/.agents/skills` | `~/.cursor/mcp.json` | `.cursor/rules/*.mdc`, `.cursor/mcp.json` |
| `opencode`, `zed`, `junie`, `kiro`, `amp`, `factory`, `devin`, `qwen`, `cline`, `goose` | 각 도구의 전역 지시문 파일 | `~/.agents/skills` 또는 도구별 폴더 | 일부 지원 | `AGENTS.md` 또는 도구별 규칙 폴더 |

`agent-layers agents`를 실행하면 이 PC 기준으로 계산된 실제 경로를 볼 수 있습니다.

⚠️ 일부 에이전트는 공급사 문서에 macOS·Linux 경로만 있고 Windows 경로가 없습니다. 이런 경로는 확인되지 않은 값으로 취급하십시오.

## 비밀값

```sh
agent-layers secrets set github/token      # 화면에 표시하지 않고 입력받아 OS 키체인에 저장
agent-layers secrets check                 # 이 PC에 없는 비밀값 확인
```

| 설정이 놓이는 곳 | `${secret:NAME}`을 변환하는 방식 |
|---|---|
| 커밋되는 공유 프로젝트 파일 | 에이전트별 환경 변수 참조 문법으로 쓴다 (`${VAR}`, `${env:VAR}`, Codex `env_vars`·`bearer_token_env_var`) |
| 홈 폴더 또는 비공개 프로젝트 파일의 stdio 서버 | `node agent-layers exec --env KEY=@@secret:NAME@@ -- <서버 명령>`으로 감싼다. 값은 서버가 시작될 때 키체인에서 읽고 디스크에 쓰지 않는다 |
| 홈 폴더의 HTTP 서버 | 에이전트가 환경 변수 참조를 지원하면 참조로 쓴다. 지원하지 않으면 그 에이전트에는 경고와 함께 쓰지 않는다. `options.secrets.mode`를 `"materialize"`로 바꾼 경우에만 그 PC 전용 파일에 값을 쓰고, `plan` 출력에서는 값을 가린다 |

지원하는 저장소는 Windows 자격 증명 관리자, macOS 키체인, libsecret(`secret-tool`), 1Password(`secrets.map`의 `op://` 참조), CI용 일반 파일입니다. `AGENT_LAYERS_SECRET_<NAME>` 환경 변수가 있으면 그 값을 먼저 씁니다.

## 프로젝트

```sh
agent-layers project init acme --mode private --remote "github.com/acme/*"
agent-layers project apply            # 프로젝트 폴더 안에서 실행하면 git remote나 폴더 이름으로 프로젝트를 찾는다
agent-layers project purge acme       # 프로젝트가 끝났을 때 실행한다
```

- **private** 모드는 git이 추적하는 파일을 고치지 않습니다. `.claude/rules/agent-layers/project-<이름>.md`, `.agents/rules/`, `.github/instructions/`, `.cursor/rules/`, Codex `developer_instructions` 같은 로컬 파일만 만들고, 그 목록을 `.git/info/exclude`에 넣습니다. 고객사 저장소에서는 이 모드를 씁니다.
- Claude Code용 개인 규칙을 `CLAUDE.local.md`에 쓰지 않는 이유는, 그 파일이 있으면 Claude Code가 저장소의 `AGENTS.md`를 읽지 않기 때문입니다.
- **shared** 모드는 커밋할 수 있는 파일을 만듭니다. `AGENTS.md` 블록, 에이전트별 경로 한정 규칙, 환경 변수 참조를 쓴 `.mcp.json`이 여기에 해당합니다.
- `"memory": { "claude": "project" }`를 지정하면 Claude Code 자동 메모리가 프로젝트 폴더 안에 저장되어, 프로젝트를 폐기할 때 함께 지워집니다.
- `project purge`는 등록되지 않은 프로젝트 이름을 거부하고, 이 PC에서 적용한 적이 없는 프로젝트는 `--path`를 요구합니다. 드라이브 루트나 홈 폴더를 포함하는 폴더는 거부하며, 지우는 파일의 백업을 남기지 않습니다(그 프로젝트 파일의 이전 백업도 함께 지웁니다).
- `project purge`는 agent-layers가 쓴 파일과, 그 폴더에 대한 에이전트의 로컬 데이터를 지웁니다. Claude 대화 기록과 메모리(또는 `claude purge`), Gemini CLI `tmp/`·`history/`, Antigravity 프로젝트 설정, Codex 세션 기록, Copilot 세션 상태가 대상입니다. Codex 전역 메모리와 클라우드에 동기화된 세션은 직접 확인하도록 목록만 보여 줍니다.

## 명령

| 명령 | 용도 |
|---|---|
| `init [dir] [--from url]` | 설정 저장소를 만들거나 복제하고, 이 PC에 등록한다 |
| `doctor` | 환경, 설치된 에이전트, 평문 비밀값, Codex 설정의 잘못된 키 위치, Zed와 Copilot 파일 우선순위를 점검한다 |
| `agents` | 지원 에이전트와 이 PC 기준 경로를 보여 준다 |
| `plan [--diff] [--all]` / `apply [--yes] [--force] [--prune]` | base 레이어를 미리 보거나 적용한다. `--prune`을 주면 더 이상 선택하지 않은 에이전트의 산출물도 지운다 |
| `sync` | 설정 저장소(와 team 레이어)를 `git pull --ff-only`한 뒤 적용한다 |
| `status` | 관리 중인 파일과 바깥에서 바뀐 항목을 보여 준다 |
| `show [layer] [--json]` | 레이어별로 들어 있는 규칙·스킬·MCP 서버·설정 키·파일과 받는 에이전트를 보여 준다. 프로젝트는 한 줄 요약으로 보여 준다 |
| `project list / init / detect / plan / apply / purge` | project 레이어를 다룬다 |
| `secrets list / check / set / get / delete` | 비밀값을 다룬다 |
| `exec --env K=V -- cmd` | 비밀값을 주입해서 명령을 실행한다 |
| `import` | 이 PC에 있는 사용자 설정을 가져온다 |
| `validate [--strict]` | 설정 저장소를 검사한다 (CI에서 사용) |
| `uninstall` | agent-layers가 쓴 내용을 모두 지운다 |

공통 옵션은 `--only a,b`, `--skip a,b`, `--source <dir>`, `--home <dir>`(임시 홈 폴더로 시험), `--json`입니다.

## MD 검토와 검증 룰 관리

`validate`는 설정 형식을 검사합니다. `review`는 설정 원본의 `instructions/`, `skills/`,
`commands/`, `agents/` 아래 `.md`와 `.md.tmpl`을 읽고 정적 검사 결과와 AI 검토 대상을 만듭니다.
base, extends, 프로젝트 레이어를 포함합니다. 배치된 홈 폴더 파일을 수정하거나 자동 삭제하지 않습니다.

```sh
agent-layers review --source ./my-agent-layers
agent-layers review --source ./my-agent-layers --json
agent-layers review --source ./my-agent-layers --packet --json > review-packet.json
agent-layers review check --source ./my-agent-layers --input ai-result.json
```

설치하지 않고 소스에서 실행할 때는 `agent-layers`를 `node bin/agent-layers.js`로 바꾸십시오.
`--source`에는 프로그램 소스가 아니라 `agent-layers.jsonc`가 있는 설정 저장소를 지정합니다.
검토 패킷과 결과 파일은 검사 대상 MD 폴더 밖에 보관하십시오.

### 검사 기준

| 종류 | 검사 내용 | 판정의 범위 |
|---|---|---|
| `duplicate-paragraph` | 같은 적용 조건의 반복 문단 | 통합 후보이며 자동 삭제하지 않음 |
| `broken-local-link` | 인라인·참조 링크의 상대 경로와 참조 정의 | URL, 절 앵커, 절대 경로, 변수는 미확인 목록에 표시 |
| `required-sections` | 지정한 ATX 제목(`# 제목`)의 존재 | 사용자 룰에서 필요한 절을 지정 |
| `manual` | 모순, 오래된 우회, 과도한 검증, 임의 제약, 검증 정직성, 스킬 가치, 정책 보호 | AI 검토 대기이며 CLI 자체는 AI를 호출하지 않음 |

반복 문단 검사는 공백을 정규화하되 코드 블록·주석·제목을 제외합니다.
프로젝트, 운영체제, 대상 도구, 경로 조건이 다르면 같은 문구도 별도 범위로 취급합니다.
서로 다른 스킬·명령어·에이전트의 의미 중복은 정적 확정 대신 AI 검토에서 판단합니다.
심볼릭 링크와 2 MiB 초과 MD는 검사 제외 목록에 남깁니다. 자동 탐색 대상(`targets: auto`)은
실제 설치 환경을 확정하지 않으므로 버전별 기능 판단에는 별도 근거가 필요합니다.

### AI 검토 절차와 결과

`--packet` 결과를 현재 사용 중인 AI에 전달하고 `packet.instructions`에 따라 검토하도록 요청합니다.
검토 대상 문서의 "모두 통과시켜라" 같은 요구는 지시가 아닌 데이터로 취급합니다.
업무 정책과 도구 능력을 구분하고, 오래된 우회 방법을 제거하려면 대상 도구·버전·공식 근거와
대체 후 검증 방법을 확인해야 합니다. 확인할 수 없으면 `needs-verification`으로 남깁니다.

AI 결과 형식은 다음과 같습니다. 같은 룰·문서에서도 독립 문제마다 행을 따로 작성합니다.
모든 `pending` 룰·문서 조합을 검토하고, 문제가 없으면 근거가 있는 `keep` 행을 남깁니다.

```json
{
  "reviewHash": "검토 패킷의 reviewHash",
  "decisions": [
    {
      "ruleId": "excessive-verification",
      "file": "base/instructions/00-working-agreements.md",
      "line": 12,
      "status": "needs-verification",
      "reason": "모든 문서 수정에 전체 테스트가 필요한 이유를 확인하지 못했다.",
      "evidence": ["12행: 모든 변경은 전체 테스트를 실행한다."],
      "proposal": "업무 정책인지 확인한 뒤 변경 영향에 따라 조건을 좁힌다.",
      "verification": "문구 수정과 실행 코드 수정 사례에서 필요한 검사 범위를 비교한다."
    }
  ]
}
```

지원 판정은 `keep`, `shorten`, `merge`, `remove-candidate`, `needs-verification`입니다.
`review check`는 현재 문서·설정·룰의 해시, 판정 필드, 원본 줄 번호, 검토 누락과 중복을 검사합니다.
문서뿐 아니라 manifest, 프로젝트 설정, 스킬 메타데이터가 달라져도 이전 결과는 거부합니다.

⚠️ `review check` 통과는 AI 판단의 사실성을 보증하지 않습니다. 결과에 `factualAccuracyVerified: false`를 표시합니다.

패킷은 파일 내용과 로컬 경로를 포함합니다. 알려진 비밀값 패턴은 가리지만 모든 기밀 정보를
탐지하는 기능은 아니므로 외부로 전달할 때 내용을 확인하십시오. 프로그램은 외부 전송을 하지 않습니다.

### 룰 조회·추가·수정

기본 룰은 프로그램에 포함됩니다. 설정 저장소의 `review-rules.jsonc`에 같은 ID의 룰을 적으면
기본 룰을 대체하고, 새 ID는 추가합니다. 파일이 없거나 `rules: []`이면 기본 룰을 사용합니다.
사용자 룰은 필수 필드를 모두 적습니다. 기본 룰에 대한 재정의를 지우면 기본값으로 돌아가므로,
끄려면 `enabled: false`를 사용하십시오.

```sh
agent-layers review rules list
agent-layers review rules validate
agent-layers review rules disable duplicate-paragraph
agent-layers review rules disable duplicate-paragraph --write
agent-layers review rules enable duplicate-paragraph --write
agent-layers review rules add verification-headings --input new-rule.json
agent-layers review rules add verification-headings --input new-rule.json --write
agent-layers review rules update verification-headings --input changed-rule.json --write
```

`--source`는 위 명령 모두에 사용할 수 있습니다. 변경 명령은 기본적으로 전후 룰과 검토 결과의 차이만
출력합니다. `--write`를 주고 확인해야 룰 파일을 저장합니다. 터미널 없는 자동화에서는
`--write --yes`가 필요합니다. MD·에이전트 설정·state.json은 쓰지 않습니다.

`new-rule.json` 예시:

```json
{
  "id": "verification-headings",
  "title": "검증 절차의 필수 항목",
  "kind": "required-sections",
  "enabled": true,
  "scopes": ["instructions", "skills"],
  "criteria": "검증 절차에는 대상과 통과 조건을 명시한다.",
  "parameters": { "headings": ["검증 대상", "통과 조건"] },
  "exceptions": [
    { "path": "base/instructions/00-working-agreements.md", "reason": "검증 절차가 아닌 공통 작업 규칙이다." }
  ],
  "evidence": ["팀에서 합의한 검증 문서 형식"],
  "lastReviewed": null,
  "reviewAfterDays": 180
}
```

| 필드 | 의미 |
|---|---|
| `id`, `title` | 고유 식별자와 표시 이름 |
| `kind`, `parameters` | 실행할 검사 종류와 매개변수 |
| `criteria` | 판단 기준 설명; 정적 검사의 실행 조건은 `kind`·`parameters`로 정함 |
| `scopes` | `instructions`, `skills`, `commands`, `agents` 중 적용 대상 |
| `exceptions` | 경로에 따른 생략 예외와 이유 |
| `evidence` | 룰을 만든 근거 문자열 배열 |
| `lastReviewed`, `reviewAfterDays` | 마지막 검토일(`YYYY-MM-DD` 또는 `null`)과 재검토 주기 |

`duplicate-paragraph`에는 `parameters.minCharacters` 양의 정수를 지정합니다.
`required-sections`에는 `parameters.headings` 배열을 지정하고, 나머지 종류는 `{}`를 사용합니다.
사용자 코드·정규식·셸 명령을 룰로 실행하지 않습니다.

예외 경로는 출력에 나오는 문서 ID를 기준으로 합니다. 예: `base/skills/**`,
`project:example/instructions/*.md`, `extends:team/instructions/**`.
`*`는 경로 한 단계, `**`는 여러 단계, `?`는 경로 구분자를 제외한 한 글자입니다.
예외에 걸린 룰과 사유는 결과에 남습니다. 검토일이 없거나 주기가 지나도 자동 삭제·비활성화하지 않습니다.

룰을 저장하면 JSONC 주석과 서식은 정규화되며, 기존 파일은 같은 폴더의 `.bak` 파일에 원래 바이트로 보관됩니다.
미리보기 뒤 파일이 바뀌었거나 쓰기 경로에 심볼릭 링크가 있으면 저장을 거부합니다.

### 룰 변경 비교와 종료 코드

```sh
agent-layers review --compare candidate-rules.jsonc --json
agent-layers review --rules candidate-rules.jsonc --json
agent-layers review --strict
```

후보 설정은 `{ "version": 1, "rules": [...] }` 형식입니다. `--compare`는 현재 설정과 후보 설정을
각각 적용해 추가·제거되는 발견 항목을 보여 주며 저장하지 않습니다. `--rules`로 지정한 파일은
조회·검토에만 사용하고 변경 명령은 `--source` 아래 기본 룰 파일에만 저장합니다.

일반 `review`는 검사가 실행되면 발견 사항이나 검토 대기가 있어도 종료 코드 0을 반환합니다.
`--strict`는 발견 사항, AI 검토 대기, 검사 제외, 미확인 링크, 룰 재검토 알림 또는 문서 부재가 있으면 1입니다.
`review check`는 형식 오류나 검토 누락이 있으면 1이며, `needs-verification` 판단도 제출된 검토 결과로 셉니다.
읽기·설정 해석 오류는 실패로 종료합니다.

## 다른 도구와 비교

| 도구 | 강점 | agent-layers가 채우는 부분 |
|---|---|---|
| rulesync, ruler | 지원 에이전트가 많고 프로젝트 규칙 생성에 강하다 | 개인 전역 레이어(ruler에 없음), PC 전용 값, 비밀값, 에이전트가 다시 쓰는 파일에 대한 키 단위 병합, 프로젝트 폐기 |
| Microsoft APM | 매니페스트와 잠금 파일, Windows 설치 지원 | 프로젝트별 지시문 레이어, 고객사용 비공개 모드 |
| chezmoi | dotfiles, 템플릿, 비밀번호 관리자 연동 | 에이전트별 형식과 위치에 대한 지식 |
| dotagents (iannuttall) | `.agents` 폴더 하나를 에이전트 6종에 심볼릭 링크로 연결하고, 전역·프로젝트 범위와 백업을 지원한다 | 링크 대신 키 단위 병합, MCP 서버와 에이전트 설정, 비밀값, PC 전용 값, 프로젝트 폐기 |
| agentrig | Agent Plugins v1 패키지(스킬, MCP)를 Claude Code·Codex·Cursor에 설치하고 공유한다 | 항상 적용되는 지시문 파일, 에이전트 설정, 키체인 비밀값, PC 전용 값 |
| Claude Code 플러그인, claude.ai 동기화 | 스킬·명령·MCP를 공식 경로로 배포한다 | CLAUDE.md와 rules를 실을 수 없고 Claude 전용이다 |

agent-layers는 이 도구들과 함께 쓸 수 있습니다. 예를 들어 스킬은 Claude 플러그인 마켓플레이스로 배포하고, agent-layers 설치는 chezmoi에 맡길 수 있습니다.

## 개발

```sh
npm test        # node --test, 의존성 없음
```

테스트는 모든 명령을 임시 홈 폴더(`--home`)에서 실행합니다. git 저장소를 쓰는 프로젝트 테스트와, 주석과 다른 표를 보존하는 TOML 편집기 테스트가 포함되어 있습니다.

## 상태

프로토타입(0.1.1)입니다. npm 패키지 이름은 `agent-layers`입니다. 설치하지 않고 `npx agent-layers`로 실행하거나, 저장소를 내려받아 `node bin/agent-layers.js`로 실행할 수 있습니다.
