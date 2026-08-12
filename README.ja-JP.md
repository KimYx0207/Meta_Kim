<div align="center">

<h1 style="font-size: 6em; font-weight: 900; margin-bottom: 0.2em; letter-spacing: 0.1em;">元</h1>
<p style="font-size: 1.2em; color: #7c3aed; font-weight: 600; margin-top: 0;">META_KIM</p>

<p>
  言語：
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.ja-JP.md">日本語</a> |
  <a href="README.ko-KR.md">한국어</a>
</p>

<p>
  <a href="config/runtime-compatibility-catalog.json"><img alt="Projection tiers" src="https://img.shields.io/badge/default-Claude%20Code%20%7C%20Codex%20%2B%20compat-OpenClaw%20%7C%20Cursor-111827"/></a>
  <a href="config/runtime-compatibility-catalog.json"><img alt="Candidate compatibility probes" src="https://img.shields.io/badge/candidate-Qoder%20%7C%20Trae%20%7C%20Kiro%20%7C%20Cascade%20%7C%20Cline%20%7C%20Roo%20%7C%20Continue-475569"/></a>
  <a href="https://github.com/KimYx0207/Meta_Kim/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&logo=github"/></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-green"/></a>
</p>

</div>

## 概要

**Meta_Kim** は、AI コーディング支援のための単なるツールではありません。AI エージェントに「判断」と「規律」を与えるガバナンスシステムです。

たとえば Claude Code、Codex、OpenClaw、Cursor は、コードを書いたりファイルを編集したりする「手」にはなれます。しかし、何を先に直すのか、誰がレビューするのか、どこで止めるのか、修正が本当に閉じたのかを決めるには、別の統治層が必要です。

Meta_Kim はその層です。**AI の上にある AI** として、複雑なタスクを「推測で進めるもの」から「規律を持って進めるもの」に変えます。

### 一言でいうと

> **まず何をするかを明確にする → 次に誰がやるかを決める → 実行する → レビューする → 学びを残す → 次の実行に反映する。**

これは新しい発明ではなく、成熟したチームが当たり前にやっていることです。Meta_Kim は、その当たり前を人の気合いではなく、実行可能なシステムに落とし込んでいます。

## すぐ始める

まず試すだけなら、これで十分です。

```bash
npx --yes github:KimYx0207/Meta_Kim meta-kim
```

従来どおりに進めるなら、こちらです。

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

> 💡 **インストール後**：`setup.mjs` が成果物の場所を出力します。いつでも再確認（または前回との差分表示）したいときは、インストール先のディレクトリで `npm run meta:status` を実行してください。

新規 clone 直後は、Meta_Kim がソースファイル、生成される projection、ローカル状態を意図的に分けていると見てください。

| レイヤー | 例 | 見えるタイミング |
| --- | --- | --- |
| GitHub source | `README.md`、`AGENTS.md`、`CLAUDE.md`、`canonical/`、`config/`、`scripts/` | `git clone` 直後からリポジトリに存在します。該当する場合は `package.json` の `files` whitelist にも入ります |
| 生成される runtime projection | `.claude/`、`.codex/`、`.agents/`、`.cursor/`、`openclaw/`、`.mcp.json`、`codex/` | `node setup.mjs` または `npm run meta:sync` によりローカル生成されます。gitignored で、GitHub source ではありません |
| ローカル実行状態とグラフ出力 | `.meta-kim/`、`graphify-out/`、`tests/output/`、`task_plan.md`、`findings.md`、`progress.md` | setup、graphify、tests、governed run が必要なときだけ作られます。local-only で再生成可能です |

リポジトリを保守する場合は、まず `canonical/` と `config/contracts/workflow-contract.json` を編集し、そのあとで同期と検証を実行します（Node.js >= 22.13.0 が必要）。

```bash
npm run meta:sync
npm run meta:validate
```

読む順番は次のとおりです。

1. このファイル `README.ja-JP.md`
2. `AGENTS.md`
3. `docs/runtime-capability-matrix.md`

### プラットフォーム対応の層

Meta_Kim は、互換性のある面をすべて「完全対応」とは呼びません。対応状況を次の層で管理します。

| 層 | 製品 | 意味 |
|---|---|---|
| default formal projection | Claude Code、Codex | canonical の統治層をデフォルトで runtime 固有ファイルへ投影し、`npm run meta:sync` / `npm run meta:check` で検証します。 |
| non-default compatibility projection | OpenClaw、Cursor | 明示的に選択した場合だけ project projection を生成します。runtime 変更は maintainer handshake と tool 側の self-test evidence が必要です。 |
| candidate compatibility probe | Qoder CLI、Trae、Kiro、Windsurf / Devin Desktop Cascade、Cline、Roo Code、Continue | 公式ドキュメントで rules / instructions、skills、agents / modes、hooks、MCP、commands、memory、permission controls などの互換 primitive が確認できます。Meta_Kim では候補として追跡し、正式対応とは扱いません。 |

事実のソース: `config/runtime-compatibility-catalog.json`。

Surface compatibility は formal runtime support より弱い扱いです。adapter、profile/layout、sync tests、live validation が揃うまでは正式 projection には昇格しません。依存プロジェクト側の install target matrix は、Meta_Kim の support claim としてここでは繰り返しません。

---

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

## アーキテクチャ: 隠れた骨格 + 動的配牌

これは Meta_Kim の中核です。文書全体の中でも最も重要な章です。

### まず用語を分ける

| 概念 | 何か | 何ではないか |
| --- | --- | --- |
| **隠れた骨格** | 表層の流れの下にある、バックエンドの実行骨格 | 最初から固定された職務一覧 |
| **8 大フロー** | 隠れた骨格が実行層に現れた、人が読める主鎖 | 統治ロジックそのもの全部 |
| **11 段階業務ワークフロー** | 複雑な run に重ねる、より段階的な業務フロー | 8 大フローの置き換え |
| **配牌** | 8 大フローと agent 単位に対する動的な介入 | 単純なタスク割り当て |
| **門** | 次に進めるかどうかの放行条件 | 段階そのもの |
| **契約** | 各ノードが必ず差し出す構造化成果物 | スローガンや抽象的価値観 |
| **agent 単位ガバナンス** | 境界、能力、昇格、ロールバックを扱えるようにすること | 役割メニュー |
| **三層記憶体系** | memory / graphify / SQL が分担する長期記憶 | ひとまとめの雑多なメモ |

覚えるなら一文で十分です。

> **8 大フローが進行を担い、門が准入を担い、契約が成果物を担い、配牌が動的介入を担います。**

### 8 大フロー = 隠れた骨格

Meta_Kim には 8 つの固定実行段階があります。これを **隠れた骨格** と呼びます。

```mermaid
flowchart LR
    C[要件明確化] --> F[能力探索]
    F --> T[計画設計]
    T --> E[実行分担]
    E --> R[レビュー]
    R --> MR[メタレビュー]
    MR --> V[検証]
    V --> EV[進化]

    style C fill:#fbbf24,color:#000
    style F fill:#34d399,color:#000
    style T fill:#60a5fa,color:#000
    style E fill:#f87171,color:#fff
    style R fill:#a78bfa,color:#fff
    style MR fill:#a78bfa,color:#fff
    style V fill:#34d399,color:#000
    style EV fill:#fbbf24,color:#000
```

