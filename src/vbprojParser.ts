/**
 * 旧形式 .vbproj の静的 XML 解析。
 *
 * MSBuild 評価は行わない。$()/@()/%()・ワイルドカード・Condition は
 * 展開せず、status として保持するだけに留める(引き継ぎ仕様書 §7 フェーズ1)。
 * ファイルシステムアクセスは deps 経由で注入し、純粋関数としてテスト可能にする。
 */

import * as path from "path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { resolveWindowsPath } from "./paths";
import type {
	ParseDiagnostic,
	ProjectItem,
	ProjectItemKind,
	VbprojParseResult,
} from "./types";

/** ファイルシステム依存の注入口(テストでは fake を渡す) */
export interface VbprojParserDeps {
	fileExists(absolutePath: string): boolean;
}

/** 今回のプロトタイプで解析対象とするファイル項目種別 */
const FILE_ITEM_KINDS = [
	"Compile",
	"EmbeddedResource",
	"Content",
	"None",
] as const satisfies readonly ProjectItemKind[];

type FileItemKind = (typeof FILE_ITEM_KINDS)[number];

/** MSBuild 式 $(...) / @(...) / %(...) の検出 */
const MSBUILD_EXPRESSION = /[$@%]\(/;

/** ワイルドカードの検出 */
const WILDCARD = /[*?]/;

/** 値が True のとき Designer 関連とみなすメタデータ */
const SENSITIVE_FLAG_METADATA = ["AutoGen", "DesignTime", "DesignTimeSharedInput"];

/** 存在するだけで Designer 関連とみなすメタデータ */
const SENSITIVE_PRESENCE_METADATA = ["Generator", "LastGenOutput"];

/** 拡張子による Designer 関連判定(小文字で比較) */
const SENSITIVE_SUFFIXES = [".designer.vb", ".resx", ".settings"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** fast-xml-parser は要素が 1 つだと配列にしないため、常に配列へ揃える */
function toArray(value: unknown): unknown[] {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

/** 表示用論理パスへ正規化(VS の Solution Explorer と同じ `\` 区切り) */
function toLogicalPath(value: string): string {
	return value
		.split(/[\\/]/)
		.filter((segment) => segment !== "" && segment !== ".")
		.join("\\");
}

/** メタデータ名は大文字小文字を区別しない(MSBuild の仕様に合わせる) */
function getMetadata(
	metadata: Record<string, string>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(metadata)) {
		if (key.toLowerCase() === lower) {
			return value;
		}
	}
	return undefined;
}

function combineConditions(
	groupCondition: string | undefined,
	itemCondition: string | undefined,
): string | undefined {
	if (groupCondition !== undefined && itemCondition !== undefined) {
		return `(${groupCondition}) AND (${itemCondition})`;
	}
	return itemCondition ?? groupCondition;
}

function isDesignerRelated(
	logicalPath: string,
	metadata: Record<string, string>,
): boolean {
	const fileName = (logicalPath.split("\\").pop() ?? "").toLowerCase();
	if (SENSITIVE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
		return true;
	}
	for (const name of SENSITIVE_FLAG_METADATA) {
		if (getMetadata(metadata, name)?.toLowerCase() === "true") {
			return true;
		}
	}
	for (const name of SENSITIVE_PRESENCE_METADATA) {
		if (getMetadata(metadata, name) !== undefined) {
			return true;
		}
	}
	return false;
}

/** Item 要素 1 件を ProjectItem へ正規化する。Include 欠落などは undefined */
function buildProjectItem(
	kind: FileItemKind,
	entry: unknown,
	groupCondition: string | undefined,
	projectDir: string,
	deps: VbprojParserDeps,
	diagnostics: ParseDiagnostic[],
): ProjectItem | undefined {
	if (!isRecord(entry)) {
		diagnostics.push({
			severity: "warning",
			message: `内容が空の <${kind}> 要素をスキップしました`,
		});
		return undefined;
	}

	const include = asString(entry["@_Include"]);
	if (include === undefined || include === "") {
		diagnostics.push({
			severity: "warning",
			message: `Include 属性のない <${kind}> 要素をスキップしました`,
		});
		return undefined;
	}

	// Include / Condition 以外の子要素・属性をメタデータとして全保持する
	const metadata: Record<string, string> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (key === "@_Include" || key === "@_Condition" || key === "#text") {
			continue;
		}
		if (key.startsWith("@_")) {
			// Item の未知の属性もメタデータとして保持(@_ を外す)
			const attrValue = asString(value);
			if (attrValue !== undefined) {
				metadata[key.slice(2)] = attrValue;
			}
			continue;
		}
		const text = asString(value);
		if (text !== undefined) {
			metadata[key] = text;
			continue;
		}
		// <Link Condition="...">x</Link> のような属性付きメタデータ
		if (isRecord(value)) {
			const innerText = asString(value["#text"]);
			if (innerText !== undefined) {
				metadata[key] = innerText;
				diagnostics.push({
					severity: "info",
					message: `メタデータ <${key}> の属性は無視しました`,
					itemInclude: include,
				});
				continue;
			}
		}
		diagnostics.push({
			severity: "warning",
			message: `メタデータ <${key}> を文字列として解釈できなかったため無視しました`,
			itemInclude: include,
		});
	}

	const link = getMetadata(metadata, "Link");
	const dependentUpon = getMetadata(metadata, "DependentUpon");
	const subType = getMetadata(metadata, "SubType");
	const condition = combineConditions(groupCondition, asString(entry["@_Condition"]));

	const logicalPath = toLogicalPath(link ?? include);
	const isSensitive = isDesignerRelated(logicalPath, metadata);

	const base = {
		kind,
		include,
		logicalPath,
		link,
		dependentUpon,
		subType,
		condition,
		isSensitive,
		metadata,
	};

	// 状態判定の優先順位: unresolved-expression > wildcard > conditional > missing > resolved
	if (MSBUILD_EXPRESSION.test(include) || (link !== undefined && MSBUILD_EXPRESSION.test(link))) {
		return {
			...base,
			exists: false,
			status: "unresolved-expression",
			unresolvedReason:
				"MSBuild 式 $()/@()/%() を含むため静的解析では解決できません",
		};
	}
	if (WILDCARD.test(include)) {
		return {
			...base,
			exists: false,
			status: "wildcard",
			unresolvedReason: "ワイルドカードは初期段階では展開しません",
		};
	}

	const sourcePath = resolveWindowsPath(include, projectDir);
	const exists = deps.fileExists(sourcePath);

	if (condition !== undefined) {
		return {
			...base,
			sourcePath,
			exists,
			status: "conditional",
			unresolvedReason: "Condition 付きのため実際に含まれるかは評価していません",
		};
	}
	return {
		...base,
		sourcePath,
		exists,
		status: exists ? "resolved" : "missing",
	};
}

/** ItemGroup 内の未対応項目種別を数え、診断として報告する */
function reportUnsupportedKinds(
	counts: Map<string, number>,
	diagnostics: ParseDiagnostic[],
): void {
	if (counts.size === 0) {
		return;
	}
	const summary = [...counts.entries()]
		.map(([tag, count]) => `${tag} ×${count}`)
		.join(", ");
	diagnostics.push({
		severity: "info",
		message: `未対応の項目種別のため解析対象外: ${summary}`,
	});
}

/**
 * .vbproj の XML 文字列を解析し、正規化した ProjectItem 配列と診断を返す。
 *
 * @param xmlContent .vbproj の内容(BOM 付き可)
 * @param projectPath .vbproj の絶対パス(相対パス解決の基準に使用)
 * @param deps ファイルシステム依存の注入
 */
export function parseVbproj(
	xmlContent: string,
	projectPath: string,
	deps: VbprojParserDeps,
): VbprojParseResult {
	const projectDir = path.dirname(projectPath);
	const diagnostics: ParseDiagnostic[] = [];
	const items: ProjectItem[] = [];
	const result: VbprojParseResult = { projectPath, projectDir, items, diagnostics };

	// BOM 除去(VS が保存する .vbproj は UTF-8 BOM 付きが多い)
	const xml = xmlContent.replace(/^\uFEFF/, "");

	const validation = XMLValidator.validate(xml);
	if (validation !== true) {
		diagnostics.push({
			severity: "error",
			message: `XML として解析できません: ${validation.err.msg}(${validation.err.line}行目)`,
		});
		return result;
	}

	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "@_",
		removeNSPrefix: true,
		parseTagValue: false,
		parseAttributeValue: false,
		trimValues: true,
	});

	let parsed: unknown;
	try {
		parsed = parser.parse(xml);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		diagnostics.push({
			severity: "error",
			message: `XML の解析に失敗しました: ${message}`,
		});
		return result;
	}

	if (!isRecord(parsed)) {
		diagnostics.push({ severity: "error", message: "XML のルートを解釈できません" });
		return result;
	}
	const project = parsed["Project"];
	if (!isRecord(project)) {
		diagnostics.push({
			severity: "error",
			message: "<Project> 要素が見つかりません(.vbproj ではない可能性があります)",
		});
		return result;
	}

	const toolsVersion = asString(project["@_ToolsVersion"]);
	if (toolsVersion !== undefined) {
		diagnostics.push({ severity: "info", message: `ToolsVersion: ${toolsVersion}` });
	}

	// Project 直下の未対応要素(仕様書 §7 で対応不能・未解決扱いとしたもの)
	const importCount = toArray(project["Import"]).length;
	if (importCount > 0) {
		diagnostics.push({
			severity: "info",
			message: `<Import> ×${importCount} は未対応です(Import 先の項目は表示されません)`,
		});
	}
	if (project["Choose"] !== undefined) {
		diagnostics.push({
			severity: "warning",
			message: "<Choose>/<When>/<Otherwise> は静的解析では評価されません",
		});
	}

	const unsupportedKindCounts = new Map<string, number>();
	const fileKindSet = new Set<string>(FILE_ITEM_KINDS);

	for (const groupValue of toArray(project["ItemGroup"])) {
		if (!isRecord(groupValue)) {
			continue; // <ItemGroup/> は空文字列になるため無視してよい
		}
		const groupCondition = asString(groupValue["@_Condition"]);

		for (const [tag, value] of Object.entries(groupValue)) {
			if (tag.startsWith("@_") || tag === "#text") {
				continue;
			}
			if (!fileKindSet.has(tag)) {
				const count = toArray(value).length;
				unsupportedKindCounts.set(
					tag,
					(unsupportedKindCounts.get(tag) ?? 0) + count,
				);
				continue;
			}
			for (const entry of toArray(value)) {
				const item = buildProjectItem(
					tag as FileItemKind,
					entry,
					groupCondition,
					projectDir,
					deps,
					diagnostics,
				);
				if (item !== undefined) {
					items.push(item);
				}
			}
		}
	}

	reportUnsupportedKinds(unsupportedKindCounts, diagnostics);
	return result;
}
