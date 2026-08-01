/**
 * Repomix 形式エクスポート。
 *
 * 解析済みの ProjectItem[](Link 解決済みの論理構成)をもとに、
 * AI に渡しやすい 1 ファイルのテキスト(repomix の XML スタイル)を生成する。
 * ディレクトリ走査ではなく .sln / .vbproj の論理構成に基づくのが特徴。
 *
 * - 文字コードはレガシー VB で多い Shift_JIS(CP932)を自動判定して UTF-8 へ統一
 * - EmbeddedResource(.resx)は常に除外、Designer 関連は既定で除外(オプションで含める)
 * - 除外・未解決のファイルは skipped_files に明記する(黙って捨てない)
 *
 * ファイル読み込みは deps 注入とし、vscode 非依存の純粋ロジックに保つ。
 */

import * as iconv from "iconv-lite";
import { buildLogicalTree } from "../logicalTreeBuilder";
import { type MaskFinding, maskCredentials } from "./credentialMasker";
import {
	parseDesignerVb,
	renderDesignerControlLines,
} from "./designerSummary";
import type { FileNode, LegacyTreeNode, VbprojParseResult } from "../types";

export interface RepomixSource {
	/** 表示名(.sln 上のプロジェクト名など)。ツリーとパスの先頭に使う */
	label: string;
	parseResult: VbprojParseResult;
}

export interface RepomixExportDeps {
	/** ファイルを読み UTF-8 文字列で返す(失敗時 undefined)。エンコーディング変換は呼び出し側 */
	readTextFile(absolutePath: string): string | undefined;
	/**
	 * .gitignore / .repomixignore による除外判定(本家 repomix と同じ挙動)。
	 * 除外対象なら根拠の ignore ファイルパスを返す。未指定なら判定しない
	 */
	ignoreReasonFor?(absolutePath: string): string | undefined;
}

export interface RepomixExportOptions {
	/** Designer 関連(*.Designer.vb / *.resx 除く自動生成系)を含めるか */
	includeSensitive: boolean;
	/** 認証情報らしき値を [MASKED] に自動置換するか */
	maskCredentials: boolean;
	/**
	 * Designer 原文を含めない場合に、*.Designer.vb からコントロール構成を
	 * 要約した <ui_summary> を埋め込むか(既定 true)。
	 * includeSensitive が true のとき(原文が含まれるとき)は使われない
	 */
	uiSummary?: boolean;
}

export interface SkippedFile {
	path: string;
	reason: string;
}

export interface MaskedFile {
	path: string;
	findings: MaskFinding[];
}

export interface RepomixExportResult {
	content: string;
	fileCount: number;
	totalChars: number;
	skipped: SkippedFile[];
	/** マスクを行ったファイルと箇所の一覧 */
	maskedFiles: MaskedFile[];
	maskedCount: number;
	/** <ui_summary> として要約した Designer.vb の件数 */
	uiSummaryCount: number;
}

/** 内容を含めないバイナリ系拡張子(小文字) */
const BINARY_EXTENSIONS = [
	".dll",
	".exe",
	".pdb",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".zip",
	".pdf",
	".xls",
	".xlsx",
	".doc",
	".docx",
];

/**
 * ソースファイルのバイト列を文字列へデコードする。
 * BOM → UTF-16 / UTF-8 を優先し、UTF-8 として不正なら CP932(Shift_JIS)とみなす。
 */
export function decodeSourceBuffer(buffer: Buffer): string {
	if (buffer.length >= 2) {
		const b0 = buffer[0];
		const b1 = buffer[1];
		if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
			return iconv.decode(buffer, "utf16");
		}
	}
	if (
		buffer.length >= 3 &&
		buffer[0] === 0xef &&
		buffer[1] === 0xbb &&
		buffer[2] === 0xbf
	) {
		return buffer.subarray(3).toString("utf8");
	}
	// UTF-8 として往復可能なら UTF-8、壊れるなら CP932 とみなす
	const asUtf8 = buffer.toString("utf8");
	if (Buffer.from(asUtf8, "utf8").equals(buffer)) {
		return asUtf8;
	}
	return iconv.decode(buffer, "cp932");
}

/** ツリー1ノードをインデント付きテキストにする(問題のある項目は印を付ける) */
function renderTreeLines(node: LegacyTreeNode, depth: number, lines: string[]): void {
	const indent = "  ".repeat(depth);
	switch (node.type) {
		case "solution":
		case "project":
		case "folder":
			lines.push(`${indent}${node.label}/`);
			break;
		case "file": {
			const marker = statusMarker(node);
			lines.push(`${indent}${node.label}${marker}`);
			break;
		}
		case "warning":
			lines.push(`${indent}[警告] ${node.message}`);
			break;
	}
	for (const child of node.children) {
		renderTreeLines(child, depth + 1, lines);
	}
}