**Critical - まず本当の問題を確定し、後続が誤解の上に乗らないようにする**

要件が曖昧なら、推測せずに確認します。この段階では `intentPacket` を出し、ユーザーの真の意図、成功条件、除外範囲を固定します。すでに十分明確なら、なぜ飛ばすのかを明示的に記録します。

**Fetch - いきなり自作せず、既存能力を先に探す**

既存の agent、skill、ツール、MCP でこの要件を満たせるかを探索します。ここでの核心は **capability-first** です。まず必要能力を定義し、それを宣言している owner を探し、最適なものに委譲します。最初から agent 名を固定するのは、設計上の近道です。

**Thinking - 境界、owner、順序、成果物、リスク、停止条件を定義する**

タスクを分解し、各サブタスクに owner を割り当て、依存関係と並列実行の単位を定めます。この段階では `dispatchBoard` を作り、誰が何をやるか、何を並列で走らせるか、最終的な統合責任は誰かを明確にします。さらに、少なくとも 2 つの候補経路を考え、一本足にしません。

**Execution - 産物を出す。ただしまだ統治下にある**

専門 agent に委譲して実行します。各サブタスクは `workerTaskPacket` に包み、完全なファイルコンテキスト、制約、レビュー owner、検証 owner を含めます。独立したサブタスクは並列に走らせ、実行を無駄に直列化しません。**実行は完了ではありません。** このあとにレビューと検証が続きます。

**Review - 品質と境界の観点で、実行結果が妥当かを確認する**

コード品質、安全性、アーキテクチャ整合性、境界逸脱をチェックします。`reviewPacket` には findings を構造化して残し、各 finding には CRITICAL から LOW までの重大度を付けます。ここは形式上の通過点ではなく、閉じていない finding があれば次に進めません。

**Meta-Review - review の基準そのものが偏っていないかを確認する**

「レビューをレビュー」します。基準が甘ければ意味がなく、基準がずれていれば見当違いの審査になります。この段階は、審査対象だけでなく審査システム自体の品質を守ります。

**Verification - テキスト上ではなく、現実世界で本当に成立したかを確認する**

修正が review finding を本当に閉じたかを検証します。`verificationResult` と `closeFindings` を出し、閉じていなければ再修正して再検証します。ここは最も正直な門です。見た目が直っていても、閉じていなければ直ったことにはなりません。

**Evolution - 今回の学びをシステムへ書き戻す**

再利用できるパターンは memory に、失敗は傷として、能力の不足は Scout への追跡対象として、agent 境界の変更は canonical への反映候補として残します。各 run では必ず `writebackDecision` を出し、書き戻すのか、書き戻さない理由は何かを明示します。**学びを残さない run は、何も積んでいないのと同じです。**

---

この 8 段階をまとめると、これが実行の背骨です。

なぜ「相対的に」固定なのか。簡単な場面では一部を省略できるからです。ただし、省略するなら必ず理由を記録し、黙って飛ばしません。

### 11 段階業務ワークフロー = 骨格の上にある段階的ワークフロー

8 大フローが骨格なら、11 段階業務ワークフローはその上に乗る **より複雑な run 包装の進行方式** です。

```
direction → planning → execution → review → meta_review → revision → verify → summary → feedback → evolve → mirror
```

これは別物を追加しているのではなく、8 大フローから **派生** しています。違いは次のとおりです。

- **8 大フロー** は実行ロジック寄りで、「どの順で動くか」を定義します
- **11 段階業務ワークフロー** は業務統治寄りで、「各段階で何を出し、どう完了とみなし、いつ runtime mirror を更新するか」を定義します

```mermaid
flowchart TB
    subgraph spine["8 大フロー（隠れた骨格）"]
        direction LR
        C1[要件明確化] --> F1[能力探索] --> T1[計画設計] --> E1[実行分担] --> R1[レビュー] --> MR1[メタレビュー] --> V1[検証] --> EV1[進化]
    end

    subgraph workflow["11 段階業務ワークフロー"]
        direction LR
        D2[方向付け] --> P2[計画] --> EX2[実行] --> RE2[レビュー] --> MET2[メタレビュー] --> REV2[修正] --> VER2[検証] --> SUM2[要約] --> FB2[フィードバック] --> EVO2[進化] --> MIR2[ミラー更新]
    end

    C1 -.-> D2
    F1 -.-> P2
    T1 -.-> P2
    E1 -.-> EX2
    R1 -.-> RE2
    MR1 -.-> MET2
    V1 -.-> VER2
    EV1 -.-> EVO2

    style spine fill:#1e1b4b,stroke:#7c3aed,color:#e0e7ff
    style workflow fill:#14532d,stroke:#22c55e,color:#dcfce7
```

11 段階業務ワークフローには `revision`、`summary`、`feedback`、`mirror` といった段階が加わり、単に「終わる」だけでなく、「よく終わる」「正しく終わる」、そして runtime projection を同期した状態で閉じることを支えます。

### 契約 = 各ノードが必ず差し出すもの

フローだけでは不十分です。各段階が **何を差し出すべきか** を定義しなければなりません。それが契約です。

Meta_Kim の契約は、口約束ではなく **構造化されたデータパケット** です。

| 契約成果物 | どの段階か | 役割 |
| --- | --- | --- |
| `intentPacket` | Critical | 真の意図を固定し、実行中の逸脱を防ぐ |
| `dispatchBoard` | Thinking | 誰が何をするか、依存関係、並列グループ |
| `workerTaskPacket` | Execution | 各サブタスクの完全な文脈パック |
| `reviewPacket` | Review | レビュー指摘の構造化記録 |
| `revisionResponse` | Revision | 各指摘に対する修正応答 |
| `verificationResult` | Verification | 問題が本当に閉じたかの判定 |
| `summaryPacket` | Summary | 外部公開前の最終要約 |
| `evolutionWriteback` | Evolution | 学習内容の書き戻し先 |

```mermaid
flowchart LR
    subgraph packets["契約成果物の流れ"]
        direction LR
        IP[意図固定] --> DP[分派看板]
        DP --> WTP[作業パック]
        WTP --> RP[レビュー記録]
        RP --> RR[修正応答]
        RR --> VR[検証結果]
        VR --> SP[最終要約]
        SP --> EW[学習の書き戻し]
    end

    IP ~~~ C2["要件明確化"]
    DP ~~~ T2["計画設計"]
    WTP ~~~ E2["実行分担"]
    RP ~~~ R2["レビュー"]
    RR ~~~ REV2["修正"]
    VR ~~~ V2["検証"]
    SP ~~~ S2["要約"]
    EW ~~~ EV2["進化"]

    style packets fill:#1a1a2e,stroke:#e94560,color:#fff
```

これらの成果物は、ただのドキュメントではありません。システムが事実として参照する **現実のソース** です。契約がなければ、次の段階は「引き継ぐ」のではなく「前段が何を言いたかったかを推測する」ことになります。それが複雑な AI 協業で破綻が起きる典型原因です。

