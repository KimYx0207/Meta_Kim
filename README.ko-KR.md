<div align="center">

# 元 · Meta_Kim

**하나의 아이디어에서, 이어서 협업하고 확인할 수 있는 결과까지.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

[![GitHub 스타](https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&label=%EC%8A%A4%ED%83%80)](https://github.com/KimYx0207/Meta_Kim/stargazers)
[![라이선스 Apache 2.0](https://img.shields.io/badge/%EB%9D%BC%EC%9D%B4%EC%84%A0%EC%8A%A4-Apache--2.0-green)](LICENSE)

</div>

## 아이디어를 실제 결과로 만들기

**Meta_Kim은 AI 어시스턴트가 여러 파일, 전문 분야, 세션에 걸친 일을 이어서 끝내도록 돕는 프레임워크입니다.** 평소 쓰는 클라이언트에서 목표를 말하면 프로젝트를 읽고, 방법을 비교하고, 작업을 나눕니다. 결정과 완료한 결과는 다음 세션에도 이어집니다.

> “휴대폰에서 쓸 수 있는 행사 신청 도구를 만들어 줘. 먼저 방식을 함께 정하고, 신청·참가자 목록·내보내기를 구현한 뒤 실제로 작동하는지 보여 줘.”

![목표, 조사와 결정, 두 단계 PRD, 전문 작업, 결과 확인으로 이어지는 흐름](docs/images/intent-to-delivery.ko-KR.svg)

*두 프로젝트의 협업 구조입니다. 의존 조건을 충족한 독립 작업은 병렬로 진행할 수 있습니다.*

| 필요한 것 | Meta_Kim이 정리하는 것 |
| --- | --- |
| 명확한 방향 | 프로젝트 현황, 참고 자료, 선택지와 추천 이유 |
| 구현할 수 있는 계획 | 하나의 PRD: 시스템·기술 결정 후 모듈·인터페이스·인수 기준 |
| 전문적인 실행 | 담당자에 맞는 방법, 프로젝트 자료와 결과 기준 |
| 중단 후 이어가기 | 결정, 완료 결과, 의존 관계와 다음 작업 |
| 눈에 보이는 진행 | Live 보드의 작업, 담당자, 결과물과 검사 결과 |

**[Kim Service](https://github.com/KimYx0207/Kim_Service)가 전문 방법을 제공하고, Meta_Kim이 전체 작업을 조율합니다.** 다른 역량 패키지도 연결할 수 있습니다. 결과를 크게 바꾸는 선택은 사용자에게, 일상적인 구현 판단은 작업 팀에 맡깁니다.

## 세 단계로 시작하기

**Node.js 22.13.0+**와 설정된 AI 클라이언트가 필요합니다. 현재 버전: **[v3.10.0](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.0)**.

**1. 설치하고 사용할 클라이언트를 고릅니다.**

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

기본 설치는 역량을 전역으로 재사용합니다. 전용 설정이 필요한 프로젝트는 프로젝트 설치를 선택하고, 전역 Hook은 `--with-global-hooks`로 추가합니다. 기존 사용자 설정은 병합됩니다. `npx --yes github:KimYx0207/Meta_Kim`으로 시작할 수도 있습니다.

**2. 프로젝트를 열고 원하는 결과를 말합니다.**

명령어나 기술 역할 이름을 외울 필요가 없습니다. 무엇이 작동해야 하고 무엇을 유지해야 하는지 알려 주세요. 어시스턴트는 기존 프로젝트 자료를 읽고 계획을 바꾸는 질문을 확인합니다.

**3. 진행을 보고 결과를 사용합니다.**

현재 작업의 Live 링크를 열거나 `node bin/meta-kim.mjs live`를 실행합니다. 보드에서 작업, 담당자, 의존 관계와 결과물을 확인합니다. [중국어 예제 데이터를 사용한 실제 Live 화면](docs/images/meta-kim-live-demo.png).

기존 클론은 다음과 같이 업데이트합니다.

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

## 클라이언트 연동

| 클라이언트 | 제공되는 연동 |
| --- | --- |
| **Codex · Claude Code** | 주요 연동: 네이티브 지침, Agent, Skill, 설정과 Hook |
| **Cursor · OpenClaw** | 각 클라이언트 형식에 맞춘 선택형 호환 연동 |
| **Gemini CLI** | 선택형 네이티브 Agent, 공유 Skill, 설정과 Hook |
| **ZCode** | 선택형 Agent, Skill, MCP와 사용자 수준 Hook |
| **DSH — DeepSeek Harness** | 네이티브 Skill, 전용 설정 또는 프로젝트 설치, MCP |
| **Qoder · Trae** | Beta 호환 어댑터 |

설치, 역량 패키지 로딩, 실제 작업은 각각 검증합니다. DSH는 공식 프로그램으로 모델을 호출하지 않고 설정·Skill·MCP를 확인합니다. Gemini CLI와 ZCode는 투영과 설치 생명주기 검사를 제공합니다. 모델의 전문 성과는 실제 작업 결과로 평가합니다. 자세한 내용은 [호환성 목록](config/runtime-compatibility-catalog.json)과 [검증 기록](docs/verification/dsh-professional-quality-20261111.md)을 보세요. 의존 프로젝트의 지원 클라이언트는 해당 상위 프로젝트가 관리합니다.

### DSH 사용하기

DSH에는 **Node.js 24.9.0+**가 필요합니다. 연동은 DSH `0.2.2-rc.1`을 기준으로 확인했습니다.

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

`--service-package /path/to/kim-service-dsh`를 추가하면 [Kim Service에서 만든 전문 패키지](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md)를 포함합니다. 같은 진입점에서 `update`와 `uninstall`을 사용할 수 있습니다. [DSH 안내](canonical/skills/meta-theory/references/runtime-dsh.md) · [ZCode 안내](canonical/skills/meta-theory/references/runtime-zcode.md).

## 작게 시도하고, 문제가 생긴 작업을 분리하기

기본 Hook은 작업 중에 안내합니다. 프로젝트가 시작된 지 칠 일이 지났다는 이유만으로 차단 모드로 바뀌지 않습니다.

준비된 단일 작업도 감독된 시험을 시작할 수 있습니다. 감독 대상 작업에서 같은 전략과 근거로 두 번 연속 성과를 내지 못하면 해당 작업의 퓨즈가 작동합니다. 독립 작업은 계속됩니다. 검토한 새 방식으로 바꾸면 복구 시험을 한 번 진행하고 결과를 기록한 뒤 다음 사용을 결정합니다. 권한, 파일 소유 범위와 파괴적 작업은 현재 승인에 따릅니다.

사용자 확인 대기도 그 결정에 의존하는 작업만 멈춥니다. 다시 시작할 때 독립적으로 완료한 결과를 보존합니다. 재사용할 방법도 후보를 시험하고 평가한 뒤 효과가 있는 버전을 남깁니다.

<details>
<summary>선택형 메모리 서비스</summary>

프로젝트의 연속성에는 영속 작업 기록을 사용합니다. Memory도 활성화했다면 설정한 서비스 주소를 확인할 수 있습니다.

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

`.mcp.json`, hook, 서비스 상태, 쓰기, 읽기, 세션 간 회상은 따로 확인합니다. `npm run meta:test:mcp`는 Meta_Kim 자체 MCP 서버를 검사합니다.

</details>

## 더 알아보고 기여하기

`canonical/`에는 공통 Agent·Skill·규칙, `config/`에는 역량 목록과 계약, `scripts/`와 `src/`에는 설치·실행·Live, `tests/`에는 동작 검사, `.meta-kim/`에는 로컬 작업 기록이 있습니다. 클라이언트별 디렉터리는 공통 소스에서 생성하며 `.gitignore`로 GitHub 소스에서 제외합니다.

[개발 안내](AGENTS.md) · [구조](docs/harness-architecture.md) · [의도에서 결과까지](canonical/skills/meta-theory/references/intent-to-delivery.md) · [Live SDK](docs/live-sdk.md) · [변경 기록](CHANGELOG.ko-KR.md)

## 연락처

![연락처 QR](docs/images/contact-qr.png)

GitHub <a href="https://github.com/KimYx0207">KimYx0207</a> |
X <a href="https://x.com/KimYx0207">@KimYx0207</a> |
공식 사이트 <a href="https://www.aiking.dev/">aiking.dev</a> |
위챗 공식 계정: **라오진과 함께하는 AI**

Feishu 지식 베이스:
<a href="https://my.feishu.cn/wiki/OhQ8wqntFihcI1kWVDlcNdpznFf">지속 업데이트 입구</a>

### 커피 한 잔

Meta_Kim이 도움이 되었다면 후원으로 응원해 주세요.

<table align="center">
<tr><th>위챗 결제</th><th>알리페이</th></tr>
<tr>
<td align="center"><img src="docs/images/wechat-pay.jpg" width="260" alt="위챗 수금 QR"></td>
<td align="center"><img src="docs/images/alipay.jpg" width="260" alt="알리페이 QR"></td>
</tr>
</table>

### 방법론 근거

Meta_Kim의 방법론은 본 프로젝트 메인테이너(KimYx0207)가 작성한 "메타 기반 의도 증폭(intent amplification)" 연구에 기반합니다:

- 논문: <https://zenodo.org/records/18957649>
- DOI: `10.5281/zenodo.18957649`

---


생성된 runtime projection directory는 local output이며 `.gitignore`로 보호되고 GitHub source에 들어가지 않습니다.

## License

[Apache License 2.0](LICENSE). Commercial use is permitted. Retain [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing the project or substantial portions. Third-party components retain their own licenses; attribution does not imply endorsement.

**Meta_Kim by KimYx0207 — https://github.com/KimYx0207/Meta_Kim**
