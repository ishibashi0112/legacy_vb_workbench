# Change Log

## [0.3.2] - 2026-08-01

- Repomix エクスポートの出力を BOM 付き UTF-8 に変更
  (BOM なしだと Windows 系ツールやアップロード経路で Latin-1 と誤判定され
  文字化けして見えることがあるため)

## [0.3.1] - 2026-08-01

- fix: MSBuild 17/18(VS2022/2026)の UTF-8 出力が文字化けする問題を修正
  - `msbuildOutputEncoding` に `auto`(既定)を追加。最初に日本語が現れた行で
    UTF-8 / CP932 を自動判定する(MSBuild 12.0 は CP932 のまま正しく表示)
  - 行単位バッファリングによりチャンク境界のマルチバイト分割にも対応

## [0.3.0] - 2026-07-31

- MSBuild / devenv の検出に vswhere.exe を追加(VS2017 以降: 2022 / 2026 等)
  - 検出順: 設定 → レジストリ(VS2013 = 12.0 を最優先)→ vswhere → 既知パス
  - VS2022 移行後や VS2026 Community のみの環境でも自動検出が効くように
- 既知パスに VS2022(Community/Professional/Enterprise)と VS2026 を追加

## [0.2.0] - 2026-07-31

- AI 向けエクスポート(`Legacy VB: Export for AI (Repomix)`)を追加
  - .sln / .vbproj の論理構成(Link 解決済み)に基づき全ソースを 1 ファイルへ
  - Shift_JIS / UTF-8 / UTF-16 を自動判定し UTF-8 へ統一
  - .resx は除外、Designer 関連は既定で除外(設定 exportIncludeDesignerFiles)
  - 除外・未解決ファイルは <skipped_files> セクションに理由付きで明記

## [0.1.0] - 2026-07-31

- MSBuild ビルド実行(`Legacy VB: Build`)を追加
  - 検出順: 設定 → レジストリ(MSBuild 12.0)→ 既知パス → 手動選択(設定へ保存)
  - VS と同条件(`/t:Build /p:Configuration=<設定値> /nologo`、`/m` なし)
  - 出力は Output「Legacy VB Build」へストリーム(既定 cp932 デコード)
  - 進行通知からキャンセル可(taskkill /t で子プロセスごと停止)
- Visual Studio 起動(`Legacy VB: Open in Visual Studio`)を追加
- ソリューション/プロジェクトノードの右クリックメニューに上記2コマンドを追加

## [0.0.3] - 2026-07-31

- ツリーからエディター領域へのドラッグ&ドロップで開けるように対応
  (分割エリアへのドロップ・Ctrl/Cmd+クリックの複数選択ドラッグ可)
- ツリー内へのドロップ(ファイル移動)は非対応(既存 .vbproj を変更しない方針)

## [0.0.2] - 2026-07-31

- ツリーのファイルを標準エクスプローラーと同じ挙動で開くように変更
  (シングルクリック=プレビュータブ / ダブルクリック=タブ固定)
- Designer 確認ダイアログ表示中のダブルクリックで二重にダイアログが出ないよう修正

## [0.0.1] - 2026-07-31

- 初回リリース
- `.sln` / 旧形式 `.vbproj` の静的解析と論理ツリー表示
- `Link` / `DependentUpon` 対応、未解決項目の警告表示
- Designer 関連ファイルを開く際の確認ダイアログ
