# Legacy VB.NET Workbench for VS Code

Visual Studio 2013 時代のレガシー VB.NET WinForms プロジェクト(旧形式 `.vbproj` / `.sln`)を、**既存プロジェクトを一切変更せずに** VS Code で扱いやすくする補助ツールです。

Visual Studio を置き換えるものではありません。WinForms デザイナーや複雑なデバッグは Visual Studio に任せ、日常のコード編集・検索を VS Code 側で行うことを目的としています。

## 機能(現在のマイルストーン)

- `.sln` / 旧形式 `.vbproj` を選択し、Visual Studio の Solution Explorer に近い**論理ツリー**を専用サイドバーに表示
  - `Link` された外部ファイルは Link 先の論理パスに表示
  - `DependentUpon` により `Designer.vb` / `.resx` をフォーム配下へ入れ子表示
  - 物理配置が別ドライブ・別フォルダでもクリックで開ける
- 静的 XML 解析の限界を隠さず表示
  - 存在しないファイル: `ファイルなし`
  - `$(...)` / `@(...)` / `%(...)`: `未解決式`(展開しません)
  - ワイルドカード: `ワイルドカード未展開`
  - `Condition` 付き項目: `条件付き`(評価しません)
- `Designer.vb` / `.resx` / 自動生成ファイルを開く際の警告ダイアログ
- 手動更新(Refresh)と解析結果の JSON 出力(Output「Legacy VB Workbench」)

MSBuild 実行・EXE 起動・Visual Studio 起動は今後のフェーズです。

## インストール(.vsix)

1. [releases/](releases/) から `.vsix` ファイルをダウンロード
2. VS Code → 拡張機能ビュー右上の `…` → **「VSIX からのインストール...」** で選択
   (またはコマンドパレット →「拡張機能: VSIX からのインストール」)

対応 VS Code バージョン: **1.75.0 以降**

## 使い方

1. アクティビティバーの **Legacy VB** アイコンを開く
2. **Select Solution**(または Select VB Project)で `.sln` / `.vbproj` を選択
3. ツリーからファイルをクリックして開く
   - シングルクリック: プレビュータブ(タブ名が斜体。次のファイルを開くと再利用される)
   - ダブルクリック: タブを固定して開く(標準エクスプローラーと同じ挙動)
4. 前回の選択はウィンドウごとに記憶され、起動時に復元されます

## 制約(仕様)

- 静的 XML 解析のみで、MSBuild 評価は行いません(`Import` 先・`Choose`・プロパティ展開は未対応)
- `.sln` は `Project` 行の抽出のみ。Solution Folder のネスト(`NestedProjects`)は未対応でフラット表示
- 評価できない項目は推測せず、警告付きでそのまま表示します

## 開発

```bash
pnpm install
pnpm run compile   # 型チェック + lint + esbuild
pnpm test          # 単体テスト(vscode-test)
pnpm run package:vsix  # releases/ に .vsix を生成
```

構成や設計判断は [docs/legacy_vb_workbench_handoff.md](docs/legacy_vb_workbench_handoff.md) と [CLAUDE.md](CLAUDE.md) を参照してください。
