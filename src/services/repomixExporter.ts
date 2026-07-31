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
import type { FileNode, LegacyTreeNode, VbprojParseResult } from "../types";

export interface RepomixSource {
	/** 表示名(.sln 上のプロジェクト名など)。ツリーとパスの先頭に使う */
	label: string;
	parseResult: VbprojParseResult;
}

export interface RepomixExportDeps {
	/** ファイルを読み UTF-8 文字列で返す(失敗時 undefined)。エンコーディング変換は呼び出し側 */
	readTextFile(absolutePath: string): string | undefined;
}

export interface RepomixExportOptions {
	/** Designer 関連(*.Designer.vb / *.resx 除く自動生成系)を含めるか */
	includeSensitive: boolean;
}

export interface SkippedFile {
	path: string;
	reason: string;
}

export interface RepomixExportResult {
	content: string;
	fileCount: number;
	totalChars: number;
	skipped: SkippedFile[];
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
	let fileCount = 0;
	let totalChars = 0;

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
				skipped.push({ path: displayPath, reason });
				continue;
			}
			// skipReason 通過時点で sourcePath は解決済み
			const sourcePath = node.item.sourcePath as string;
			const content = deps.readTextFile(sourcePath);
			if (content === undefined) {
				skipped.push({ path: displayPath, reason: "読み込みに失敗しました" });
				continue;
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

	const skippedSection =
		skipped.length === 0
			? "(なし)"
			: skipped.map((s) => `- ${s.path}: ${s.reason}`).join("\n");

	const content = [
		`このファイルは Legacy VB.NET Workbench が「${title}」の論理構成(.sln / .vbproj)に基づき、ソースコードを 1 ファイルにまとめたものです(Repomix 形式)。`,
		"",
		"<file_summary>",
		"<purpose>",
		"AI にコードベース全体を渡すためのパック済み表現。",
		"パスは物理配置ではなく Visual Studio の論理構成(Link 解決済み)に基づく。",
		"</purpose>",
		"<notes>",
		"- 文字コードは UTF-8 に統一済み(元ファイルの Shift_JIS 等は自動変換)",
		"- EmbeddedResource(.resx)は含まれない",
		`- Designer 関連ファイルは${options.includeSensitive ? "含まれる" : "含まれない"}`,
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
	].join("\n");

	return { content, fileCount, totalChars, skipped };
}
