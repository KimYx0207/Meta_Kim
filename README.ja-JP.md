<div align="center">

# 元 · Meta_Kim

**短いアイデアから、追跡・検証できる成果へ。**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

<a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-green"/></a>

<a href="config/runtime-compatibility-catalog.json"><img alt="Default: Claude Code and Codex; compatibility: OpenClaw and Cursor" src="https://img.shields.io/badge/default-Claude%20Code%20%7C%20Codex%20%2B%20compat--OpenClaw%20%7C%20Cursor-111827"/></a>
<a href="config/runtime-compatibility-catalog.json"><img alt="Opt-in projections: Gemini CLI and ZCode" src="https://img.shields.io/badge/opt--in-Gemini%20CLI%20%7C%20ZCode-4F46E5"/></a>

</div>

## Meta_Kim とは

**曖昧な依頼を、判断・共通の計画・協調作業・確認できる成果につなげる AI アシスタント向け Harness です。** 普段のクライアントで目的を伝えると、現在のプロジェクトを調べ、必要な調査と専門能力を選び、レビューと検証まで作業を整理します。

> 「スマートフォンで申し込めるイベント登録ツールがほしい。主催者は正確な参加者一覧を見たい。実現方法を比較して、選んだ案を実装・検証してほしい。」

![意図、調査、二つのPRDビュー、専門能力と検証の関係](docs/images/intent-to-delivery.svg)

*アーキテクチャの説明図です。実際の並行実行は、ホスト能力・依存関係・権限に従います。*

## 二つのプロジェクト

| プロジェクト | 担当 |
| --- | --- |
| **Meta_Kim** | 意図の理解、調査、判断、編成、レビュー、検証、会話をまたぐ継続 |
| **[Kim Service](https://github.com/KimYx0207/Kim_Service)** | 専門 Agent・Skill・Hook・Tool、その方法、資料、例、入出力の境界 |

PRD は一つです。最初にシステムと技術の基準を定め、その後モジュール、インターフェース、状態、受入条件を具体化します。専門 Agent には役職名だけでなく、選んだ方法と実際の資料を渡します。

ユーザーに尋ねるのは、方向・範囲・費用・受入条件を変える未解決の選択です。内部の Agent 選びはホストが担います。有効な決定と完了記録を再利用し、前提・資料・受入条件が変わった範囲だけを再確認します。

## インストール

Node.js **22.13.0 以上**と、ご自身で設定したクライアントが必要です。

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

利用するクライアントを選び、プロジェクトで目的を自然な言葉で伝えてください。既定はグローバルな能力の再利用です。グローバル Hook は `--with-global-hooks` で明示的に有効化します。既存設定は所有範囲を確認してマージします。

更新時は先にソースを取得します。

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

進捗は現在のプロジェクトに対応する Live リンク、または `node bin/meta-kim.mjs live` で確認できます。

## クライアントの範囲

| クライアント | 現在のソースの対応と限界 |
| --- | --- |
| Codex / Claude Code | 主要投影と読み取り専用実行ブリッジ。実行可能性は現在のホストと証拠による |
| Cursor / OpenClaw | 既存の非既定互換投影。各ホストの検証が必要 |
| Gemini CLI | 選択式のネイティブ投影。構造・ライフサイクル検証とモデル実行は別 |
| ZCode | 選択式のネイティブ投影。ユーザー単位の Hook を使用し、現行クライアントはプロジェクト Hook を無視 |

DeepSeek Harness・Qoder・Trae は **Beta** 互換 adapter のままです。ZCode の旧 plan-only adapter と新投影は別々に扱います。依存プロジェクト側の install target は upstream project で管理され、Meta_Kim の実動作を保証しません。

現在のリリースは [v3.9.0](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.9.0) です。[Unreleased](CHANGELOG.ja-JP.md) の追加はソース版の変更であり、新リリースの公開を意味しません。Gemini / ZCode のモデル実行は未認証です。

## 継続と改善

依存関係が満たされた独立作業は、実際のホスト容量と計画上限の小さい方で進めます。容量不明時は一つずつ実行します。一部が失敗しても、独立した成功結果は保持します。現行の全体ステージ境界と書き込み権限は維持されます。

RSI は、観察→改善候補→評価→レビュー後の昇格という流れです。評価の欠落は未評価として残し、候補が自分を承認することはありません。静的な参照検索だけで「不要」と決めず、削除前に設定・動的読込・外部利用を確認します。

`canonical/` が能力とルールの源、`config/` が契約と証拠、`scripts/` / `src/` が実装、`tests/` が検証です。クライアント用ディレクトリは生成物、`.meta-kim/` はローカル状態です。

詳細は [English](README.md)、[意図から交付まで](canonical/skills/meta-theory/references/intent-to-delivery.md)、[互換カタログ](config/runtime-compatibility-catalog.json)、[AGENTS.md](AGENTS.md) を参照してください。検証済みという表現は、そのチェックが実際に確認した範囲に限ります。

## 連絡先

![連絡先](docs/images/contact-qr.png)

GitHub <a href="https://github.com/KimYx0207">KimYx0207</a> |
X <a href="https://x.com/KimYx0207">@KimYx0207</a> |
公式サイト <a href="https://www.aiking.dev/">aiking.dev</a> |
WeChat 公式アカウント：**ラオジンとAIを楽しむ**

Feishu ナレッジベース：
<a href="https://my.feishu.cn/wiki/OhQ8wqntFihcI1kWVDlcNdpznFf">継続更新の入口</a>

### コーヒーを一杯

Meta_Kim が役に立ったなら、継続メンテの支援としてコーヒーをご馳走いただけるとうれしいです。

<table align="center">
<tr><th>WeChat Pay</th><th>Alipay</th></tr>
<tr>
<td align="center"><img src="docs/images/wechat-pay.jpg" width="260" alt="WeChat Pay QR"></td>
<td align="center"><img src="docs/images/alipay.jpg" width="260" alt="Alipay QR"></td>
</tr>
</table>

### 方法の根拠

Meta_Kim の方法論は、本プロジェクトのメンテナ（KimYx0207）による「元に基づく意図拡張（intent amplification）」の研究に依拠しています。

- 論文: <https://zenodo.org/records/18957649>
- DOI: `10.5281/zenodo.18957649`

---


生成された runtime projection directory は local output で、`.gitignore` により GitHub source には入りません。

## License

[Apache License 2.0](LICENSE). Commercial use is permitted. Retain [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing the project or substantial portions. Third-party components retain their own licenses; attribution does not imply endorsement.

**Meta_Kim by KimYx0207 — https://github.com/KimYx0207/Meta_Kim**
