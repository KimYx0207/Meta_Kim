# 導入、クライアント、タスクの引き継ぎ

[English](technical-notes.md) · [简体中文](technical-notes.zh-CN.md) · [日本語](technical-notes.ja-JP.md) · [한국어](technical-notes.ko-KR.md)

[製品紹介へ戻る](../README.ja-JP.md)

導入方法を選び、具体的な操作の資料を探すためのページです。詳しい連携仕様は、各クライアントのガイドと設定ファイルを参照してください。

## 導入オプション

初回の手順は [README](../README.ja-JP.md#最初のプロジェクトを始める) にあります。Meta_Kim には Node.js 22.13.0+ と設定済みの AI クライアントが必要です。

| 選択肢 | 使う場面 |
| --- | --- |
| グローバル導入 | 複数のプロジェクトで同じ機能を再利用したい場合 |
| プロジェクト単位の導入 | 専用設定が必要な場合。非対話コマンドでは `--scope project` を指定 |
| クライアントの選択 | 利用するクライアントを選択。通常のセットアップ対象は `--targets` でも指定可能 |
| グローバル Hook | 選択したクライアントのグローバル Hook を使う場合は `--with-global-hooks` を追加 |
| 環境の確認 | `node setup.mjs --check` で導入済みの環境を確認 |

既存の設定はマージされ、更新時には Meta_Kim が管理するファイルを記録します。CLI の操作一覧は `node bin/meta-kim.mjs --help` で確認できます。クローンせずに `npx --yes github:KimYx0207/Meta_Kim` からインストーラーを起動することもできます。

クローンの更新は `git pull --ff-only`、`node setup.mjs --update` の順で行います。npx から導入した環境では `npx --yes github:KimYx0207/Meta_Kim update` を使います。

## クライアントガイド

[Claude Code](../canonical/skills/meta-theory/references/runtime-claude.md) · [Codex](../canonical/skills/meta-theory/references/runtime-codex.md) · [Gemini CLI](../canonical/skills/meta-theory/references/runtime-gemini.md) · [ZCode](../canonical/skills/meta-theory/references/runtime-zcode.md)

[互換性カタログ](../config/runtime-compatibility-catalog.json)には、Cursor、OpenClaw、Qoder、Trae を含む各クライアントの形式と連携区分を記録しています。Hook の対象範囲はホストが提供するイベントによって異なります。詳しくは[実行環境のガイド](../AGENTS.md)を参照してください。依存プロジェクトの対応クライアントは各上流プロジェクトが管理します。

## DeepSeek Harness

DSH は任意で選べるクライアントで、専用の管理コマンドから導入します。必要な Node.js は **24.9.0+**、確認対象のホストは **DSH 0.2.2-rc.1** です。

Meta_Kim のチェックアウトで実行します。

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

同じ Meta_Kim CLI の `node bin/meta-kim.mjs dsh update` と `node bin/meta-kim.mjs dsh uninstall` で管理対象の連携を更新・削除できます。`--service-package /path/to/kim-service-dsh` を追加すると、[Kim Service で構築した専門パッケージ](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md)を導入できます。プロジェクト単位では `--scope project --project-root /path/to/project` を使い、処理後に表示される起動コマンドを利用します。

[DSH ガイド](../canonical/skills/meta-theory/references/runtime-dsh.md)は設定、手法全文の読み込み、MCP、ホストの権限を説明しています。[検証記録](verification/dsh-professional-quality-20261111.md)では、設定・Skill 検出・資料の引き継ぎ・MCP の確認範囲を示しています。ネイティブなタスク結果とモデルの専門的な品質は、実際の成果物から評価します。

## 中断したタスクを再開する

実行記録は、決定、完了した成果、依存関係、残りの作業をプロジェクト内に保持します。プロジェクトを移動するときや作業を再開するときは、これらの記録も残してください。Live は現在の実行を読み、タスクを成果物や確認結果と結び付けます。

監督付きの実行経路では、成果につながらない試行が続くと、そのタスクを一時停止し、次のレビューや復旧作業を記録します。独立した作業は続けられます。レビュー済みの新しい方針では復旧試行を行います。前回の書き込み結果が不明な場合は、保存した応答記録と書き込み先の現在の状態を先に照合します。

仕組みは[意図から成果へ](../canonical/skills/meta-theory/references/intent-to-delivery.md)、[構成](harness-architecture.md)、[タスクの試行と復旧の記録](verification/task-scoped-canary-20261111.md)で説明しています。

## 任意の Memory サービス

永続的な実行記録でプロジェクトの継続を支えます。Memory を追加すると、選んだ情報をセッション間で保存・検索できます。有効にした場合は、設定したサービスのアドレスを確認します。

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

このエンドポイントはサービスへの接続を確認します。書き込み、読み取り、想起が必要なタスクでは、設定したサービスでそれぞれの動作も確認してください。`npm run meta:test:mcp` は Meta_Kim 自身の MCP サーバーを検査します。

## ソースと生成ファイル

共通の Agent、Skill、実行環境の素材は `canonical/` で管理し、機械可読の設定は `config/` に置きます。`.claude/`、`.codex/`、`.cursor/` などのクライアント別ディレクトリは `npm run meta:sync` でローカルに生成します。生成物は `.gitignore` で GitHub のソースから除外し、ローカルに保持します。配布パッケージには元の共通ソースを含めます。

## 記録を調べるとき

| 確認したいこと | 参照先 |
| --- | --- |
| インストーラーが受け付ける引数 | [セットアップ入口](../setup.mjs) · [CLI](../bin/meta-kim.mjs) |
| 利用できるクライアント連携 | [互換性カタログ](../config/runtime-compatibility-catalog.json) |
| 設計と手法を実行担当に渡す仕組み | [意図から成果へ](../canonical/skills/meta-theory/references/intent-to-delivery.md) |
| 公開済みバージョンの変更 | [変更履歴](../CHANGELOG.ja-JP.md)とリンク先の記録 |
| ソースを保守する方法 | [開発ガイド](../AGENTS.md) |
