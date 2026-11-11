<div align="center">

# 元 · Meta_Kim

**一つのアイデアから、引き継げる仕事と確かめられる成果へ。**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

[![GitHub スター](https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&label=%E3%82%B9%E3%82%BF%E3%83%BC)](https://github.com/KimYx0207/Meta_Kim/stargazers)
[![ライセンス Apache 2.0](https://img.shields.io/badge/%E3%83%A9%E3%82%A4%E3%82%BB%E3%83%B3%E3%82%B9-Apache--2.0-green)](LICENSE)

</div>

## アイデアを、使える成果へ

**Meta_Kim は、複数のファイル・専門分野・セッションにまたがる仕事を AI アシスタントと進めるためのフレームワークです。** いつものクライアントで目的を伝えると、プロジェクトを調べ、方法を比較し、作業を組み立てます。決定事項と完成済みの成果は次のセッションにも引き継ぎます。

> 「スマートフォンで使えるイベント申込ツールを作りたい。まず方式を一緒に選び、申込・参加者一覧・エクスポートを実装して、実際に動かして確認してほしい。」

![目的、調査と判断、二段階の PRD、専門作業、成果の確認という流れ](docs/images/intent-to-delivery.ja-JP.svg)

*二つのプロジェクトの連携図。依存条件を満たした独立作業は並行して進められます。*

| 必要なこと | Meta_Kim が整理すること |
| --- | --- |
| 方向を決める | 現状、参考資料、選択肢と推奨理由 |
| 実装できる計画 | 一つの PRD：システム・技術の方針から、モジュール・インターフェース・受入条件へ |
| 専門的に実行する | 担当者に合った方法、プロジェクト資料、成果基準 |
| 中断後に続ける | 決定、成果、依存関係と次の作業 |
| 進捗を見る | Live ボードのタスク、担当者、成果と確認結果 |

**[Kim Service](https://github.com/KimYx0207/Kim_Service) が専門的な方法を提供し、Meta_Kim が仕事全体を進行します。** ほかの能力パッケージも接続できます。成果を大きく変える判断は利用者へ、日常の実装判断は作業チームへ渡します。

## 三つの手順で始める

**Node.js 22.13.0+** と、設定済みの AI クライアントが必要です。現行版：**[v3.10.0](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.0)**。

**1. インストールしてクライアントを選びます。**

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

標準では能力をグローバルに再利用します。専用設定が必要ならプロジェクト単位で導入し、グローバル Hook を使う場合は `--with-global-hooks` を指定します。既存の設定はマージされます。`npx --yes github:KimYx0207/Meta_Kim` からも開始できます。

**2. プロジェクトを開き、欲しい結果をそのまま伝えます。**

コマンドや専門職の名前を覚える必要はありません。何を使えるようにするか、何を残すかを伝えてください。アシスタントは既存の資料を読み、計画を変える質問を確認します。

**3. 進捗を見て、成果を使います。**

現在のタスクの Live リンクを開くか、`node bin/meta-kim.mjs live` を実行します。ボードでタスク、担当者、依存関係と成果を確認できます。[中国語のデモデータを使った実際の Live 画面](docs/images/meta-kim-live-demo.png)。

既存のクローンは次の手順で更新します。

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

## クライアント連携

| クライアント | 利用できる連携 |
| --- | --- |
| **Codex · Claude Code** | 主要連携：ネイティブ指示、Agent、Skill、設定と Hook |
| **Cursor · OpenClaw** | 各クライアントの形式に合わせた任意の互換連携 |
| **Gemini CLI** | 任意のネイティブ Agent、共有 Skill、設定と Hook |
| **ZCode** | 任意の Agent、Skill、MCP とユーザー単位の Hook |
| **DSH — DeepSeek Harness** | ネイティブ Skill、専用設定またはプロジェクト導入、MCP |
| **Qoder · Trae** | Beta 互換アダプター |

導入、能力パッケージの読み込み、実際のタスクは個別に検証します。DSH は公式プログラムでモデルを呼ばずに設定・Skill・MCP を確認しています。Gemini CLI と ZCode は投影と導入ライフサイクルを検査しています。モデルの専門的な成果は実タスクで評価します。詳細は[互換性カタログ](config/runtime-compatibility-catalog.json)と[検証記録](docs/verification/dsh-professional-quality-20261111.md)を参照してください。依存プロジェクトの対応クライアントは各上流プロジェクトが管理します。

### DSH を使う

DSH には **Node.js 24.9.0+** が必要です。連携は DSH `0.2.2-rc.1` に照らして確認しています。

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

`--service-package /path/to/kim-service-dsh` を追加すると、[Kim Service で構築した専門パッケージ](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md)を読み込めます。同じ入口で `update` と `uninstall` も使えます。[DSH ガイド](canonical/skills/meta-theory/references/runtime-dsh.md) · [ZCode ガイド](canonical/skills/meta-theory/references/runtime-zcode.md)。

## 小さく試し、問題のある作業を切り離す

標準の Hook は進行中に助言します。プロジェクトの開始から七日が経過しただけでブロックに切り替わることはありません。

準備済みの単独タスクでも監督付きの試行を開始できます。監督対象のタスクで、同じ方針と根拠による試行が二回続けて成果につながらなければ、そのタスクのヒューズが作動します。独立した作業は続きます。レビュー済みの新しい方針では回復試行を一回行い、結果を記録して次の利用を判断します。権限、ファイルの所有範囲、破壊的な操作は現在の承認に従います。

利用者の確認待ちも、その判断に依存する作業だけを止めます。再開時には独立した完成済みの成果を保持します。再利用する方法も、候補を試して評価し、有効な版を残します。

<details>
<summary>任意のメモリサービス</summary>

プロジェクトの継続には永続タスク記録を使います。Memory も有効にした場合は、設定したサービスのアドレスを確認できます。

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

`.mcp.json`、hook、サービスの稼働、書き込み、読み取り、セッション間の想起は個別に確認します。`npm run meta:test:mcp` は Meta_Kim 自身の MCP サーバーを検査します。

</details>

## 資料と開発参加

`canonical/` は共通の Agent・Skill・ルール、`config/` は能力索引と契約、`scripts/` と `src/` は導入・実行・Live、`tests/` は動作確認、`.meta-kim/` はローカルのタスク記録です。クライアント別ディレクトリは共通ソースから生成し、`.gitignore` で GitHub のソースから除外します。

[開発ガイド](AGENTS.md) · [構成](docs/harness-architecture.md) · [意図から成果へ](canonical/skills/meta-theory/references/intent-to-delivery.md) · [Live SDK](docs/live-sdk.md) · [変更履歴](CHANGELOG.ja-JP.md)

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