### 門 = 段階に着いたからといって、通過したわけではない

契約は「何を出すか」を定義し、門は「それで通してよいか」を判定します。

一言で言えば次のとおりです。

> **段階は、どこまで来たかを示す。門は、次へ進む資格があるかを示す。**

```mermaid
flowchart LR
    A["ある段階に到達"] --> B{"門の判定"}
    B -->|通過| C["放行: 次へ進む"]
    B -->|不通過| D["再修正: 証拠や成果物を補う"]
    B -->|保留| E["待機: 条件成熟を待つ"]
    B -->|昇格| F["上位レイヤーが介入"]

    style A fill:#dbeafe,stroke:#2563eb,color:#000
    style B fill:#7c3aed,stroke:#4c1d95,color:#fff
    style C fill:#dcfce7,stroke:#16a34a,color:#000
    style D fill:#fee2e2,stroke:#dc2626,color:#000
    style E fill:#e0f2fe,stroke:#0284c7,color:#000
    style F fill:#fef3c7,stroke:#f59e0b,color:#000
```

現在のシステムにある主要な門は次のとおりです。

| 門 | 何を止めるか | 通過条件 |
| --- | --- | --- |
| **planning gate** | 計画から実行へ入る前 | 境界、owner、成果物、リスクが定義済み |
| **metaReview gate** | メタレビューが妥当か | レビュー基準そのものに偏り、漏れ、緩みがない |
| **verify gate** | 修正が本当に閉じたか | finding → revision → verification が閉じている |
| **summary gate** | 外部公開してよいか | 検証完了 + 要約完了 |
| **publicDisplay gate** | 「完了した」と宣言してよいか | `verifyPassed + summaryClosed + singleDeliverableMaintained + deliverableChainClosed` |

最重要なのは **publicDisplay gate** です。検証が通っていない、要約が閉じていない、成果物チェーンが切れているなら、「完了」と言ってはいけません。

門と契約の関係は次のとおりです。

- **契約** は「各段階が何を出すか」を決めます。これは成果物契約です
- **門** は「それで通すか」を決めます。これは准入判定です
- 契約がなければ門は判断できず、門がなければ契約は形だけになります

### 動的配牌 = 隠れた骨格に柔軟性を足す

8 大フローの骨格は固定に近いですが、現実のタスクは毎回違います。そこで Meta_Kim は **動的配牌** を導入しています。

配牌は 8 大フローに対応しますが、1:1 の単純対応ではありません。10 枚の牌があります。

| 牌 | 発火条件 | 注意コスト |
| --- | --- | --- |
| **Clarify（明確化）** | 要件が曖昧 | 低 |
| **Shrink scope（スコープ縮小）** | リポジトリが大きすぎる、ファイルが多すぎる | 低 |
| **Options（選択肢）** | 要件は明確だが経路が複数ある | 中 |
| **Execute（実行）** | 方針が決まった | 高 |
| **Verify（検証）** | 実行が終わった | 中 |
| **Fix（修正）** | 検証に失敗した | 中 |
| **Rollback（巻き戻し）** | リスクが拡大した | 高 |
| **Risk（リスク）** | 安全・全体・複数当事者が絡む | 高 |
| **Nudge（促し）** | ユーザーが詰まっているので軽く後押しする | 低 |
| **Pause（停止）** | 高コスト牌が 3 枚続いたら強制休止 | ゼロ |

重要なのは、**一部の牌が動的に差し込まれる**ことです。これにより、固定骨格では吸収しきれない現実の揺れを補えます。

- 高注意コストの牌が 3 枚続いたら、システムは自動で **Pause（停止）** を挿入します
- 安全上のリスクが出たら、**Risk** が現在の流れを中断します
- すでに分かっていることは、該当牌を **スキップ** して無駄を減らします
- 反復回数が上限を超えたら、**Warden** に裁定を上げます

固定骨格があるからこそ底が抜けず、動的配牌があるからこそ状況に合わせて呼吸できます。

```mermaid
flowchart TD
    START[現在の牌が完了] --> SKIP{次の牌の<br/>スキップ条件}
    SKIP -->|満たす, スキップ| NEXT[次の牌へ]
    SKIP -->|満たさない| INTR{割り込み待ち行列}
    INTR -->|安全リスクが優先| RISK[リスク牌<br/>最優先]
    INTR -->|割り込みなし| PAUSE{高コスト牌が<br/>3 枚以上連続?}
    PAUSE -->|はい, 強制休止| P[停止牌<br/>ゼロ注意]
    PAUSE -->|いいえ| DEAL[優先度に従って配牌]
    RISK --> DEAL
    P --> DEAL
    DEAL --> COUNT{反復回数が<br/>上限超過?}
    COUNT -->|はい| WARDEN[監督役へ昇格]
    COUNT -->|いいえ| START

    style RISK fill:#dc2626,color:#fff
    style P fill:#1e3a5f,color:#93c5fd
    style WARDEN fill:#7c3aed,color:#fff
    style DEAL fill:#16a34a,color:#fff
```

### 閉ループ = 反復、生成、改善が止まらないこと

骨格、段階的ワークフロー、契約、動的配牌が揃うと、完全な **閉ループ** になります。

```
要件が入る → 骨格が始動する → 配牌を決める → 分派して実行する → レビューと検証を行う → 学びを残す → agent を更新する → 次の回はもっと強くなる
```

この閉ループは一回きりではありません。各ラウンドで次のことが起こります。

1. **対応する agent を生成する** - 能力不足が見つかれば、Type B パイプラインで新しい agent を作成します
2. **agent の能力を高める** - Evolution の書き戻しにより、SOUL.md、スキル負荷、ツールチェーンを継続改善します
3. **各 agent の境界を明確にする** - 各 agent は一つの仕事に集中し、越境は Sentinel が止めます

```mermaid
flowchart TD
    INPUT[要件が入る] --> SPINE[隠れた骨格が始動]
    SPINE --> CARD[動的配牌の判断]
    CARD --> DISPATCH[専門 Agent へ分派]
    DISPATCH --> REVIEW[レビュー + 検証]
    REVIEW --> |通過| EVOLVE[学びの蓄積]
    REVIEW --> |不通過| FIX[修正 + 再レビュー]
    FIX --> REVIEW
    EVOLVE --> UPGRADE[Agent 能力の更新]
    UPGRADE --> |能力不足を発見| CREATE[タイプB パイプライン<br/>新規エージェントを自動作成]
    UPGRADE --> |境界調整が必要| BOUNDARY[エージェント境界を調整]
    CREATE --> INPUT2[次の回はさらに強く]
    BOUNDARY --> INPUT2

    style INPUT fill:#fbbf24,color:#000
    style EVOLVE fill:#34d399,color:#000
    style CREATE fill:#f87171,color:#fff
    style INPUT2 fill:#fbbf24,color:#000
```

### Agent 境界 + skill の統合

9 つのメタ役割はそれぞれ担当範囲が分かれています。

