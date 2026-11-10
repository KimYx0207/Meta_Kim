<div align="center">

# 元 · Meta_Kim

**짧은 아이디어를 추적하고 검증할 수 있는 결과로.**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

<a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-green"/></a>

<a href="config/runtime-compatibility-catalog.json"><img alt="Default: Claude Code and Codex; compatibility: OpenClaw and Cursor" src="https://img.shields.io/badge/default-Claude%20Code%20%7C%20Codex%20%2B%20compat--OpenClaw%20%7C%20Cursor-111827"/></a>
<a href="config/runtime-compatibility-catalog.json"><img alt="Opt-in projections: Gemini CLI and ZCode" src="https://img.shields.io/badge/opt--in-Gemini%20CLI%20%7C%20ZCode-4F46E5"/></a>

</div>

## Meta_Kim은 무엇인가요?

**막연한 요청을 의사결정, 하나의 계획, 협업 작업, 확인할 수 있는 결과로 연결하는 AI 어시스턴트용 Harness입니다.** 사용하던 클라이언트에서 목표를 설명하면 현재 프로젝트를 살피고, 필요한 자료와 전문 역량을 찾아 검토와 검증까지 작업을 정리합니다.

> “휴대전화에서 신청할 수 있는 행사 등록 도구가 필요해요. 운영자는 정확한 참가자 명단을 볼 수 있어야 해요. 방법을 비교한 다음 선택한 안을 구현하고 검증해 주세요.”

![의도, 조사, 두 PRD 관점, 전문 역량과 검증의 관계](docs/images/intent-to-delivery.svg)

*아키텍처 설명 그림입니다. 실제 병렬 실행은 현재 호스트의 기능, 작업 의존 관계와 권한에 따릅니다.*

## 두 프로젝트의 역할

| 프로젝트 | 책임 |
| --- | --- |
| **Meta_Kim** | 의도 파악, 조사, 결정, 편성, 검토, 검증과 대화 간 연속성 |
| **[Kim Service](https://github.com/KimYx0207/Kim_Service)** | 전문 Agent·Skill·Hook·Tool과 방법, 자료, 예제, 입출력 경계 |

PRD는 하나입니다. 먼저 시스템과 기술 기준을 정한 뒤 모듈, 인터페이스, 상태와 인수 조건을 구체화합니다. 전문 Agent에게 역할 이름뿐 아니라 선택한 방법과 실제 작업 자료를 전달합니다.

사용자가 선택하는 것은 방향, 범위, 비용이나 인수 기준을 바꾸는 미해결 사안입니다. 내부 Agent 선택은 호스트가 담당합니다. 유효한 결정과 완료 기록을 재사용하며, 전제·자료·인수 조건이 달라진 범위만 다시 확인합니다.

## 설치

**Node.js 22.13.0 이상**과 사용자가 설정한 클라이언트가 필요합니다.

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

사용할 클라이언트를 선택하고 프로젝트에서 원하는 결과를 자연어로 말하세요. 기본 설치는 전역 역량을 재사용합니다. 전역 Hook은 `--with-global-hooks`로 명시적으로 활성화합니다. 기존 사용자 설정은 소유 범위를 확인해 병합합니다.

업데이트할 때는 소스를 먼저 가져옵니다.

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

현재 프로젝트에 제공된 Live 링크 또는 `node bin/meta-kim.mjs live`에서 진행 상황을 확인할 수 있습니다.

## 클라이언트 범위

| 클라이언트 | 현재 소스의 통합과 한계 |
| --- | --- |
| Codex / Claude Code | 주 대상 투영과 읽기 전용 실행 브리지. 실행 여부는 현재 호스트와 증거에 따름 |
| Cursor / OpenClaw | 기존 비기본 호환 투영. 해당 호스트의 검증 필요 |
| Gemini CLI | 선택형 네이티브 투영. 구조·생명주기 검증과 모델 실행은 구분 |
| ZCode | 선택형 네이티브 투영. 사용자 수준 Hook을 사용하며 현재 클라이언트는 프로젝트 Hook을 무시 |

DeepSeek Harness, Qoder, Trae는 **Beta** 호환 adapter로 유지됩니다. ZCode의 이전 plan-only adapter와 새 투영은 별도로 다룹니다. 의존 프로젝트의 install target은 upstream project에서 관리하며 Meta_Kim의 실제 동작을 보증하지 않습니다.

현재 릴리스는 [v3.9.0](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.9.0)입니다. [Unreleased](CHANGELOG.ko-KR.md)의 추가 사항은 소스 버전 변경이며 새 릴리스가 게시되었다는 뜻이 아닙니다. Gemini / ZCode의 실제 모델 실행은 인증되지 않았습니다.

## 연속성과 개선

의존 조건이 충족된 독립 작업은 실제 호스트 용량과 계획 한도 중 작은 값에 맞춰 실행합니다. 용량이 불명확하면 하나씩 실행합니다. 일부 작업이 실패해도 독립적으로 성공한 결과는 유지합니다. 현재의 전체 단계 경계와 쓰기 권한은 유지합니다.

RSI는 관찰→개선 후보→평가→검토 후 승격의 과정입니다. 평가가 없으면 미평가로 남기며 후보가 자신을 승인하지 않습니다. 정적 검색만으로 불필요한 파일을 확정하지 않고, 삭제 전에 설정·동적 로딩·외부 사용처를 확인합니다.

`canonical/`은 역량과 규칙의 원본, `config/`는 계약과 증거, `scripts/` / `src/`는 구현, `tests/`는 검증입니다. 클라이언트 디렉터리는 생성물이며 `.meta-kim/`은 로컬 상태입니다.

자세한 내용은 [English](README.md), [의도에서 교부까지](canonical/skills/meta-theory/references/intent-to-delivery.md), [호환 카탈로그](config/runtime-compatibility-catalog.json), [AGENTS.md](AGENTS.md)를 확인하세요. 검증되었다는 표현은 해당 검사가 실제로 확인한 범위에만 적용됩니다.

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
