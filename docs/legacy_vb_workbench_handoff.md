# Legacy VB.NET Workbench for VS Code
## 引き継ぎ仕様書

## 1. 背景

会社でVisual Studio 2013を使用したVB.NET WinFormsのレガシープロジェクトを開発している。

開発環境には次の特徴がある。

- Visual Studio 2013
- VB.NET WinForms
- 古い.NET Framework環境
- 開発用PCへRDP接続して作業
- Visual Studio、MSBuild、各種ランタイムはRDP先PCに存在
- 会社ではClaude CodeなどのAIコーディングツールを直接利用できない
- Gitを使用していないプロジェクトもある
- ソースコードが一つのフォルダにまとまっていない
- `.sln`や`.vbproj`から離れたフォルダのソースを参照する場合がある
- Visual StudioのSolution Explorerでは、物理構造と異なる論理構造が表示される
- `Link`、`DependentUpon`、外部パスの`Compile Include`が利用されている可能性がある

Visual Studio 2013での編集体験が古く、モダンな検索・複数ファイル編集・AI支援との相性が悪いため、既存プロジェクトを変更せずVS Codeで扱いやすくする補助ツールを検討する。

---

## 2. プロジェクト名

仮称:

**Legacy VB.NET Workbench for VS Code**

---

## 3. 目的

Visual Studioを置き換えるのではなく、作業を分担する。

### VS Code

- `.vb`ファイル編集
- 全文検索
- 複数ファイル操作
- モダンなエディター機能
- `.sln`／`.vbproj`論理構造の表示
- MSBuild実行
- EXE実行
- 制約・未解決項目の表示
- `Designer.vb`や`.resx`の誤編集防止・警告

### Visual Studio 2013

- WinFormsデザイナー
- 複雑なデバッグ
- プロジェクト設定
- Visual Studio固有機能

中心目的:

> Visual Studio 2013を開いて作業する時間を減らす。

---

## 4. 想定利用構成

```text
自分のPC
   │
   │ RDP
   ▼
開発用PC
├─ Visual Studio 2013
├─ VS Code
├─ MSBuild 12.0
├─ .NET Framework
├─ VB.NETプロジェクト
└─ 離れた複数のソースフォルダ
```

ドライブマッピングだけでローカルPCから編集するのではなく、RDP先でVS Codeを起動する。

このため、拡張から見たファイルパス、MSBuild、Visual Studio、実行ファイルはすべて同じWindows環境に存在する。

---

## 5. 中心機能

VS Code標準Explorerとは別に、Visual StudioのSolution Explorerに近い専用Project Explorerを作成する。

処理:

1. `.sln`解析
2. `.vbproj`一覧取得
3. `.vbproj`解析
4. `Include`を実パスに解決
5. `Link`等から論理構造を生成
6. `DependentUpon`から親子関係を生成
7. VS Code Tree View APIへ渡す
8. クリック時に物理ファイルを開く

想定表示:

```text
VB.NET PROJECTS
└─ MainApplication
   ├─ My Project
   ├─ Forms
   │  └─ OrderForm.vb
   │     ├─ OrderForm.Designer.vb
   │     └─ OrderForm.resx
   ├─ Common
   │  └─ DateHelper.vb
   └─ References
```

---

## 6. 成立性評価

### 成立性が高い

- `.sln`から`.vbproj`を抽出
- `.vbproj`の静的XML解析
- `Compile`等の項目抽出
- 通常の相対パス／絶対パス解決
- `Link`による論理パス生成
- `DependentUpon`による親子化
- VS Code Tree View表示
- 外部ファイルを開く
- MSBuildを子プロセス起動
- `devenv.exe`を起動

### 難しい部分

- `Condition`の完全評価
- `Import`先を含めた最終項目一覧
- MSBuildプロパティ展開
- `Choose`／`When`／`Otherwise`
- ワイルドカード展開
- Visual Studio Solution Explorerの完全再現
- Designerファイルの完全な編集禁止

最大の難所はTree Viewではなく、MSBuild評価である。

---

## 7. 基本設計方針

### フェーズ1

静的XML解析。

対応可能:

