<div align="center">

# 元 · Meta_Kim

**アイデアを、具体的な計画、専門的な協働、使える成果へ。**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

[![GitHub スター](https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&label=%E3%82%B9%E3%82%BF%E3%83%BC)](https://github.com/KimYx0207/Meta_Kim/stargazers)
[![ライセンス Apache 2.0](https://img.shields.io/badge/%E3%83%A9%E3%82%A4%E3%82%BB%E3%83%B3%E3%82%B9-Apache--2.0-green)](LICENSE)

</div>

## ひとまとまりの仕事を、AI と最後まで進める

**Meta_Kim は、いつもの AI クライアントで、目的・プロジェクト資料・専門的な手法・進捗をつなぎます。** 依頼を理解し、方針を選び、作業を分担して、成果を確認するまでを支えます。決定事項と完了した作業はプロジェクトに残り、次のセッションにも引き継げます。

### こんな場面で役立ちます

| やりたいこと | 作業の進め方 |
| --- | --- |
| 新しいツールや機能を作りたい | 実現方法を比較し、利用者の流れを決めてから、計画と実装タスクに落とし込む |
| 使っている製品を改善したい | 現在のプロジェクトを読み、関連する操作とコードを調べ、必要な変更と確認を行う |
| 複数の専門分野やセッションにまたがる仕事を進めたい | タスクに合う手法と資料を渡し、依存関係を整理して、保存した成果から再開する |

欲しい結果を普段の言葉で伝えると、Meta_Kim がそれに沿って作業を組み立てます。**[Kim Service](https://github.com/KimYx0207/Kim_Service) は、具体的な作業に使う専門的な手法を提供します。** クライアントにあるほかの機能やツールと組み合わせて利用できます。

## どんな成果が手元に残るのか

イベント申込ツールなら、最初の依頼はこのくらいから始められます。

> 「スマートフォンで使えるイベント申込ツールを作りたい。まず方式を一緒に選び、申込と参加者一覧のエクスポートを作って、使い方を実際に見せてほしい。」

範囲を決めたら、依頼を具体的な成果物へ落とし込みます。この例では、次のように整理できます。

| 進める仕事 | 確認できる成果物 |
| --- | --- |
| 方式を選ぶ | 推奨案、利用者の操作手順、参考資料、選択した理由 |
| 製品を設計する | 一つの要件文書：システム・技術の方針から、モジュール・インターフェース・受入条件まで |
| 操作の流れを実装する | 申込、参加者管理、エクスポートのタスクと、関連するソースや資料 |
| 動作を確かめる | 申込とエクスポートの実演、確認記録、修正が必要な箇所 |
| 次回に引き継ぐ | 完了した成果、決定事項、残っているタスクと次の作業 |

小さな修正にも、新しい製品づくりにも、必要な作業に応じた計画で進めます。

## 成果までの進め方

![目的、調査と計画、専門作業、成果の確認という流れ](docs/images/intent-to-delivery.ja-JP.svg)

1. **欲しい結果を明らかにする。** 既存のプロジェクトを読み、作るものを左右する点を確認します。
2. **実現方法を見つける。** 重要な不明点を調べ、有力な案を比較して、推奨する理由を説明します。
3. **着手できる計画にする。** タスクごとの入力、担当、依存関係、完了条件を決めます。
4. **分担して作業を進める。** 必要な手法と資料を各タスクへ渡し、準備が整った独立作業を並行して進めます。
5. **確認し、試し、改善する。** 目的に沿って成果をレビューし、フィードバックを反映して、次の改善に使える決定と結果を残します。

**Live ボード**では、タスク、担当、依存関係、成果物、確認結果をまとめて見られます。中断後は保存した記録から再開できます。一つのタスクで方針を見直す場合も、次の作業を記録し、独立した仕事は続けられます。

<details>
<summary>Live のデモ画面を見る（中国語）</summary>

![デモ用タスクデータを表示した中国語の Live 画面](docs/images/meta-kim-live-demo.png)

*中国語のインターフェースにデモ用のタスクデータを表示しています。*

</details>

## 最初のプロジェクトを始める

**Node.js 22.13.0+** と、設定済みの AI クライアントが必要です。現行版：**[v3.10.1](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.1)**。

### 1. Meta_Kim をインストールする

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

案内に沿ってクライアントと導入範囲を選びます。グローバル導入は複数のプロジェクトで機能を再利用する場合に、プロジェクト単位の導入は専用設定が必要な場合に使います。既存のユーザー設定はマージされます。[導入オプション](docs/technical-notes.ja-JP.md#導入オプション)。

### 2. プロジェクトを開き、欲しい結果を伝える

設定したクライアントで対象のプロジェクトを開き、具体的な依頼を伝えます。

> 「このプロジェクトの会員登録を見直して、スマートフォンで入力しやすくしてほしい。今のデータ項目は残し、変更後の操作と確認結果を見せてください。」

アシスタントは既存の資料から状況を把握します。製品の方向を大きく変える選択は利用者が判断し、日常的な実装判断は作業チームが進めます。

### 3. 進捗を見て、成果を使ってみる

現在のタスクの Live リンクを開きます。Meta_Kim のチェックアウトから、対象プロジェクトの Live を起動することもできます。

```bash
node bin/meta-kim.mjs live --project-root "/path/to/your-project"
```

例のパスを自分のプロジェクトのディレクトリに置き換えてください。成果物と確認記録を見て、次に改善したい点を伝えます。

### インストール済みの環境を更新する

Meta_Kim のチェックアウトで実行します。

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

## 利用するクライアントを選ぶ

普段の作業に合うクライアントを選べます。連携はそれぞれのクライアントの設定・拡張形式を使います。

| クライアント | 連携内容と入口 |
| --- | --- |
| **Codex · Claude Code** | Agent、Skill、指示、Hook。セットアップ時に選択 |
| **Cursor** | Agent、Skill、プロジェクトルール、Hook。セットアップ時に Cursor を選択 |
| **OpenClaw** | Skill、Agent ワークスペース、設定テンプレート。セットアップ時に OpenClaw を選択 |
| **Gemini CLI** | Agent、共有 Skill、設定、Hook。[クライアントガイド](canonical/skills/meta-theory/references/runtime-gemini.md) |
| **ZCode** | Agent、Skill、MCP、ユーザー単位の Hook。[クライアントガイド](canonical/skills/meta-theory/references/runtime-zcode.md) |
| **DeepSeek Harness（DSH）** | Beta 連携：ネイティブ Skill、専用設定・プロジェクト導入、MCP。[クライアントガイド](docs/technical-notes.ja-JP.md#deepseek-harness) |
| **Qoder · Trae** | Beta 互換アダプター。[連携の詳細](config/runtime-compatibility-catalog.json) |

[互換性カタログ](config/runtime-compatibility-catalog.json) · [導入と技術上の補足](docs/technical-notes.ja-JP.md)。依存プロジェクトの対応クライアントは各上流プロジェクトが管理します。

## 次に知りたいことから読む

| 知りたいこと | 資料 |
| --- | --- |
| 導入範囲、Hook、任意サービスの設定 | [導入と技術上の補足](docs/technical-notes.ja-JP.md) |
| 調査と要件を実際の作業へ引き継ぐ仕組み | [意図から成果へ](canonical/skills/meta-theory/references/intent-to-delivery.md) |
| Live の利用や画面の拡張 | [Live SDK](docs/live-sdk.md) |
| プロジェクトの構成と開発への参加 | [構成](docs/harness-architecture.md) · [開発ガイド](AGENTS.md) |
| 各バージョンの変更内容 | [変更履歴](CHANGELOG.ja-JP.md) |

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

## License

[Apache License 2.0](LICENSE). Commercial use is permitted. Retain [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing the project or substantial portions. Third-party components retain their own licenses; attribution does not imply endorsement.

**Meta_Kim by KimYx0207 — https://github.com/KimYx0207/Meta_Kim**
