<div align="center">

# 元 · Meta_Kim

**하고 싶은 일을 AI에게 말하세요. 구상부터 실행, 확인, 다음 개선까지 이어 갑니다.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

[![GitHub 스타](https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&label=%EC%8A%A4%ED%83%80)](https://github.com/KimYx0207/Meta_Kim/stargazers)
[![라이선스 Apache 2.0](https://img.shields.io/badge/%EB%9D%BC%EC%9D%B4%EC%84%A0%EC%8A%A4-Apache--2.0-green)](LICENSE)

</div>

## 하나의 일을 AI와 끝까지 이어 가세요

**Meta_Kim은 AI가 작업 순서를 잡고, 알맞은 방법을 활용하고, 결과를 확인한 뒤 지난 작업부터 이어 가도록 돕습니다.** 평소 쓰는 AI 클라이언트를 그대로 사용하면서 목표와 결정 사항, 진행 기록을 프로젝트에 쌓아 갈 수 있습니다.

![Meta_Kim Live 실제 화면에서 내장 데모의 작업 관계와 진행 상황을 표시한 모습](docs/images/meta-kim-live-task.ko-KR.png)

*내장 데모를 실행한 실제 Live 화면입니다. 먼저 작업 지도에서 전체 흐름을 보고, 궁금한 작업을 클릭해 세부 내용을 확인하세요.*

## 예를 들어, 휴대폰에서 회원가입하기 편하게 바꾼다면

이미 작동하는 웹사이트가 있는데 휴대폰에서 가입 양식을 작성하기가 불편합니다. 수집하는 데이터 항목은 그대로 두고 사용성을 개선하고 싶다고 가정해 보겠습니다.

원하는 결과를 평소 쓰는 말로 설명하세요. **지금 겪는 문제부터 시작하면 됩니다.** 입력란이 비좁고 오류 안내를 알아보기 어려우며, 수정한 화면을 직접 써 보고 싶다고 말해 보세요. Meta_Kim은 AI가 기존 프로젝트를 살펴보고 실행할 수 있는 방안을 정리하도록 돕습니다.

**방향을 정한 뒤 진행 과정을 확인합니다.** 이 예에서는 모바일 배치를 다듬고, 입력 오류를 명확히 안내하고, 같은 데이터가 애플리케이션에 전달되는지 확인할 수 있습니다. 각 작업에 필요한 파일과 방법, 완료 기준을 정리합니다. Live에서는 작업 사이의 관계와 현재 진행 상황을 볼 수 있습니다.

**결과를 직접 써 보고 다음 개선을 이어 갑니다.** 수정한 소스, 실행 방법, 수행한 검사를 보여 달라고 요청하세요. 화면을 휴대폰 너비로 맞춘 뒤 빈칸, 잘못된 입력, 정상적인 가입을 차례로 확인합니다. 다음에는 “지금 배치는 유지하고 가입 완료 안내를 더 알기 쉽게 바꿔 줘”라고 이어 갈 수 있습니다. 결정 사항과 작업 기록이 남아 다음 대화에서도 같은 일을 계속하기 쉽습니다.

![목표에서 조사와 계획, 작업 실행, 결과 확인, 다음 개선으로 이어지는 흐름](docs/images/intent-to-delivery.ko-KR.svg)

처음에는 이처럼 작은 작업으로 시작해 보세요. 새 기능 개발, 문제 수정, 여러 차례에 걸친 제품 개발에도 같은 과정을 적용할 수 있습니다.

## 작업이 이어지도록 어떻게 돕나요

![사용자, AI 클라이언트, Meta_Kim, 전문 기능과 프로젝트 기록이 함께 작동하는 구조](docs/images/meta-kim-overview.ko-KR.svg)

사용자는 목표를 제시하고 제품의 방향을 좌우하는 선택을 합니다. **Meta_Kim은 AI 클라이언트 안에서 작업을 정리합니다.** 무엇부터 알아봐야 하는지, 어떤 작업을 시작할 수 있는지, 각 작업에 무엇이 필요한지, 결과를 어떻게 확인할지 연결합니다.

**[Kim Service](https://github.com/KimYx0207/Kim_Service)는 설계, 개발, 분석 등에 활용할 전문 방법을 제공합니다.** Meta_Kim은 이 방법들을 클라이언트에 있는 도구 및 스킬과 함께 사용할 수 있습니다. 계획과 결과물, 검사 결과를 기록으로 남겨 다음 세션에서도 구체적인 내용을 바탕으로 이어 갑니다.

## 내 프로젝트에서 직접 써 보기

**Node.js 22.13.0 이상**과 설정된 AI 클라이언트가 필요합니다. 현재 버전: **[v3.10.2](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.2)**.

### 1. Meta_Kim 설치

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

안내에 따라 사용하는 클라이언트를 선택하세요. 한 프로젝트에만 설치하거나 여러 프로젝트에서 같은 설정을 사용할 수 있습니다. 설치 범위나 선택형 서비스를 설정하려면 [설치 옵션](docs/technical-notes.ko-KR.md#설치-옵션)을 참고하세요.

### 2. 프로젝트를 열고 원하는 결과 설명하기

설정한 클라이언트에서 대상 프로젝트를 엽니다. 회원가입 예시라면 평소 채팅하듯 다음과 같이 요청하세요.

> “이 프로젝트의 회원가입 흐름을 확인하고 휴대폰에서 입력하기 편하게 바꿔 줘. 현재 데이터 필드는 유지하고, 변경한 흐름과 검사 결과를 보여 줘.”

AI는 현재 프로젝트부터 살펴봅니다. 기존 항목 유지, 제품 스타일에 맞추기 등 실제 조건을 알려 주고 결과에 영향을 주는 선택을 함께 정하세요. 작업 중에도 제안을 확인하고 원하는 변경 사항을 추가할 수 있습니다.

### 3. Live를 열고 작업 살펴보기

Meta_Kim 디렉터리에서 실행하세요.

```bash
node bin/meta-kim.mjs live --project-root "/path/to/your-project"
```

따옴표 안을 대상 프로젝트의 절대 경로로 바꾼 뒤 명령이 출력한 로컬 URL을 여세요. Live는 프로젝트에 저장된 작업과 실행 기록을 읽어 표시합니다. 화면부터 살펴보고 싶다면 같은 URL에 `?demo=states`를 붙여 내장 데모를 열 수 있습니다.

**먼저 이 페이지 맨 위의 작업 지도를 보세요.** 작업을 잇는 선을 따라가면 진행 중인 일과 다른 작업의 결과를 기다리는 부분을 파악할 수 있습니다. **다음으로 작업 노드를 클릭하세요.** 세부 패널에서 요약을 보고 **근거**를 선택하면 기록된 결과물과 검사 내용을 확인할 수 있습니다.

![Meta_Kim Live에서 작업을 선택하고 세부 내용과 기록된 근거를 확인하는 화면](docs/images/meta-kim-live-detail.ko-KR.png)

*같은 내장 데모에서 작업을 선택한 화면입니다. 한 작업의 내용을 살펴본 뒤 전체 지도로 돌아갈 수 있습니다.*

실제 결과물을 수정하고 싶다면 AI 클라이언트로 돌아가 요청하세요. 이 예에서는 회원가입을 직접 해 본 다음, 더 개선하고 싶은 부분을 알려 주면 됩니다.

### 기존 설치 업데이트

Meta_Kim 디렉터리에서 실행하세요.

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

## 사용할 클라이언트 선택

평소 작업하는 클라이언트를 선택하세요. 각 연동은 해당 클라이언트의 설정과 확장 형식을 사용합니다.

| 클라이언트 | 연동 내용과 시작 위치 |
| --- | --- |
| **Codex · Claude Code** | Agent, Skill, 지침과 Hook. 설치할 때 해당 클라이언트 선택 |
| **Cursor** | Agent, Skill, 프로젝트 규칙과 Hook. 설치할 때 Cursor 선택 |
| **OpenClaw** | Skill, Agent 작업 공간과 설정 템플릿. 설치할 때 OpenClaw 선택 |
| **Gemini CLI** | Agent, 공유 Skill, 설정과 Hook. [클라이언트 안내](canonical/skills/meta-theory/references/runtime-gemini.md) |
| **ZCode** | Agent, Skill, MCP와 사용자 수준 Hook. [클라이언트 안내](canonical/skills/meta-theory/references/runtime-zcode.md) |
| **DeepSeek Harness(DSH)** | Beta 연동: 네이티브 Skill, 전용 설정 또는 프로젝트 설치, MCP. [클라이언트 안내](docs/technical-notes.ko-KR.md#deepseek-harness) |
| **Qoder · Trae** | Beta 호환 어댑터. [연동 상세](config/runtime-compatibility-catalog.json) |

[호환성 목록](config/runtime-compatibility-catalog.json) · [설치 및 기술 안내](docs/technical-notes.ko-KR.md). 의존 프로젝트의 지원 클라이언트는 해당 상위 프로젝트가 관리합니다.

## 필요할 때 더 알아보기

설치 범위, Hook, 선택형 서비스 설정은 [설치 및 기술 안내](docs/technical-notes.ko-KR.md)에 정리되어 있습니다. 목표가 구체적인 작업으로 이어지는 과정은 [의도에서 결과까지](canonical/skills/meta-theory/references/intent-to-delivery.md)에서 설명합니다.

개발이나 기능 확장에는 [구조](docs/harness-architecture.md), [Live SDK](docs/live-sdk.md), [개발 안내](AGENTS.md)를 참고하세요. 버전별 변경 내용은 [변경 기록](CHANGELOG.ko-KR.md)에서 확인할 수 있습니다.

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

## License

[Apache License 2.0](LICENSE). Commercial use is permitted. Retain [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing the project or substantial portions. Third-party components retain their own licenses; attribution does not imply endorsement.

**Meta_Kim by KimYx0207 — https://github.com/KimYx0207/Meta_Kim**
