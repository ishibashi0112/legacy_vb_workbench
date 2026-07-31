/**
 * 拡張のエントリポイント。
 * 現段階のプロトタイプ: .vbproj を選択 → 静的解析 → Output Channel へ JSON 出力。
 * Tree View は次のステップで追加する。
 */

import * as fs from "fs";
import * as vscode from "vscode";
import type { ProjectItemStatus, VbprojParseResult } from "./types";
import { parseVbproj } from "./vbprojParser";

/** 直近に選択した .vbproj のパス(手動更新コマンドで再利用) */
const LAST_PROJECT_KEY = "legacyVbWorkbench.lastProjectPath";

const STATUS_ORDER: readonly ProjectItemStatus[] = [
	"resolved",
	"missing",
	"unresolved-expression",
	"wildcard",
	"conditional",
];

export function activate(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel("Legacy VB Workbench");
	context.subscriptions.push(channel);

	context.subscriptions.push(
		vscode.commands.registerCommand("legacyVbWorkbench.selectProject", async () => {
			const picked = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: "この .vbproj を解析",
				filters: { "VB Project": ["vbproj"] },
				defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
			});
			const uri = picked?.[0];
			if (uri === undefined) {
				return;
			}
			await context.workspaceState.update(LAST_PROJECT_KEY, uri.fsPath);
			runParse(uri.fsPath, channel);
		}),

		vscode.commands.registerCommand("legacyVbWorkbench.refresh", () => {
			const last = context.workspaceState.get<string>(LAST_PROJECT_KEY);
			if (last === undefined) {
				void vscode.window.showWarningMessage(
					"先に「Legacy VB: Select VB Project」で .vbproj を選択してください。",
				);
				return;
			}
			runParse(last, channel);
		}),
	);
}

export function deactivate(): void {}

/** .vbproj を読み込み、解析結果を Output Channel へ出力する */
function runParse(projectPath: string, channel: vscode.OutputChannel): void {
	let xml: string;
	try {
		xml = fs.readFileSync(projectPath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`.vbproj を読み込めません: ${message}`);
		return;
	}

	const result = parseVbproj(xml, projectPath, {
		fileExists: (absolutePath) => fs.existsSync(absolutePath),
	});

	printResult(result, channel);
	channel.show(true);

	const errorCount = result.diagnostics.filter((d) => d.severity === "error").length;
	const warningCount = result.diagnostics.filter((d) => d.severity === "warning").length;
	if (errorCount > 0) {
		void vscode.window.showErrorMessage(
			"解析に失敗しました。Output「Legacy VB Workbench」を確認してください。",
		);
	} else {
		void vscode.window.showInformationMessage(
			`解析完了: ${result.items.length} 項目(警告 ${warningCount} 件)`,
		);
	}
}

function printResult(result: VbprojParseResult, channel: vscode.OutputChannel): void {
	const statusCounts = new Map<ProjectItemStatus, number>();
	for (const item of result.items) {
		statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
	}
	const statusSummary = STATUS_ORDER.filter((status) => statusCounts.has(status))
		.map((status) => `${status}: ${statusCounts.get(status)}`)
		.join(" / ");
	const sensitiveCount = result.items.filter((item) => item.isSensitive).length;

	channel.appendLine("========================================");
	channel.appendLine(`[${new Date().toLocaleString()}] 解析: ${result.projectPath}`);
	channel.appendLine(
		`項目数: ${result.items.length}` +
			(statusSummary === "" ? "" : `(${statusSummary})`),
	);
	channel.appendLine(`Designer 関連(要注意): ${sensitiveCount}`);

	if (result.diagnostics.length > 0) {
		channel.appendLine("診断:");
		for (const diagnostic of result.diagnostics) {
			const suffix =
				diagnostic.itemInclude === undefined ? "" : ` (Include="${diagnostic.itemInclude}")`;
			channel.appendLine(`  [${diagnostic.severity}] ${diagnostic.message}${suffix}`);
		}
	}

	channel.appendLine("--- ProjectItem[] (JSON) ---");
	channel.appendLine(JSON.stringify(result.items, null, 2));
	channel.appendLine("");
}