| 役割 | 職責 | やらないこと |
| --- | --- | --- |
| **meta-warden** | 調整、仲裁、最終統合 | 直接コードを書かない |
| **meta-conductor** | ワークフロー、リズム制御 | 安全チェックをしない |
| **meta-genesis** | Agent 設計、SOUL.md | ツール選定をしない |
| **meta-artisan** | skill、MCP、ツールの適合 | agent の人格設計をしない |
| **meta-sentinel** | 安全、権限、ロールバック | リズムを組まない |
| **meta-librarian** | 記憶、連続性 | コードを実行しない |
| **meta-prism** | 品質レビュー、反スロップ | 能力探索をしない |
| **meta-scout** | 外部能力の発見 | 内部調整をしない |
| **meta-chrysalis** | 進化書き戻し、scar 記録、再帰安全ゲート | 自分自身を進化させず、Warden gate を迂回しない |

各 agent は必要に応じて、さまざまな **skill** や **command** を読み込みます。Meta_Kim には 9 個のコミュニティ skill が同梱されており、独自拡張も可能です。

```mermaid
flowchart TD
    WARDEN[meta-warden<br/>調整/仲裁/統合] --> CONDUCTOR[meta-conductor<br/>ワークフロー/リズム]
    WARDEN --> GENESIS[meta-genesis<br/>Agent 設計]
    WARDEN --> ARTISAN[meta-artisan<br/>skill/ツール適合]
    WARDEN --> SENTINEL[meta-sentinel<br/>安全/権限/ロールバック]
    WARDEN --> LIBRARIAN[meta-librarian<br/>記憶/連続性]
    WARDEN --> PRISM[meta-prism<br/>品質レビュー]
    WARDEN --> SCOUT[meta-scout<br/>外部能力の発見]
    WARDEN --> CHRYSALIS[meta-chrysalis<br/>進化書き戻し]

    GENESIS -.-> |SOUL.md| ARTISAN
    ARTISAN -.-> |skill 負荷| GENESIS
    CONDUCTOR -.-> |タスク看板| WARDEN
    SENTINEL -.-> |安全遮断| WARDEN
    PRISM -.-> |レビュー報告| WARDEN
    SCOUT -.-> |候補能力| ARTISAN
    LIBRARIAN -.-> |文脈記憶| WARDEN

    SKILLS[9 個のコミュニティ skill<br/>+ 独自拡張] --> ARTISAN
    HOOKS[Hook 自動化<br/>遮断/整形/検査] --> SENTINEL

    style WARDEN fill:#7c3aed,color:#fff
    style CONDUCTOR fill:#60a5fa,color:#000
    style GENESIS fill:#fbbf24,color:#000
    style ARTISAN fill:#34d399,color:#000
    style SENTINEL fill:#f87171,color:#fff
    style LIBRARIAN fill:#a78bfa,color:#fff
    style PRISM fill:#fb923c,color:#000
    style SCOUT fill:#2dd4bf,color:#000
```

### Hook 自動化

Claude Code では、Meta_Kim は **Hook** によって自動化されています。

- **危険コマンドの遮断** - `rm -rf` や `DROP TABLE` などは自動で止めます
- **Git push の注意喚起** - push 前に確認を促します
- **整形** - JS/TS の編集後に自動整形します
- **型チェック** - 編集後に TypeScript のチェックを走らせます
- **console.log の警告** - `console.log` を見つけたら削除を促します
- **セッション終了時の監査** - 終了前に未解決問題を確認します
- **セッション終了時のメモリ保存** - セッション終了時に要約を MCP Memory Service に書き込みます
- **子 agent への文脈注入** - プロジェクト文脈を自動で注入します

これらの Hook は「あると便利」ではなく、統治システムの実行面です。

### クロスプラットフォーム映射

**新しい platform は、Meta_Kim に対応できる primitive を持つ場合に候補として評価できます。ただし、profile、layout、sync、tests、evidence が揃うまでは正式 projection ではありません。**

Meta_Kim は現在 2 つの default formal projection target と、2 つの non-default compatibility projection target を持ちます。

| プラットフォーム | 状態 | 映射方法 |
| --- | --- | --- |
| **Claude Code** | default formal projection | `.claude/agents/*.md` + `SKILL.md` + hooks + MCP |
| **Codex** | default formal projection | generated local `.codex/agents/*.toml` + `.agents/skills/` + commands + hooks |
| **OpenClaw** | non-default compatibility projection; maintainer handshake required | `openclaw/` workspaces + skills + internal hooks |
| **Cursor** | non-default compatibility projection; maintainer handshake required | `.cursor/agents/*.md` + `.cursor/rules/*.mdc` + skills + hooks + MCP |

Meta_Kim は Qoder CLI、Trae、Kiro、Windsurf / Devin Desktop Cascade、Cline、Roo Code、Continue も candidate compatibility probe として追跡しています。これらは公式ドキュメントで互換 primitive が確認できますが、setup は project projection を生成しません。promotion には runtime profile、projection layout、generated paths、sync tests、install policy、live または official probe evidence が必要です。

中核ロジックは同じで、`canonical/` が共通の正典ソースです。同期スクリプト `npm run meta:sync` により、正式 projection target の構造へ投影されます。

Open-source boundary: 生成された runtime projection directory は local output で、`.gitignore` により GitHub source には入りません。対象は `.claude/`、`.codex/`、`.agents/`、`.cursor/`、`openclaw/`、`.mcp.json`、`codex/` です。9 つの governance agent の唯一の source は `canonical/agents/` で、Codex adapter / business-role `.toml` は host 用にローカル生成できますが、force-add や package source への同梱は禁止です。

```mermaid
flowchart TB
    CANONICAL["canonical/<br/>統一ソース層"]

    CANONICAL --> |npm run meta:sync| CLAUDE[".claude/<br/>Claude Code<br/>エージェント・スキル・フック"]
    CANONICAL --> |npm run meta:sync| CODEX[".codex/<br/>Codex<br/>エージェント定義・スキル・フック"]
    CANONICAL --> |npm run meta:sync| OPENCLAW["openclaw/<br/>OpenClaw<br/>ワークスペース・スキル・フック"]
    CANONICAL --> |npm run meta:sync| CURSOR[".cursor/<br/>Cursor<br/>エージェント・スキル・フック・MCP"]

    CANDIDATE["candidate probes<br/>Qoder / Trae / Kiro / Cascade / Cline / Roo / Continue"] -.-> |promotion requires profile + layout + tests + evidence| CANONICAL

    style CANONICAL fill:#7c3aed,color:#fff
    style CLAUDE fill:#fbbf24,color:#000
    style CODEX fill:#34d399,color:#000
    style OPENCLAW fill:#60a5fa,color:#000
    style CURSOR fill:#f87171,color:#fff
    style CANDIDATE fill:#555,color:#aaa
```

新しい platform は順次追加できますが、候補から正式 projection への昇格は adapter 形態と検証可能性が揃ってからです。

4 つの projection family は同じ canonical source から生成されますが、native surface は異なります。Claude Code と Codex は default formal projection、OpenClaw と Cursor は maintainer handshake と native self-test evidence が必要な non-default compatibility projection です。