function statusMarker(node: FileNode): string {
	switch (node.item.status) {
		case "missing":
			return " [ファイルなし]";
		case "unresolved-expression":
			return " [未解決式]";
		case "wildcard":
			return " [ワイルドカード]";
		case "conditional":
			return " [条件付き]";
		case "resolved":
			return "";
	}
}

/** ツリーを走査して FileNode を表示順で集める(親子入れ子の子も含む) */
function collectFileNodes(node: LegacyTreeNode, into: FileNode[]): void {
	if (node.type === "file") {
		into.push(node);
	}
	for (const child of node.children) {
		collectFileNodes(child, into);
	}
}

/** 含める/除外の判定。除外なら理由を返す */
function skipReason(
	node: FileNode,
	options: RepomixExportOptions,
): string | undefined {
	const item = node.item;
	if (item.kind === "EmbeddedResource") {
		return "EmbeddedResource(リソース)は出力対象外";
	}
	if (item.sourcePath === undefined) {
		return `内容を取得できません(${item.status})`;
	}
	if (!item.exists) {
		return "実ファイルが存在しません";
	}
	if (item.isSensitive && !options.includeSensitive) {
		return "Designer 関連(設定 exportIncludeDesignerFiles で含められます)";
	}
	const fileName = item.logicalPath.split("\\").pop() ?? "";
	const dot = fileName.lastIndexOf(".");
	const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
	if (BINARY_EXTENSIONS.includes(extension)) {
		return `バイナリ拡張子(${extension})`;
	}
	return undefined;
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * 除外した *.Designer.vb から <ui_summary> エントリを生成する。
 * 対象外・読めない・コントロールが取れない場合は undefined
 * (呼び出し側は通常のスキップ扱いにする)。
 * maskEnabled 時は要約前の Designer ソースにマスクを適用する
 * (Text 初期値に認証情報が書かれている場合の漏れを防ぐ)。
 */
function buildUiSummaryEntry(
	node: FileNode,
	displayPath: string,
	deps: RepomixExportDeps,
	maskEnabled: boolean,
): { entry: string; findings: MaskFinding[] } | undefined {
	const item = node.item;
	if (
		!item.isSensitive ||
		item.sourcePath === undefined ||
		!item.exists ||
		!/\.designer\.vb$/i.test(item.logicalPath)
	) {
		return undefined;
	}
	if (deps.ignoreReasonFor?.(item.sourcePath) !== undefined) {
		return undefined; // .gitignore 対象は要約もしない
	}
	let source = deps.readTextFile(item.sourcePath);
	if (source === undefined) {
		return undefined;
	}
	let findings: MaskFinding[] = [];
	if (maskEnabled) {
		const masked = maskCredentials(source, { vbSource: true });
		source = masked.content;
		findings = masked.findings;
	}
	const summary = parseDesignerVb(source);
	if (summary.controlCount === 0) {
		return undefined;
	}
	const fileName = item.logicalPath.split("\\").pop() ?? item.logicalPath;
	const formName =
		summary.className ?? fileName.replace(/\.designer\.vb$/i, "");
	const lines = [
		`<ui_summary path="${escapeAttribute(displayPath)}" form="${escapeAttribute(formName)}">`,
		"Designer 自動生成コードからの要約(コントロール名: 型 — Text。座標・サイズ等のレイアウトは省略):",
	];
	if (summary.formText !== undefined) {
		lines.push(`フォームタイトル: "${summary.formText}"`);
	}
	lines.push(...renderDesignerControlLines(summary.rootControls));
	lines.push("</ui_summary>");
	return { entry: lines.join("\n"), findings };
}

/**
 * Repomix 形式のテキストを生成する。
 * @param title 出力対象の表示名(Sample.sln など)
 */
export function buildRepomixOutput(
	title: string,
	sources: readonly RepomixSource[],
	deps: RepomixExportDeps,
	options: RepomixExportOptions,
): RepomixExportResult {
	const treeLines: string[] = [];
	const fileEntries: string[] = [];
	const skipped: SkippedFile[] = [];
	const maskedFiles: MaskedFile[] = [];
	let fileCount = 0;
	let totalChars = 0;
	let uiSummaryCount = 0;
	const uiSummaryEnabled =
		(options.uiSummary ?? true) && !options.includeSensitive;

	for (const source of sources) {
		const tree = buildLogicalTree(source.parseResult);
		tree.root.label = source.label;
		renderTreeLines(tree.root, 0, treeLines);

		const fileNodes: FileNode[] = [];
		collectFileNodes(tree.root, fileNodes);
		for (const node of fileNodes) {
			const displayPath = `${source.label}\\${node.item.logicalPath}`;
			const reason = skipReason(node, options);
			if (reason !== undefined) {
				const uiSummaryEntry = uiSummaryEnabled
					? buildUiSummaryEntry(node, displayPath, deps, options.maskCredentials)
					: undefined;
				if (uiSummaryEntry !== undefined) {
					fileEntries.push(uiSummaryEntry.entry);
					totalChars += uiSummaryEntry.entry.length;
					uiSummaryCount += 1;
					if (uiSummaryEntry.findings.length > 0) {
						maskedFiles.push({
							path: `${displayPath}(<ui_summary> 生成前の原文)`,
							findings: uiSummaryEntry.findings,
						});
					}
					skipped.push({
						path: displayPath,
						reason: "Designer 関連(<ui_summary> に要約済み)",
					});
				} else {
					skipped.push({ path: displayPath, reason });
				}
				continue;
			}
			// skipReason 通過時点で sourcePath は解決済み
			const sourcePath = node.item.sourcePath as string;
			const ignoreSource = deps.ignoreReasonFor?.(sourcePath);
			if (ignoreSource !== undefined) {
				skipped.push({
					path: displayPath,
					reason: `.gitignore により除外(${ignoreSource})`,
				});
				continue;
			}
			const rawContent = deps.readTextFile(sourcePath);
			if (rawContent === undefined) {
				skipped.push({ path: displayPath, reason: "読み込みに失敗しました" });
				continue;
			}
			let content = rawContent;
			if (options.maskCredentials) {
				const masked = maskCredentials(rawContent, {
					vbSource: /\.vb$/i.test(displayPath),
				});
				content = masked.content;
				if (masked.findings.length > 0) {
					maskedFiles.push({ path: displayPath, findings: masked.findings });
				}
			}
			const conditionAttr =
				node.item.condition === undefined
					? ""
					: ` condition="${escapeAttribute(node.item.condition)}"`;
			fileEntries.push(
				`<file path="${escapeAttribute(displayPath)}"${conditionAttr}>\n${content}\n</file>`,
			);
			fileCount += 1;
			totalChars += content.length;
		}
	}
	const maskedCount = maskedFiles.reduce(
		(sum, file) => sum + file.findings.length,
		0,
	);

	const skippedSection =
		skipped.length === 0
			? "(なし)"
			: skipped.map((s) => `- ${s.path}: ${s.reason}`).join("\n");

	const maskedSection = !options.maskCredentials
		? "(マスク機能は設定で無効化されています)"
		: maskedFiles.length === 0
			? "(検出なし)"
			: maskedFiles
					.map(
						(file) =>
							`- ${file.path}: ${file.findings
								.map((f) => `L${f.line}(${f.kind})`)
								.join(", ")}`,
					)
					.join("\n");

	const content = [
		`このファイルは Legacy VB.NET Workbench が「${title}」の論理構成(.sln / .vbproj)に基づき、ソースコードを 1 ファイルにまとめたものです(Repomix 形式)。`,
		"",
		"<file_summary>",
		"<purpose>",
		"AI にコードベース全体を渡すためのパック済み表現。",
		"パスは物理配置ではなく Visual Studio の論理構成(Link 解決済み)に基づく。",
		"AI がコードを理解し質問に回答するための入力であり、このままコンパイル・実行できる形であることは保証しない。",
		"</purpose>",
		"<notes>",
		"- 文字コードは UTF-8 に統一済み(元ファイルの Shift_JIS 等は自動変換)",
		"- EmbeddedResource(.resx)は含まれない",
		options.includeSensitive
			? "- Designer 関連ファイルは含まれる"
			: uiSummaryEnabled
				? "- Designer 関連ファイルの原文は含まれない(フォームのコントロール構成のみ <ui_summary> として要約)"
				: "- Designer 関連ファイルは含まれない",
		options.maskCredentials
			? "- 認証情報らしき値は [MASKED] に自動置換済み。[MASKED] は伏せ字であり、元のソースには実際の値が存在する(<masked_credentials> を参照。機械判定のため漏れの可能性はあり、共有前に目視確認を推奨)"
			: "- 認証情報の自動マスクは無効(ハードコードされた認証情報がそのまま含まれる可能性あり)",
		deps.ignoreReasonFor !== undefined
			? "- .gitignore / .repomixignore に一致するファイルは除外済み(本家 repomix と同様)"
			: "- .gitignore は考慮していない(設定 exportRespectGitignore で無効化されている)",
		"- 除外・未解決のファイルは <skipped_files> を参照",
		"- このファイルは読み取り専用の成果物であり、編集しても元のプロジェクトには反映されない",
		"</notes>",
		"</file_summary>",
		"",
		"<directory_structure>",
		treeLines.join("\n"),
		"</directory_structure>",
		"",
		"<files>",
		fileEntries.join("\n\n"),
		"</files>",
		"",
		"<skipped_files>",
		skippedSection,
		"</skipped_files>",
		"",
		"<masked_credentials>",
		maskedSection,
		"</masked_credentials>",
		"",
	].join("\n");

	return {
		content,
		fileCount,
		totalChars,
		skipped,
		maskedFiles,
		maskedCount,
		uiSummaryCount,
	};
}
