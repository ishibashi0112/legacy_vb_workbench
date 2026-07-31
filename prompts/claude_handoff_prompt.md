# Claude.ai / Claude Code 引き継ぎプロンプト

以下のプロジェクトについて、設計・技術検証・TypeScript実装を引き継いでください。

---

## 依頼

私は「Legacy VB.NET Workbench for VS Code」という個人開発・技術検証を進めています。

目的は、Visual Studio 2013で管理されている古いVB.NET WinFormsプロジェクトを、既存の`.sln`や`.vbproj`を変更せず、VS Codeで編集・検索しやすくすることです。

Visual Studio 2013を置き換えるのではありません。

役割は次のように分けます。

### VS Code側

- `.vb`ファイルの編集
- 全文検索
- 複数ファイル操作
- モダンなエディター機能
- `.sln`／旧形式`.vbproj`の論理構造表示
- プロジェクト外に置かれたファイルを開く
- 将来的なMSBuild実行
- 将来的なEXE実行
- 制約・未解決項目の表示
- `Designer.vb`や`.resx`の誤編集警告

### Visual Studio 2013側

- WinFormsデザイナー
- 複雑なデバッグ
- プロジェクト設定
- Visual Studio固有機能

最終目標は、Visual Studio 2013を完全に廃止することではなく、

> Visual Studio 2013を開いて作業する時間を減らすこと

です。

---

## 想定環境

- Windows
- Visual Studio 2013
- VB.NET WinForms
- 古い.NET Framework
- MSBuild 12.0
- 開発用PCへRDP接続して作業
- VS CodeもRDP先の開発用PCで動かす
- Gitを使用していないプロジェクトもある
- ソースコードが一つのフォルダにまとまっていない
- `.sln`や`.vbproj`から別ドライブ・離れたフォルダのソースを参照している場合がある
- Visual StudioのSolution Explorerには、物理フォルダ構造とは異なる論理構造が表示される
- `Link`、`DependentUpon`、外部パスの`Compile Include`などが使われている可能性がある

---

## プロジェクト全体像

専用のVS Code Project Explorerを作りたいです。

想定処理は次の通りです。

1. `.sln`を解析
2. 含まれる`.vbproj`を取得
3. `.vbproj`内の項目を解析
   - `Compile Include`
   - `EmbeddedResource`
   - `Content`
   - `None`
   - `ProjectReference`
   - `Reference`
   - `COMReference`
   - `Link`
   - `DependentUpon`
   - `SubType`
   - `Import Project`
4. 相対パスを実ファイルの絶対パスへ解決
5. 物理配置ではなく、`.vbproj`上の論理構造を作成
6. VS CodeのTree View APIで専用サイドバーに表示
7. 項目クリック時に、実際の保存場所にあるファイルを開く

表示イメージ:

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

実ファイルが別ドライブにあっても、`Link`などを使ってプロジェクト上の論理構造で表示したいです。

---

## 重要な設計判断

最初から完全なMSBuild評価は行いません。

以下を明確に分けてください。

1. `.vbproj`の静的XML解析
2. MSBuildによる評価済み状態

例えば次の記述は、XMLを読むだけでは正確に解決できません。

```xml
<Compile Include="$(SharedSourceRoot)\Common\Helper.vb">
  <Link>Common\Helper.vb</Link>
</Compile>
```

```xml
<ItemGroup Condition="'$(Configuration)' == 'Debug'">
  <Compile Include="DebugOnly.vb" />
</ItemGroup>
```

```xml
<Import
  Project="$(CustomTargetsPath)\Company.targets"
  Condition="Exists('$(CustomTargetsPath)\Company.targets')" />
```

初期実装では、評価不能なものを推測しないでください。

- 項目自体は残す
- 「未解決」「条件付き」「ワイルドカード」などの状態を持たせる
- ツリー上で警告表示する

将来的には、必要に応じて`.NET Framework`の小さなヘルパーEXEを作り、`Microsoft.Build.Evaluation.Project`で評価済み項目をJSON出力する構成を検討します。

ただし、これは初期MVPには含めません。

---

## 最初のMVP

最初は`.sln`対応も後回しにして構いません。

まず次だけを実装してください。

1. `.vbproj`を選択
2. XMLを解析
3. 次の項目を読む
   - `Compile`
   - `EmbeddedResource`
   - `Content`
   - `None`
4. 通常の相対パスを絶対パスに解決
5. 絶対パスを扱う
6. `Link`を論理パスに使う
7. `DependentUpon`で親子表示
8. 論理パスから仮想フォルダを作る
9. VS Codeの専用Tree Viewに表示
10. クリックしたら物理ファイルを開く
11. 存在しないファイルを警告表示
12. `$(...)`、`@(...)`、`%(...)`を含むパスを未解決表示
13. ワイルドカードを未対応表示
14. `Condition`付き項目を条件付き表示
15. `Designer.vb`、`.resx`等を開く際に警告
16. 手動更新コマンド

初期MVPに含めないもの:

- WinFormsデザイナー
- デバッガー
- MSBuild実行
- EXE実行
- Visual Studio起動
- 完全な編集禁止
- Import先の展開
- Condition評価
- MSBuildプロパティ展開
- ワイルドカード展開
- Solution Folder
- 自動監視
- Referencesの完全表示

---

## 技術方針

- TypeScript
- VS Code Extension API
- TypeScript strict mode
- `any`は使用しない
- XML解析は`fast-xml-parser`を第一候補
- Windowsパスとして`path.win32`を適宜使う
- `vscode.TreeItem`と内部ドメインモデルを分離
- パーサーと論理ツリー生成を単体テスト可能にする
- 不正な1項目のために拡張全体を停止させない
- 未対応項目を黙って捨てない

