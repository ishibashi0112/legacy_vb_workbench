/**
 * パーサー出力・診断のドメイン型。
 * 引き継ぎ仕様書 §10 の型設計案に準拠する。
 * VS Code API には依存しない(純粋ロジック層)。
 */

/** .vbproj の ItemGroup 内で扱う項目種別 */
export type ProjectItemKind =
	| "Compile"
	| "EmbeddedResource"
	| "Content"
	| "None"
	| "ProjectReference"
	| "Reference"
	| "COMReference"
	| "Folder";

/**
 * 項目の解決状態。
 * 複数該当する場合の優先順位:
 * unresolved-expression > wildcard > conditional > missing > resolved
 */
export type ProjectItemStatus =
	| "resolved"
	| "missing"
	| "unresolved-expression"
	| "wildcard"
	| "conditional";

/** .vbproj から抽出・正規化した 1 項目 */
export interface ProjectItem {
	kind: ProjectItemKind;
	/** Include 属性の生の値(区切り文字も原文のまま) */
	include: string;
	/** 解決済みの物理絶対パス。MSBuild 式・ワイルドカードを含む場合は undefined */
	sourcePath?: string;
	/** 表示用の論理パス。Link があれば Link、なければ Include(`\` 区切りに正規化) */
	logicalPath: string;
	link?: string;
	dependentUpon?: string;
	subType?: string;
	/** Item または親 ItemGroup の Condition。両方ある場合は AND 結合 */
	condition?: string;
	/** sourcePath が解決済みで、かつ実ファイルが存在するか */
	exists: boolean;
	status: ProjectItemStatus;
	unresolvedReason?: string;
	/** Designer.vb / .resx / 自動生成メタデータ等、誤編集警告の対象か */
	isSensitive: boolean;
	/** Include・Condition 以外の全メタデータ(未知のものも保持する) */
	metadata: Readonly<Record<string, string>>;
}

/** 解析中に検出した警告・情報(不明な項目を黙って捨てないための受け皿) */
export interface ParseDiagnostic {
	severity: "info" | "warning" | "error";
	message: string;
	/** 関連する項目の Include 値(項目に紐づく診断のみ) */
	itemInclude?: string;
}

/** parseVbproj の戻り値 */
export interface VbprojParseResult {
	/** 解析対象 .vbproj の絶対パス */
	projectPath: string;
	/** .vbproj のあるディレクトリ(相対パス解決の基準) */
	projectDir: string;
	items: ProjectItem[];
	diagnostics: ParseDiagnostic[];
}