| 能力面 | Claude Code | Codex | OpenClaw | Cursor |
| --- | --- | --- | --- | --- |
| **agent** | native agents/subagents、プロジェクト級とユーザー級が成熟 | custom agents/subagents が強力 | workspace 型 agent、agent-to-agent 対応 | agent 投影は使えるが軽量 |
| **skill / references** | native skill、references、グローバル skill エコシステムが充実 | `.agents/skills/` がプロジェクト skill ルート | workspace skill + installable skill | `.cursor/skills/` による軽量接続 |
| **hook / 自動化** | project hooks + settings.json + 拡張エコシステム | trusted `.codex/hooks.json` project/user hooks | internal lifecycle hooks。blocking/canceling policy には typed plugin hooks が必要 | `.cursor/hooks.json` lowerCamel lifecycle hooks と `preToolUse` / `failClosed` |
| **MCP / 設定** | native MCP と設定面が充実 | runtime adapter と MCP を接続可能 | workspace config が明確 | MCP は接続可能だが全体は軽量 |
| **統治閉ループの受け皿** | Claude-native surface で完全対応 | Codex-native surface で完全対応 | OpenClaw-native surface で互換対応。tool-denial 変更は strict self-test evidence が必要 | Cursor-native surface で互換対応。official hook gate と project rule を保持 |

重要なのは順位付けではなく互換 discipline です。各 formal target は、自分の agent、skill、hook、MCP、choice、config surface を保ち、別 host の形式を universal format として扱いません。

### リポジトリの四層構造

| 層 | 位置 | 役割 |
| --- | --- | --- |
| **canonical の正典層** | `canonical/`、`config/contracts/workflow-contract.json` | 長期保守ではまずここを編集 |
| **ランタイム投影層** | `.claude/`、`.codex/`、`openclaw/`、`.cursor/` | 同じ能力を別ランタイムへ投影 |
| **ローカル状態層** | `.meta-kim/state/{profile}/`、`.meta-kim/local.overrides.json` | profile 単位の状態、run index、継続性 |
| **スクリプトと検証層** | `scripts/`、`npm run *` | 同期、検証、発見、受け入れ |

### 三層状態（プロジェクト級 / グローバル級 / ローカル級）

この 3 層は混同しやすいので、はっきり分けて考えます。

| レイヤー | 保管先 | 決めること |
| --- | --- | --- |
| **プロジェクト級** | 現在のリポジトリにある `canonical/`、contracts、runtime projections、ドキュメント、スクリプト | このプロジェクトが何を定義するか |
| **グローバル級** | `~/.claude/`、`~/.codex/`、`~/.openclaw/`、`~/.cursor/`、`~/.meta-kim/global/` | このマシンで何を検出できるか |
| **ローカル級** | `.meta-kim/state/{profile}/run-index.sqlite`、`compaction/`、`profile.json` | この profile の run が何を残したか |

#### `.meta-kim/` の中身

`.meta-kim/` は Meta_Kim のローカルセーブデータです。3 つの役割があります：

**1. 選択を記憶する** — `local.overrides.json`

初めて `node setup.mjs` を実行して「Claude Code と Codex を使う」と選んだ内容がここに保存されます。次回 setup を実行する際、再度選ぶ必要がありません。

*例：Claude Code、Codex、OpenClaw の 3 つがインストールされているが、最初の 2 つだけ使いたい場合。このファイルにその設定が保存され、すべてのスクリプトがどのランタイムにスキルをインストールすべきか判断します。*

**2. 作業履歴を記録する** — `state/{profile}/run-index.sqlite`

ガバナンスワークフロー（例：「8-stage spine でコードをレビューする」）を実行した結果は、SQLite データベースに索引付けできます。後から「前回何をレビューしたか、誰が実行したか、結果はどうだったか」を照会できます。

*例：先週 meta-prism に認証モジュールのレビューを依頼しました。今週また認証モジュールを変更しました。システムが `.meta-kim/state/` を確認すると「前回のレビューで 3 つの問題が見つかり、2 つは修正済み、1 つは未解決」と分かり、改めて説明する必要がありません。*

**3. セッション間の復旧** — `state/{profile}/compaction/`

会話の途中でトークンが尽きてセッションが切れた場合、compaction パケットが現在の進捗（どのステップまで完了したか、何が未処理か）を保存し、新しいセッションで続きから再開できます。

*例：Meta_Kim に複雑な複数ファイルのリファクタリングを依頼し、ステップ 6 まで完了してセッションが終了しました。次のセッションで、システムが compaction パケットを読み取り「ステップ 6 完了、ステップ 7 は未着手」を確認 — ステップ 7 から再開でき、最初からやり直す必要がありません。*

**その他のファイル：** `doctor-cache/` は `npm run meta:doctor:governance` の実行結果を保存（各実行後に書き込み）、`migrations/` はバージョン間のデータ構造アップグレードを追跡、`profile.json` はプロファイルのメタデータです。すべてスクリプトが自動管理するため、手動で編集する必要はありません。

**クイックリファレンス：**

| パス | 役割 | いつ書き込まれるか |
| --- | --- | --- |
| `local.overrides.json` | `setup.mjs` で選択したランタイムを記憶 | 自動 — 初回 `setup.mjs` 実行時 |
| `state/{profile}/profile.json` | プロファイルのメタデータ（作成日時、名前） | 自動 — `setup.mjs` が `default` プロファイルを作成 |
| `state/{profile}/run-index.sqlite` | ガバナンス run のインデックス — 誰が何を実行したか、何が見つかったか、何が未解決か | オンデマンド — `npm run meta:index:runs -- <artifact>` |
| `state/{profile}/compaction/` | セッション間の引き継ぎパケット：未完了のステップ、未処理の発見、未閉鎖の検証ゲート | オンデマンド — セッションをまたぐ場合に書き込み |
| `state/{profile}/doctor-cache/` | `npm run meta:doctor:governance` のキャッシュ結果 | オンデマンド — `doctor:governance` 実行後に書き込み |
| `state/{profile}/migrations/` | 状態移行の追跡（バージョン間のスキーマアップグレード） | 自動 — バージョン間で状態スキーマが変更された時 |

### グローバル導入後の対応状況

Meta_Kim の門とプロトコルは 4 層の実行保障があります。グローバル導入（`node setup.mjs`）後、任意のプロジェクトで利用する場合：

| 実行層 | グローバル導入で利用可能 | Meta_Kim リポジトリが必要 |
| --- | --- | --- |
| **Prompt 層**（agents + skills に定義された門・プロトコルルール） | 対応 — `~/.claude/skills/` と `~/.claude/agents/` に導入済み、AI は prompt に従う | — |
| **Hook 層**（セッション終了時の門チェック、MCP Memory Service へのメモリ保存、危険コマンド遮断） | 対応 — `.claude/settings.json` に設定済み | — |
| **設定層**（workflow-contract.json のプロトコルフィールド定義） | 対応 — プロトコルルールは skill prompt に組み込み済み | — |
| **コード検証**（`npm run meta:validate:run` による packet chain のハードチェック） | — | 必要 — スクリプトは `scripts/validate-run-artifact.mjs` にあり |