- `Compile Include="Forms\OrderForm.vb"`
- `EmbeddedResource Include="Forms\OrderForm.resx"`
- `Link`
- `DependentUpon`
- 単純相対パス
- 絶対パス

対応不能・未解決扱い:

- `$(Property)`
- `@(Item)`
- `%(Metadata)`
- `Condition`
- `Import`
- `Choose`
- ワイルドカード

### フェーズ2以降

必要性が確認できた場合のみ、`.NET Framework`ヘルパーを用意する。

```text
VS Code Extension
    │ JSON
    ▼
legacy-msbuild-probe.exe
    │
    ├─ Microsoft.Build 12.0
    ├─ .vbproj評価
    └─ 評価済みItem／PropertyをJSON出力
```

TypeScript拡張からヘルパーを子プロセスとして起動する。

---

## 8. 初期MVP

### 実装する

- `.vbproj`選択
- XML解析
- `Compile`
- `EmbeddedResource`
- `Content`
- `None`
- 通常の相対／絶対パス解決
- `Link`
- `DependentUpon`
- 論理フォルダ作成
- Tree View
- クリックでファイルを開く
- 存在しないファイルの警告
- 未解決式の警告
- 条件付き項目の表示
- ワイルドカード項目の表示
- Designer関連ファイルの警告
- 手動更新

### 実装しない

- `.sln`
- Solution Folder
- MSBuild
- EXE起動
- Visual Studio起動
- Import展開
- Condition評価
- プロパティ展開
- ワイルドカード展開
- ファイル監視
- 完全な編集禁止

---

## 9. 推奨アーキテクチャ

```text
src/
├─ extension.ts
├─ types.ts
├─ vbprojParser.ts
├─ logicalTreeBuilder.ts
└─ legacyProjectTreeProvider.ts
```

責務:

### `types.ts`

- パーサー出力型
- 論理ツリー型
- 診断型

### `vbprojParser.ts`

- XML読込
- XMLパース
- ItemGroup抽出
- Item正規化
- パス解決
- 未解決判定
- Designer関連判定

### `logicalTreeBuilder.ts`

- 論理パス分割
- 仮想フォルダ作成
- `DependentUpon`
- 孤児項目処理
- 並び順

### `legacyProjectTreeProvider.ts`

- `TreeDataProvider`
- `TreeItem`生成
- アイコン
- Tooltip
- command関連付け

### `extension.ts`

- command登録
- Tree View登録
- ファイル選択
- 状態保持
- open処理
- warning dialog

---

## 10. 型設計案

```ts
export type ProjectItemKind =
  | "Compile"
  | "EmbeddedResource"
  | "Content"
  | "None"
  | "ProjectReference"
  | "Reference"
  | "COMReference"
  | "Folder";

export type ProjectItemStatus =
  | "resolved"
  | "missing"
  | "unresolved-expression"
  | "wildcard"
  | "conditional";

export interface ProjectItem {
  kind: ProjectItemKind;
  include: string;
  sourcePath?: string;
  logicalPath: string;
  link?: string;
  dependentUpon?: string;
  subType?: string;
  condition?: string;
  exists: boolean;
  status: ProjectItemStatus;
  unresolvedReason?: string;
  isSensitive: boolean;
  metadata: Readonly<Record<string, string>>;
}
```

論理ツリー:

```ts
export interface BaseNode {
  id: string;
  label: string;
  children: LegacyTreeNode[];
}

export interface ProjectNode extends BaseNode {
  type: "project";
  projectPath: string;
}

export interface FolderNode extends BaseNode {
  type: "folder";
  logicalPath: string;
}

export interface FileNode extends BaseNode {
  type: "file";
  item: ProjectItem;
}

export interface WarningNode extends BaseNode {
  type: "warning";
  message: string;
}

export type LegacyTreeNode =
  | ProjectNode
  | FolderNode
  | FileNode
  | WarningNode;
```

---

## 11. XML解析

候補ライブラリ:

```bash
npm install fast-xml-parser
```

注意点:

- XML namespaceがある
- `ItemGroup`が単一オブジェクトにも配列にもなる
- 同じItem種別も単一／配列になる
- BOM除去
- 属性名と要素名を区別
- `Condition`は`ItemGroup`と各Itemの両方に存在可能
- 既知メタデータ以外も保持すると後で役立つ

