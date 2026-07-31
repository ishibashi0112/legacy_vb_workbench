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
- **MSBuild ビルド**(`Legacy VB: Build`)— MSBuild 12.0 等を自動検出し、
  `/t:Build /p:Configuration=Debug /nologo` で実行(VS と同条件、`/m` なし)。
  出力は Output「Legacy VB Build」へストリーム表示、通知からキャンセル可
- **Visual Studio で開く**(`Legacy VB: Open in Visual Studio`)— devenv.exe を
  検出して `.sln` / `.vbproj` を開く(デザイナー・デバッグへ戻る導線)
- **AI 向けエクスポート**(`Legacy VB: Export for AI (Repomix)`)— `.sln` / `.vbproj`
  の論理構成に基づき、全ソースを Repomix 形式の 1 ファイルにまとめて出力。
  ソースが複数フォルダ・別ドライブに散らばっていても Visual Studio が見ている
  ままの構成でパックできる。Shift_JIS のソースは UTF-8 へ自動変換。
  `.resx` は除外、Designer 関連は既定で除外(設定で変更可)、除外・未解決分は
  `<skipped_files>` に明記
- **認証情報の自動マスク** — エクスポート時に認証情報らしき値を `[MASKED]` に
  自動置換(既定で有効)。接続文字列(`Password=` / `PWD=` / `User ID=` 等)、
  秘密系変数への文字列リテラル代入、AWS/GitHub/Slack トークン・JWT・Bearer・
  秘密鍵ブロックに対応。マスク箇所は `<masked_credentials>` に行番号付きで明記。
  機械判定のため漏れはあり得ます — **共有前の目視確認は引き続き推奨**

ビルド・VS 起動は **MSBuild / Visual Studio が存在する Windows 上の VS Code**
(RDP 先の開発 PC)でのみ動作します。EXE 起動は今後のフェーズです。

## 設定

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| `legacyVbWorkbench.msbuildPath` | (空) | MSBuild.exe のフルパス。空なら自動検出(設定 → レジストリ(VS2013)→ vswhere(VS2017 以降)→ 既定パス) |
| `legacyVbWorkbench.devenvPath` | (空) | devenv.exe のフルパス。空なら自動検出(同上) |
| `legacyVbWorkbench.buildConfiguration` | `Debug` | ビルドの Configuration |
| `legacyVbWorkbench.msbuildOutputEncoding` | `auto` | MSBuild 出力のエンコーディング。auto は自動判定(MSBuild 12.0 = cp932、MSBuild 17/18 = utf8) |
| `legacyVbWorkbench.exportIncludeDesignerFiles` | `false` | Repomix エクスポートに Designer 関連ファイルを含める |
| `legacyVbWorkbench.exportMaskCredentials` | `true` | Repomix エクスポートで認証情報らしき値を `[MASKED]` に自動置換 |

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
   - エディター領域へのドラッグ&ドロップでも開けます(分割エリアへのドロップ可。
     Ctrl/Cmd+クリックで複数選択してまとめてドラッグ可)
4. 前回の選択はウィンドウごとに記憶され、起動時に復元されます

補足: ドラッグで開いた場合は Designer 関連ファイルの確認ダイアログは表示されません
(クリック操作時のみ)。ツリー内へのドロップによるファイル移動は、既存 `.vbproj` を
変更しない方針のため対応していません。

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