最初の 3 層は主要な防衛線であり、グローバル導入後は任意のプロジェクトで動作します。コード検証は最後の安全ネットであり、Meta_Kim リポジトリディレクトリから実行する必要があります。

---

## 三層記憶体系

## Three-Layer Memory

Meta_Kim の記憶は一枚岩ではありません。3 層に分かれ、各層が役割分担しながら、agent が継続的に学び、プロジェクトに馴染んでいきます。

各層の有効化方式はそれぞれ異なります。
- **第一層** は Claude Code に組み込み——Claude Code ランタイムが必要（`~/.claude/projects/*/memory/` で自動読み書き）
- **第二層** は `node setup.mjs` が自動インストール
- **第三層** は `node setup.mjs` がインストールしますが、サーバーの手動起動が必要です（下の第三層の有効化説明を参照）

### 第一層: 記憶（Agent 更新記憶）

- **何を担うか**: agent の更新と継続学習
- **保存先**: `.claude/projects/*/memory/`
- **動き**: 各 run の終了前に memory を読み、agent を更新するか、境界を調整するかを判断します
- **価値**: 使うほど賢くなり、毎回ゼロから始めなくて済みます
- **有効化**: 自動。AI が各セッションで memory を自動的に読み書きします
- **問い合わせ**: AI に直接聞きます。「前回のセッションで、このプロジェクトについて何を学びましたか？」

### 第二層: Graphify（プロジェクト級 LLM Wiki）

- **何を担うか**: プロジェクト単位のコード知識グラフ
- **保存先**: `graphify-out/graph.json`（NetworkX のノードリンク形式）。深く読む場合は同ディレクトリの `GRAPH_REPORT.md` を優先
- **動き（データ）**: `node setup.mjs` のオプション Python 手順は graphify を入れ、**冪等に** `python -m graphify claude install` と `python -m graphify hook install` を実行（pip で既に入っていても hook を補完）。git hook は **現在のリポジトリ** で commit/checkout 時に再構築。`npm run meta:graphify:install` も同様（hook 含む）。
- **Windows の既存プロジェクト移行**: Claude プロジェクトで `C:Users...graphify.EXE: command not found` が残る場合、そのプロジェクト内で `meta-kim doctor hooks --fix` を実行します。`.claude/settings.json` をバックアップし、既知の危険な Graphify Hook 形式だけを修復します。ユーザー設定も確認する場合のみ `--all` を使います。
- **動き（利用）**: 同期済み meta-theory の `dev-governance.md` Fetch **Step 0.5** がモデル側の検出・利用ルール。バックグラウンド常駐ではない。Claude Code 子エージェントは `subagent-context.mjs` で**短いヒント**のみ。Codex / OpenClaw / Cursor は SubagentStart hook がないが `sync:runtimes` 後は同じ参照を共有。他ランタイムは**対象リポジトリ**で `python -m graphify codex install` や `claw install` を任意で（`python -m graphify --help`）。
- **価値**:
  - ただのコード文字列ではなく、構造と関係を理解できます
  - **幻覚を大きく減らします** - 記憶で捏造せず、グラフの事実に基づいて答えます
  - **token 消費を大きく減らします** - 元ファイルの読み直しではなく、サブグラフ抽出で代替します
- **品質基準**:
  - あいまいノードが 30% 超 → 低品質グラフとして扱い、直接ファイル読み込みへ戻す
  - 総ノード数が 10 未満 → グラフが疎すぎるので Glob/Grep へ戻す
  - 「神ノード」（入次数が高すぎる）→ 直列ボトルネックとして扱う
- **有効化**: オプション Python 手順の `node setup.mjs` または `npm run meta:graphify:install`。インストール/確認、networkx、Claude 側登録、**対象リポジトリ**の git hook を扱います。初回グラフ生成は hook 実行または手動ビルドに依存します
- **問い合わせ**: `python -m graphify query "あなたの質問"`。自然言語でコードグラフにクエリします

### プラットフォーム自動化比較

| 機能 | Claude Code | Codex | OpenClaw | Cursor |
| --- | --- | --- | --- | --- |
| PreToolUse hook（Glob/Grep 前の自動プロンプト） | ✅ settings.json | ✅ trusted `.codex/hooks.json` | ❌ | ✅ `.cursor/hooks.json` `preToolUse` |
| スラッシュコマンド `/graphify` | ✅ | ✅ | ✅ | ✅ |
| git hook 自動再構築（post-commit/checkout） | ✅ | ✅ | ✅ | ✅ |
| AGENTS.md 常駐ルール | N/A | ✅ | ✅ | ✅ |
| setup.mjs マルチプラットフォーム導入 | ✅ claude | ✅ codex | ✅ claw | ✅ cursor |

**要点**: Claude Code、Codex、Cursor はいずれも native hook 設定を持ちますが、schema は同じではありません。OpenClaw は独自の internal/plugin hook model を使います。graph awareness は `AGENTS.md` と synced `meta-theory` reference でも維持されるため、native hook がない場面では明示的に低下モードとして扱います。

マルチプラットフォーム導入は `node setup.mjs` を実行してください。選択した全プラットフォームを巡回し、各プラットフォームに対して `graphify <platform> install` を冪等に実行します。

### 第三層: SQL（ベクトル級セッション検索）

- **何を担うか**: プロジェクト会話のベクトル保存と検索
- **保存方式**: SQLite + ベクトル拡張（sqlite-vec）
- **動き**: 各会話の重要情報をベクトル化し、次回は意味的類似度で検索します
- **価値**:
  - 会話の継続性 - 前回の続きから自然に始められます
  - ベクトル検索 - キーワード一致ではなく意味理解で探します
  - 精度の高い想起 - 履歴会話から最も関連の強い文脈を引けます
- **有効化**: `node setup.mjs` が MCP Memory Service（第三層）をインストール・設定し、各 runtime の memory hooks を登録したうえで、HTTP サービスのバックグラウンド起動も試みます。
  - **Claude Code**: SessionStart Hook と Stop メモリ保存 Hook は `node setup.mjs` 時に自動登録；セッション開始時に `mcp_memory_global.py --mode session` でプロジェクト状態を書き込みます
  - **Codex / Cursor / OpenClaw**: Codex と Cursor は native hooks JSON、OpenClaw は managed hook を自動登録します。
- **サーバー起動**: `memory server --http`（macOS/Linux では `MCP_ALLOW_ANONYMOUS_ACCESS=true`、Windows PowerShell では `$env:MCP_ALLOW_ANONYMOUS_ACCESS="true"` を設定）、次に `http://localhost:8000` にアクセス。
- **ポート**: サーバーと Meta_Kim hooks は `http://localhost:8000` を使用します。
- **Hook**: Claude Code は自動登録（SessionStart でプロジェクト状態書き込み、Stop でセッション要約を MCP Memory に保存）；他のツールは mcp-memory-service ドキュメントを参照
- **MCP 登録と書き込みの違い**: `.mcp.json` はクライアントアクセス用に MCP Memory server（`memory server`）を登録します。自動セッション書き込みは別の lifecycle hooks が行います。Claude Code は `stop-memory-save.mjs`、Codex/Cursor は `meta-kim-memory-save.mjs`、OpenClaw は managed `mcp-memory-service` hook を使用します。
- **クエリ**: `npm run meta:query:runs -- --owner <agent>`——agent ごとに過去の run を検索、または `npm run meta:index:runs -- <artifact>` で手動インデックス化