例:

```xml
<Project
  ToolsVersion="12.0"
  DefaultTargets="Build"
  xmlns="http://schemas.microsoft.com/developer/msbuild/2003">

  <ItemGroup>
    <Compile Include="Forms\OrderForm.vb">
      <SubType>Form</SubType>
    </Compile>

    <Compile Include="Forms\OrderForm.Designer.vb">
      <DependentUpon>OrderForm.vb</DependentUpon>
    </Compile>

    <EmbeddedResource Include="Forms\OrderForm.resx">
      <DependentUpon>OrderForm.vb</DependentUpon>
    </EmbeddedResource>

    <Compile Include="..\..\Shared\DateHelper.vb">
      <Link>Common\DateHelper.vb</Link>
    </Compile>
  </ItemGroup>
</Project>
```

---

## 12. パス解決

### sourcePath

`Include`を実パスとして解決。

- 絶対パス: 正規化
- 相対パス: `.vbproj`ディレクトリ基準
- MSBuild式: 解決しない
- ワイルドカード: 展開しない

### logicalPath

- `Link`がある: `Link`
- `Link`がない: `Include`

論理パスは表示用であり、物理パスではない。

Windows向けに大文字小文字を区別しない比較を行う。

---

## 13. DependentUpon

親検索は論理フォルダを基準にする。

例:

```text
子:
Forms\OrderForm.Designer.vb

DependentUpon:
OrderForm.vb

親候補:
Forms\OrderForm.vb
```

`Link`されたファイルは物理フォルダが異なるため、物理パス基準では正しく親子化できない。

親が見つからない場合:

- 子を消さない
- 本来の論理フォルダに表示
- 必要なら警告を付与

---

## 14. Designer関連警告

候補判定:

- `.Designer.vb`
- `.resx`
- `.settings`
- `AutoGen=True`
- `DesignTime=True`
- `DesignTimeSharedInput=True`
- `Generator`
- `LastGenOutput`

初期段階:

- アイコン／description
- クリック時のmodal warning
- ユーザー了承後に開く

標準ExplorerやQuick Open経由まで完全に防ぐことは初期MVPの対象外。

---

## 15. VS Code API構成

`package.json`に専用View Containerを登録。

```json
{
  "activationEvents": [
    "onView:legacyVbWorkbench.projects"
  ],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "legacyVbWorkbench",
          "title": "Legacy VB",
          "icon": "resources/legacy-vb.svg"
        }
      ]
    },
    "views": {
      "legacyVbWorkbench": [
        {
          "id": "legacyVbWorkbench.projects",
          "name": "VB.NET Projects"
        }
      ]
    },
    "commands": [
      {
        "command": "legacyVbWorkbench.selectProject",
        "title": "Legacy VB: Select VB Project"
      },
      {
        "command": "legacyVbWorkbench.refresh",
        "title": "Legacy VB: Refresh"
      },
      {
        "command": "legacyVbWorkbench.openFile",
        "title": "Legacy VB: Open File"
      }
    ]
  }
}
```

---

## 16. テスト

fixture例:

```text
test-fixtures/
├─ basic/
├─ linked-file/
├─ dependent-upon/
├─ external-relative/
├─ absolute-path/
├─ missing-file/
├─ property-expression/
├─ wildcard/
├─ conditional-item/
├─ generated-files/
└─ malformed-item/
```

検証項目:

