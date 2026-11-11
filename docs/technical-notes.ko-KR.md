# 설치, 클라이언트와 작업 이어가기

[English](technical-notes.md) · [简体中文](technical-notes.zh-CN.md) · [日本語](technical-notes.ja-JP.md) · [한국어](technical-notes.ko-KR.md)

[제품 소개로 돌아가기](../README.ko-KR.md)

설치 방식을 선택하고 구체적인 운영 자료를 찾을 때 사용하는 문서입니다. 자세한 연동 규칙은 각 클라이언트 안내와 설정 파일에서 확인할 수 있습니다.

## 설치 옵션

처음 설치하는 방법은 [README](../README.ko-KR.md#첫-프로젝트-시작하기)에 있습니다. Meta_Kim에는 Node.js 22.13.0+와 설정된 AI 클라이언트가 필요합니다.

| 선택 항목 | 사용하는 경우 |
| --- | --- |
| 전역 설치 | 여러 프로젝트에서 같은 기능을 재사용할 때 |
| 프로젝트 설치 | 프로젝트 전용 설정이 필요할 때. 비대화형 명령에서는 `--scope project` 지정 |
| 클라이언트 선택 | 사용할 클라이언트 선택. 일반 설치 대상은 `--targets`로도 명시 가능 |
| 전역 Hook | 선택한 클라이언트의 전역 Hook 연동이 필요하면 `--with-global-hooks` 추가 |
| 환경 확인 | `node setup.mjs --check`로 설치된 환경 확인 |

기존 설정은 병합되며 업데이트 시 Meta_Kim이 관리하는 파일을 기록합니다. CLI 작업 목록은 `node bin/meta-kim.mjs --help`로 확인할 수 있습니다. 저장소를 복제하지 않고 `npx --yes github:KimYx0207/Meta_Kim`으로 설치 프로그램을 시작할 수도 있습니다.

복제한 저장소는 `git pull --ff-only`, `node setup.mjs --update` 순서로 업데이트합니다. npx로 설치한 환경에서는 `npx --yes github:KimYx0207/Meta_Kim update`를 사용합니다.

## 클라이언트 안내

[Claude Code](../canonical/skills/meta-theory/references/runtime-claude.md) · [Codex](../canonical/skills/meta-theory/references/runtime-codex.md) · [Gemini CLI](../canonical/skills/meta-theory/references/runtime-gemini.md) · [ZCode](../canonical/skills/meta-theory/references/runtime-zcode.md)

[호환성 목록](../config/runtime-compatibility-catalog.json)은 Cursor, OpenClaw, Qoder와 Trae를 포함한 각 클라이언트의 형식과 현재 연동 단계를 기록합니다. Hook의 적용 범위는 호스트가 제공하는 이벤트에 따라 달라집니다. 자세한 차이는 [실행 환경 안내](../AGENTS.md)를 참조하세요. 의존 프로젝트의 지원 클라이언트는 해당 상위 프로젝트가 관리합니다.

## DeepSeek Harness

DSH는 별도의 관리 명령으로 설치하는 선택형 클라이언트 연동입니다. **Node.js 24.9.0+**가 필요하며 확인 대상 호스트 버전은 **DSH 0.2.2-rc.1**입니다.

Meta_Kim을 내려받은 디렉터리에서 실행합니다.

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

같은 Meta_Kim CLI의 `node bin/meta-kim.mjs dsh update`와 `node bin/meta-kim.mjs dsh uninstall`로 관리 대상 연동을 업데이트하거나 제거합니다. `--service-package /path/to/kim-service-dsh`를 추가하면 [Kim Service에서 만든 전문 패키지](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md)를 설치합니다. 프로젝트 설치에는 `--scope project --project-root /path/to/project`를 사용하며 완료 후 해당 프로젝트의 시작 명령이 표시됩니다.

[DSH 안내](../canonical/skills/meta-theory/references/runtime-dsh.md)에서 설정, 전체 방법 자료 로딩, MCP와 호스트 권한을 설명합니다. [검증 기록](verification/dsh-professional-quality-20261111.md)에는 설정, Skill 검색, 자료 전달과 MCP를 확인한 범위가 담겨 있습니다. 네이티브 작업 결과와 모델의 전문적인 품질은 실제 결과물로 평가합니다.

## 중단한 작업 이어가기

실행 기록은 결정 사항, 완료 결과물, 의존 관계와 남은 작업을 프로젝트에 보관합니다. 프로젝트를 옮기거나 작업을 다시 시작할 때도 이 기록을 함께 유지하세요. Live는 현재 실행을 읽어 작업과 해당 결과물 및 검사 결과를 연결합니다.

감독된 실행 경로에서는 성과가 없는 시도가 반복되면 해당 작업을 일시 중지하고 다음 검토 또는 복구 행동을 기록합니다. 독립 작업은 계속할 수 있습니다. 검토한 새 방식으로는 복구 시험을 진행합니다. 이전 쓰기 작업의 결과가 불확실하면 저장한 응답 기록과 대상의 현재 상태부터 대조합니다.

관련 흐름은 [의도에서 결과까지](../canonical/skills/meta-theory/references/intent-to-delivery.md), [구조](harness-architecture.md), [작업 시험 및 복구 기록](verification/task-scoped-canary-20261111.md)에서 설명합니다.

## 선택형 Memory 서비스

영속 실행 기록으로 프로젝트 작업을 이어 갑니다. Memory를 추가하면 선택한 정보를 세션 간에 저장하고 검색할 수 있습니다. 활성화했다면 실제로 설정한 서비스 주소를 확인하세요.

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

이 엔드포인트는 서비스 접속 여부를 확인합니다. 쓰기, 읽기와 회상이 필요한 작업에서는 설정한 서비스로 해당 동작도 확인하세요. `npm run meta:test:mcp`는 Meta_Kim 자체 MCP 서버를 검사합니다.

## 소스와 생성 파일

공통 Agent, Skill과 실행 리소스는 `canonical/`에서, 기계가 읽는 설정은 `config/`에서 관리합니다. `.claude/`, `.codex/`, `.cursor/` 같은 클라이언트별 디렉터리는 `npm run meta:sync`로 로컬에 생성합니다. 생성물은 `.gitignore`로 GitHub 소스에서 제외하고 로컬에 유지하며, 배포 패키지에는 공통 원본 소스를 포함합니다.

## 프로젝트 기록 살펴보기

| 확인할 내용 | 참고 자료 |
| --- | --- |
| 설치 프로그램이 받는 인수 | [설치 진입점](../setup.mjs) · [CLI](../bin/meta-kim.mjs) |
| 사용할 수 있는 클라이언트 연동 | [호환성 목록](../config/runtime-compatibility-catalog.json) |
| 설계와 전문 자료가 실행자에게 전달되는 과정 | [의도에서 결과까지](../canonical/skills/meta-theory/references/intent-to-delivery.md) |
| 공개한 버전의 변경 내용 | [변경 기록](../CHANGELOG.ko-KR.md)과 연결된 기록 |
| 소스 유지 관리 방법 | [개발 안내](../AGENTS.md) |