推奨構成:

```text
legacy-vb-workbench/
├─ package.json
├─ tsconfig.json
├─ resources/
│  └─ legacy-vb.svg
└─ src/
   ├─ extension.ts
   ├─ types.ts
   ├─ vbprojParser.ts
   ├─ logicalTreeBuilder.ts
   └─ legacyProjectTreeProvider.ts
```

---

## パス解決ルール

- `Include`は`.vbproj`のディレクトリ基準で解決
- 絶対パスはそのまま正規化
- `/`と`\`を正規化
- `Link`があれば論理表示パスに使う
- `Link`がなければ`Include`を論理表示パスに使う
- 物理パスから論理ツリーを作らない
- 外部ファイルもVS Codeで開けるようにする
- `$(...)`、`@(...)`、`%(...)`は初期段階では展開しない
- `*`、`?`を含むIncludeは初期段階では展開しない
- Windows前提で大文字小文字を区別せず比較する

---

## DependentUponのルール

例:

```xml
<Compile Include="Forms\OrderForm.vb">
  <SubType>Form</SubType>
</Compile>

<Compile Include="Forms\OrderForm.Designer.vb">
  <DependentUpon>OrderForm.vb</DependentUpon>
</Compile>

<EmbeddedResource Include="Forms\OrderForm.resx">
  <DependentUpon>OrderForm.vb</DependentUpon>
</EmbeddedResource>
```

子の論理パスが:

```text
Forms\OrderForm.Designer.vb
```

で、`DependentUpon`が:

```text
OrderForm.vb
```

なら、親候補は:

```text
Forms\OrderForm.vb
```

です。

必ず実ファイルの物理フォルダではなく、論理パスの同一フォルダ内で親を探してください。

親が見つからなくても、子項目は削除せずツリーに残してください。

---

## Designer関連ファイル

最初は完全な編集禁止を目指しません。

次を実装してください。

- ツリー上で警告アイコンまたは説明を表示
- 専用Tree Viewから開く際に確認ダイアログを表示
- ユーザーが了承すれば開ける

候補:

- `*.Designer.vb`
- `*.resx`
- `*.settings`
- `AutoGen=True`
- `DesignTime=True`
- `DesignTimeSharedInput=True`
- `Generator`
- `LastGenOutput`

---

## 最初に確認したい実プロジェクトのXML

実装後、実際の`.vbproj`から次を確認したいです。

```xml
<Compile Include="..." />
<EmbeddedResource Include="..." />
<Content Include="..." />
<None Include="..." />
<Link>...</Link>
<DependentUpon>...</DependentUpon>
<SubType>Form</SubType>
<SubType>Designer</SubType>
<Import Project="..." />
<ProjectReference Include="..." />
<Reference Include="...">
  <HintPath>...</HintPath>
</Reference>
<COMReference Include="..." />
```

さらに次の有無を確認します。

```xml
Condition="..."
<Choose>
<When Condition="...">
<Otherwise>
<AutoGen>True</AutoGen>
<DesignTime>True</DesignTime>
<DesignTimeSharedInput>True</DesignTimeSharedInput>
<Generator>...</Generator>
<LastGenOutput>...</LastGenOutput>
```

パス例:

```xml
<Compile Include="..\..\Shared\File.vb" />
<Compile Include="D:\Shared\File.vb" />
<Compile Include="$(SomeRoot)\File.vb" />
<Compile Include="Common\**\*.vb" />
```

---

## 実装順序

以下の順番で進めてください。

1. VS Code拡張のTypeScript雛形を作る
2. `parseVbProject`を実装
3. 解析結果をOutput ChannelまたはJSONで確認
4. パス正規化を実装
5. 未解決項目判定を実装
6. 論理フォルダツリーを作る
7. `DependentUpon`を実装
8. Tree Viewを表示
9. クリックでファイルを開く
10. Designer関連警告を追加
11. 手動更新を追加
12. テスト用fixtureを作る
13. 実際の`.vbproj`で確認
14. その後に`.sln`対応
15. さらに後でMSBuild実行

---

## 最初の完了条件

次が動けば最初のプロトタイプは完了です。

- 実際の旧形式`.vbproj`を選択できる
- 論理フォルダとファイルが表示される
- `Link`された外部ファイルがLink先の論理パスに表示される
- `Designer.vb`と`.resx`が`DependentUpon`によりフォーム配下へ表示される
- 外部ドライブの実ファイルをクリックして開ける
- 存在しないファイルが分かる
- MSBuild式を含む未解決項目が分かる
- Designer関連ファイルを開く際に警告される
- 手動更新できる

---

## あなたにお願いしたい進め方

最初から巨大な完成版を提示しないでください。

次のように進めてください。

1. 最小の実装方針を提示
2. 作成・変更するファイル一覧を提示
3. まずパーサー部分の完全なコードを提示
4. テスト用`.vbproj` fixtureを提示
5. 実行方法を提示
6. 結果を確認してからTree Viewへ進む

小さなファイルについては、省略せずコピー可能な完全コードを提示してください。

`any`は避け、`unknown`と型ガードを使ってください。

XML静的解析とMSBuild完全評価を同じものとして扱わないでください。

以上を前提として、まずは

> `.vbproj`単体を解析し、正規化したProjectItem配列をOutput Channelへ出力する最小プロトタイプ

の設計と実装から始めてください。