- XML namespace
- BOM
- 単一ItemGroup
- 複数ItemGroup
- 単一Compile
- 複数Compile
- `..\`
- ドライブ絶対パス
- `Link`
- `DependentUpon`
- 大文字小文字違い
- 存在しない親
- 存在しないファイル
- MSBuild式
- ワイルドカード
- ItemGroup Condition
- Item Condition
- Designer関連メタデータ

---

## 17. 開発手順

### Step 1

VS Code ExtensionのTypeScript雛形。

### Step 2

`.vbproj`を選択し、解析結果をOutput ChannelにJSON出力。

### Step 3

パス正規化とstatus判定。

### Step 4

論理ツリーを純粋関数で生成。

### Step 5

Tree View表示。

### Step 6

クリックで開く。

### Step 7

Designer警告。

### Step 8

実プロジェクトで検証。

### Step 9

`.sln`解析を追加。

### Step 10

MSBuild検出・実行を追加。

---

## 18. `.sln`対応

後続フェーズ。

必要最低限は次の行を抽出すること。

```text
Project("{PROJECT-TYPE-GUID}") = "MainApplication", "MainApplication\MainApplication.vbproj", "{PROJECT-GUID}"
EndProject
```

型:

```ts
export interface SolutionProject {
  name: string;
  relativePath: string;
  absolutePath: string;
  projectGuid: string;
  projectTypeGuid: string;
}
```

最初は`.vbproj`だけを対象にする。

後回し:

- Solution Folder
- `NestedProjects`
- Solution Items
- ConfigurationPlatforms
- ProjectConfigurationPlatforms

---

## 19. MSBuild対応

後続フェーズ。

想定候補:

```text
C:\Program Files (x86)\MSBuild\12.0\Bin\MSBuild.exe
```

検出順:

1. 拡張設定
2. レジストリ
3. 既知パス
4. ファイル選択

実行は`exec`より`spawn`を推奨。

初期コマンド例:

```text
MSBuild.exe solution.sln /t:Build /p:Configuration=Debug /nologo
```

まずはVisual Studioと同条件のビルドを優先し、初期段階で`/m`を付けない。

---

## 20. Visual Studio起動

後続フェーズ。

- `devenv.exe`の場所を検出または設定
- `.sln`を引数に起動
- VS Codeのコマンドから呼び出す

この機能は、デザイナーや複雑なデバッグへすぐ戻れる導線として重要。

---

## 21. 実プロジェクトで調査する内容

以下を検索する。

### ファイル項目

```xml
<Compile Include="..." />
<EmbeddedResource Include="..." />
<Content Include="..." />
<None Include="..." />
```

### 論理構造

```xml
<Link>...</Link>
<DependentUpon>...</DependentUpon>
<SubType>Form</SubType>
<SubType>Designer</SubType>
```

### 複雑な評価

```xml
Condition="..."
<Import Project="..." />
<Choose>
<When Condition="...">
<Otherwise>
```

### 自動生成

```xml
<AutoGen>True</AutoGen>
<DesignTime>True</DesignTime>
<DesignTimeSharedInput>True</DesignTimeSharedInput>
<Generator>...</Generator>
<LastGenOutput>...</LastGenOutput>
```

### 参照

```xml
<ProjectReference Include="..." />
<Reference Include="...">
  <HintPath>...</HintPath>
</Reference>
<COMReference Include="..." />
```

### パス

```xml
<Compile Include="..\..\Shared\File.vb" />
<Compile Include="D:\Shared\File.vb" />
<Compile Include="$(SomeRoot)\File.vb" />
<Compile Include="Common\**\*.vb" />
```

---

## 22. リスク

### MSBuildを再実装し始める

避ける。静的解析の限界を明示する。

### VS Codeの標準Explorerへ無理に統合する

専用Tree Viewを使用する。

### 物理パスから論理ツリーを作る

誤り。`Link`／`Include`を基準にする。

### Designerファイルを完全禁止しようとする

最初は警告に限定する。

### 最初から`.sln`、MSBuild、実行、VS起動を全部入れる

避ける。最初は`.vbproj -> ProjectItem[] -> LogicalTree`だけ。

### 不明な項目を黙って無視する

警告・診断として保持する。

---

## 23. 最初のDefinition of Done

1. `.vbproj`を選択可能
2. `Compile`等を抽出
3. `Link`を論理パスに反映
4. `DependentUpon`を親子化
5. 外部ファイルを開ける
6. 論理フォルダ表示
7. 不明・未解決項目表示
8. Designer関連警告
9. 手動更新
10. 実プロジェクト1件で動作確認

---

## 24. Claudeへ期待する支援

- 最小単位で実装する
- 作成ファイルを明示する
- 小さなファイルは完全コードを示す
- `any`を使わない
- TypeScript strict mode
- 単体テストを併記
- Windowsパスを考慮
- Legacy MSBuildの限界を隠さない
- 実プロジェクト固有の判断には、サニタイズ済み`.vbproj`断片を要求する
- 一度に完成版へ広げない