### 三層の協調

```mermaid
flowchart TB
    subgraph memory["第一層: 記憶"]
        M_IN[run 終了前に<br/>記憶を読む] --> M_JUDGE[エージェントを更新するか<br/>判断する]
        M_JUDGE --> M_OUT[境界を更新し<br/>能力を調整する]
    end

    subgraph graphify["第二層: グラフ化"]
        G_IN[ソースファイルが 20 超のとき<br/>自動でグラフ生成] --> G_COMPRESS[サブグラフ抽出で<br/>最大 71 倍圧縮]
        G_COMPRESS --> G_QUERY[グラフの事実に基づいて<br/>エージェントが回答]
    end

    subgraph sql["第三層: SQL"]
        S_IN[会話の重要情報を<br/>ベクトルとして保存] --> S_INDEX[SQLite + sqlite-vec<br/>ベクトル索引]
        S_INDEX --> S_RECALL[意味的類似度で<br/>高精度に想起]
    end

    memory <--> graphify
    graphify <--> sql
    sql <--> memory

    GOAL1[幻覚を減らす<br/>事実に基づく回答]
    GOAL2[token を減らす<br/>全文読みではなく圧縮で代替]

    memory --> GOAL1
    graphify --> GOAL1
    graphify --> GOAL2
    sql --> GOAL2

    style memory fill:#fbbf24,color:#000
    style graphify fill:#34d399,color:#000
    style sql fill:#60a5fa,color:#000
    style GOAL1 fill:#dc2626,color:#fff
    style GOAL2 fill:#dc2626,color:#fff
```

三層記憶が一緒に働くことで、次の 2 つを実現します。

1. **幻覚を大幅に減らす** - agent が勝手に捏造せず、事実と文脈に基づいて答える
2. **token 消費を大幅に減らす** - 全文読みの代わりにグラフ圧縮、力任せの検索の代わりにベクトル検索を使う

---

## 運用コマンド早見

### 日常利用

| コマンド | 役割 |
| --- | --- |
| `node setup.mjs` | 対話式のインストール / 更新 / 検証ウィザード |
| `git pull --ff-only` | clone した利用者が GitHub から最新の Meta_Kim ソースを取得する |
| `node setup.mjs --update` | 現在のインストール済み投影、skill、依存関係を更新する。Meta_Kim ソースは取得しない |
| `node setup.mjs --check` | 環境チェック（書き込みなし） |
| `node setup.mjs --lang zh-CN` | 中国語 UI を指定 |

### 同期と検証

| コマンド | 役割 |
| --- | --- |
| `npm run meta:sync` | canonical から 4 つのランタイムへ同期 |
| `npm run meta:check:runtimes` | 4 つのランタイムが同期しているか確認 |
| `npm run meta:validate` | プロジェクト整合性の検証 |
| `npm run meta:verify:all` | フル検証（runtime smoke を含む） |
| `npm run meta:doctor:governance` | ガバナンスの健全性チェック |

### skill と依存

| コマンド | 役割 |
| --- | --- |
| `npm run meta:deps:install` | デフォルトの Claude Code + Codex 経路へ 9 個のコミュニティ skill をインストール |
| `npm run meta:deps:install:all-runtimes` | Claude Code、Codex、OpenClaw、Cursor へ明示的にインストール |
| `npm run meta:deps:install:claude-plugins` | Claude Code marketplace plugin のみインストール |
| `npm run discover:global` | グローバル能力をスキャン |
| `npm run meta:sync:global` | meta-theory をユーザー級へ同期 |

#### Plugin marketplace 系 skill（Superpowers、Everything Claude Code、cli-anything）

ネイティブの plugin marketplace を持つのは Claude Code のみ。**Codex / OpenClaw / Cursor** 向けには、インストーラが upstream bundle から runtime 固有のサブツリーを sparse-checkout で抽出する：

| Runtime | 優先チェーン |
| --- | --- |
| Claude Code | ネイティブ `claude plugin install <spec>@<marketplace>`（`claudePlugin` 未設定の skill は `skills/` にフォールバック） |
| Codex | `.codex/` → `.codex-plugin/` → `skills/` |
| Cursor | `.cursor/` → `.cursor-plugin/` → `skills/` |
| OpenClaw | `skills/` |
| opencode | `.opencode/` → `skills/` |
| Qwen | ECC は `npx --yes --package ecc-universal@latest ecc install --profile core --target qwen` を使います |
| Zed、Gemini、CodeBuddy、Antigravity、JoyCode | ECC は project-local です。各プロジェクトルートで `npx --yes --package ecc-universal@latest ecc install --profile core --target <target>` を実行します |
| Qoder CLI | candidate probe のみです。`.qoder/` → `skills/` の探索は可能ですが、upstream ECC が `qoder` を列挙していないため ECC install は実行しません |
| Trae、Kiro、Windsurf / Devin Desktop Cascade、Cline、Roo Code、Continue | candidate probe のみです。互換 primitive は `config/runtime-compatibility-catalog.json` で追跡しますが、adapter、sync path、validation suite が揃うまでは install / projection しません |

抽出結果は `~/.<runtime>/skills/<id>/` に配置される。インストール/更新で Enter を押すと、デフォルトは Claude Code + Codex になる。Claude marketplace plugin のみをインストールするには `npm run meta:deps:install:claude-plugins`、Claude Code、Codex、OpenClaw、Cursor を明示的にカバーするには `npm run meta:deps:install:all-runtimes`。**アップグレード時に手動クリーンアップは不要**：旧版の full-repo clone 残留はターゲットディレクトリ直下の `.claude-plugin/` マーカーで自動検出され、次回実行時に再抽出される。

### 上級運用

| コマンド | 役割 |
| --- | --- |
| `npm run meta:validate:run -- <file.json>` | ガバナンス run の成果物を検証 |
| `npm run meta:eval:agents` | 軽量な runtime smoke テスト |
| `npm run meta:eval:agents:live` | 実際の prompt を使った受け入れ検証 |
| `npm run meta:probe:clis` | ローカル CLI ツールを検出 |
| `npm run meta:test:mcp` | MCP の自己テスト |
| `npm run meta:index:runs -- <dir>` | 検証済み run 産物を索引化 |
| `npm run meta:query:runs -- --owner <agent>` | run index を検索 |
| `npm run migrate:meta-kim -- <dir> --apply` | 旧版の prompt pack を取り込む |

---

## FAQ

### Q: `npx` でインストールしましたが、ファイルはどこにありますか?

Meta_Kim はインストール範囲と実行時のプロジェクト定着を分けて扱います：

