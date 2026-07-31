/**
 * .sln の最小解析(引き継ぎ仕様書 §18)。
 *
 * Project("{TYPE-GUID}") = "名前", "相対パス", "{GUID}" 行の抽出のみを行い、
 * 対象は .vbproj に限定する。Solution Folder・他言語プロジェクトは
 * スキップして診断に残す。Global セクション等は読まない。
 * vscode モジュールに依存しない純粋関数(単体テスト対象)。
 */

import * as path from "path";
import { resolveWindowsPath } from "./paths";
import type { ParseDiagnostic, SlnParseResult, SolutionProject } from "./types";

/** ファイルシステム依存の注入口(テストでは fake を渡す) */
export interface SlnParserDeps {
	fileExists(absolutePath: string): boolean;
}

/** Solution Folder のプロジェクト種別 GUID(大文字で比較) */
const SOLUTION_FOLDER_TYPE_GUID = "2150E333-8FDC-42A3-9474-1A3956D46DE8";

/**
 * Project("{型GUID}") = "名前", "パス", "{GUID}" の行にマッチする。
 * 行頭空白は事前に trim しておくこと。
 */
const PROJECT_LINE =
	/^Project\("\{([^}]+)\}"\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"\{([^}]+)\}"/;

export function parseSln(
	content: string,
	solutionPath: string,
	deps: SlnParserDeps,
): SlnParseResult {
	const solutionDir = path.dirname(solutionPath);
	const projects: SolutionProject[] = [];
	const diagnostics: ParseDiagnostic[] = [];

	// BOM 除去(VS が保存する .sln は UTF-8 BOM 付きが多い)
	const text = content.replace(/^\uFEFF/, "");

	if (!text.includes("Microsoft Visual Studio Solution File")) {
		diagnostics.push({
			severity: "warning",
			message:
				"Visual Studio ソリューションのヘッダーが見つかりません(.sln 以外のファイルの可能性があります)",
		});
	}

	for (const rawLine of text.split(/\r?\n/)) {
		const match = PROJECT_LINE.exec(rawLine.trim());
		if (match === null) {
			continue;
		}
		const [, projectTypeGuid, name, relativePath, projectGuid] = match;

		if (projectTypeGuid.toUpperCase() === SOLUTION_FOLDER_TYPE_GUID) {
			diagnostics.push({
				severity: "info",
				message: `Solution Folder "${name}" は未対応のためスキップしました`,
			});
			continue;
		}
		if (!/\.vbproj$/i.test(relativePath)) {
			diagnostics.push({
				severity: "info",
				message: `.vbproj 以外のプロジェクトはスキップしました: "${name}"(${relativePath})`,
			});
			continue;
		}

		const absolutePath = resolveWindowsPath(relativePath, solutionDir);
		projects.push({
			name,
			relativePath,
			absolutePath,
			projectGuid,
			projectTypeGuid,
			exists: deps.fileExists(absolutePath),
		});
	}

	if (projects.length === 0) {
		diagnostics.push({
			severity: "warning",
			message: "この .sln に VB プロジェクト(.vbproj)の定義が見つかりませんでした",
		});
	}

	return { solutionPath, solutionDir, projects, diagnostics };
}