1. **グローバルを選択** — ホームディレクトリの `~/.claude/`、`~/.codex/`、`~/.cursor/`、`~/.openclaw/` に共有能力を配置します。
2. **プロジェクトを選択** — 明示的に選んだ現在のプロジェクトへランタイム投影を配置します。
3. **実行時の能力定着** — 後の governed run が Agent、Skill、Command を新規作成または反復する場合、プロジェクト内へ独立コピーを作り、依存関係の更新で上書きされない ownership を記録します。

意図的な例外があります。グローバルのインストール／更新時に、有効な Meta_Kim bootstrap manifest を持つ既存プロジェクトが見つかった場合は、グローバル環境を更新しながら、そのプロジェクト自身に保存されたランタイム対象と merge/delta 方針で既存投影も更新します。新しいプロジェクト投影は作成せず、プロジェクトに定着した能力やユーザーファイルは上書きしません。

グローバルインストール後は任意のディレクトリで `meta-kim status` を実行して完全なフットプリントを確認できます。

### Q: Meta_Kim と普通の AI コーディング支援の違いは何ですか?

普通の AI コーディング支援は、聞かれたことをそのままやります。Meta_Kim はその間に統治層を挟みます。まず何を求めているかを確定し、次に誰がやるかを決め、実行後はレビューし、検証し、学びを残します。**単なる AI ではなく、AI に工程規律を持たせる仕組みです。**

### Q: 1 ファイルだけの修正にも Meta_Kim は必要ですか?

**必要ありません。** Meta_Kim が解くのは、複数ファイル、複数モジュール、複数能力の協調が必要な複雑タスクです。1 つの関数を 1 つ直すだけなら、通常の Claude Code で十分です。大砲で蚊を撃つ必要はありません。

### Q: 8 大フローと 11 段階業務ワークフローの関係は何ですか?

8 大フローは **実行の骨格** です。`Critical → Fetch → Thinking → Execution → Review → Meta-Review → Verification → Evolution` という固定に近い流れです。11 段階業務ワークフローは、その骨格から派生した **run 包装ワークフロー** で、`direction → planning → execution → review → meta_review → revision → verify → summary → feedback → evolve → mirror` のように、成果物の流れ、完了判定、runtime mirror の更新をより細かく扱います。11 段階業務ワークフローは 8 大フローを置き換えません。

### Q: 動的配牌とは何ですか?

8 大フローは固定ですが、現実のタスクは毎回違います。配牌は、その固定骨格に柔軟性を足す仕組みです。たとえば、高強度の作業が 3 連続なら `Pause` を自動挿入し、安全問題が出れば `Risk` が現在の流れを止めます。**固定骨格が土台を守り、動的配牌が適応性を守ります。**

### Q: 三層記憶は重くないですか?

重くありません。3 層は役割が違います。

- Memory は軽いです。数個の markdown ファイル程度です
- Graphify はソースが 20 ファイルを超えるプロジェクトで有効になり、一度作れば再利用できます
- SQL はローカル SQLite を使うので、別の DB サービスは要りません

合計のコストは、毎回プロジェクト全体をゼロから読ませる token 消費よりずっと小さくなります。

### Q: どのプラットフォームに対応していますか?

Claude Code と Codex は default formal runtime projection です。OpenClaw と Cursor は maintainer handshake と native self-test evidence が必要な non-default compatibility projection です。Qoder CLI、Trae、Kiro、Windsurf / Devin Desktop Cascade、Cline、Roo Code、Continue は candidate probe です。公式ドキュメントで互換 primitive は確認できますが、Meta_Kim の正式 runtime projection ではありません。依存プロジェクト側の install target は upstream project で管理されるため、Meta_Kim の support claim としては繰り返しません。正確な境界は `config/runtime-compatibility-catalog.json` を参照してください。

### Q: インストールは難しいですか?

1 行で始められます。

```bash
npx --yes github:KimYx0207/Meta_Kim meta-kim
```

あるいは clone してから実行します。

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

ウィザードが言語、プラットフォーム、インストール範囲を案内します。

### Q: なぜ「元」と呼ぶのですか?

Meta_Kim では、**元 = 最小の統治可能単位** です。有効な元単位は次の条件を満たします。

- 明確な責任範囲がある
- 拒否する境界が定義されている
- 独立してレビューできる
- 置き換え可能である
- 安全にロールバックできる

何でも「元」と呼べるわけではありません。その基準を満たしたものだけが、元です。

### Q: このプロジェクトと MCP にはどんな関係がありますか?

Meta_Kim は MCP（Model Context Protocol）を使って agent の能力境界を広げています。`.mcp.json` で外部ツールやサービスを呼び出せます。ただし Meta_Kim 自体は MCP サーバーではありません。これはガバナンスフレームワークであり、MCP はその中に統合される道具の一つです。

## 参考資料

- [README.md](README.md)
- [AGENTS.md](AGENTS.md)
- [config/contracts/workflow-contract.json](config/contracts/workflow-contract.json)
- [docs/runtime-capability-matrix.md](docs/runtime-capability-matrix.md)

---

## サードパーティの依存関係

Meta_Kim 自体は Apache License 2.0 の下でライセンスされています。以下のオプションスキルリポジトリは `node setup.mjs` で個別にインストールされ、それぞれのライセンスが独立して適用されます。

### npm 依存関係

| パッケージ | License |
|-----------|---------|
| [`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js) | MIT |
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [`zod`](https://github.com/colinhacks/zod) | MIT |

### オプションスキルリポジトリ

| リポジトリ | License |
|----------|---------|
| [KimYx0207/agent-teams-playbook](https://github.com/KimYx0207/agent-teams-playbook) | MIT |
| [KimYx0207/findskill](https://github.com/KimYx0207/findskill) | MIT |
| [KimYx0207/HookPrompt](https://github.com/KimYx0207/HookPrompt) | MIT |
| [obra/superpowers](https://github.com/obra/superpowers) | MIT |
| [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) | MIT |
| [OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files) | MIT |
| [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) | Apache 2.0 |
| [garrytan/gstack](https://github.com/garrytan/gstack) | MIT |
| [anthropics/skills](https://github.com/anthropics/skills) | ライセンス未宣言（© Anthropic, PBC） |

### オプション pip パッケージ

| パッケージ | License |
|-----------|---------|
| [`graphifyy`](https://github.com/safishamsi/graphify) | MIT |
| [`mcp-memory-service`](https://pypi.org/project/mcp-memory-service/) | Apache 2.0 |

---

## ライセンス

本プロジェクトは [Apache License 2.0](LICENSE) の下でライセンスされています。

### 商用利用と表示

商用利用は許可されています。Meta_Kim またはその実質的な部分を再配布する場合は、配布物に [LICENSE](LICENSE) と [NOTICE](NOTICE) を含めてください。

推奨される表示:

```text
Meta_Kim by KimYx0207 — https://github.com/KimYx0207/Meta_Kim
```

この表示は、KimYx0207 または Meta_Kim プロジェクトがあなたの製品、サービス、配布物を支持していることを意味するものではありません。サードパーティの依存関係とオプションスキルリポジトリには、それぞれのライセンスが適用されます。
