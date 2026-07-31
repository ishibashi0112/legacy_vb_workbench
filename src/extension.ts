/**
 * 拡張のエントリポイント。
 * .vbproj 単体または .sln を選択 → 静的解析 → 専用 Tree View に論理構造を表示する。
 * 解析結果の JSON は引き続き Output Channel でも確認できる。
 */

import * as fs from "fs";
import * as vscode from "vscode";
import { buildLogicalTree, buildSolutionTree } from "./logicalTreeBuilder";
import { LegacyProjectTreeProvider } from "./legacyProjectTreeProvider";
import { parseSln } from "./slnParser";
import type {
	FileNode,
	ParseDiagnostic,
	ProjectItemStatus,
	VbprojParseResult,
} from "./types";
import { parseVbproj } from "./vbprojParser";

/** 直近に選択した .vbproj / .sln(手動更新・起動時復元で再利用) */
const LAST_SELECTION_KEY = "legacyVbWorkbench.lastSelection";

interface LastSelection {
	kind: "vbproj" | "sln";
	path: string;
}

function isLastSelection(value: unknown): value is LastSelection {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		(record["kind"] === "vbproj" || record["kind"] === "sln") &&
		typeof record["path"] === "string"
	);
}

const STATUS_ORDER: readonly ProjectItemStatus[] = [
	"resolved",
	"missing",
	"unresolved-expression",
	"wildcard",
	"conditional",
];

const FS_DEPS = {
	fileExists: (absolutePath: string): boolean => fs.existsSync(absolutePath),
};

export function activate(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel("Legacy VB Workbench");
	const provider = new LegacyProjectTreeProvider();
	const treeView = vscode.window.createTreeView("legacyVbWorkbench.projects", {
		treeDataProvider: provider,
	});
	context.subscriptions.push(channel, treeView);

	const runSelection = (selection: LastSelection, quiet = false): void => {
		if (selection.kind === "sln") {
			runParseSolution(selection.path, channel, provider, { quiet });
		} else {
			runParseVbproj(selection.path, channel, provider, { quiet });
		}
	};

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
			const selection: LastSelection = { kind: "vbproj", path: uri.fsPath };
			await context.workspaceState.update(LAST_SELECTION_KEY, selection);
			runSelection(selection);
		}),

		vscode.commands.registerCommand("legacyVbWorkbench.selectSolution", async () => {
			const picked = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: "この .sln を解析",
				filters: { "VB Solution": ["sln"] },
				defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
			});
			const uri = picked?.[0];
			if (uri === undefined) {
				return;
			}
			const selection: LastSelection = { kind: "sln", path: uri.fsPath };
			await context.workspaceState.update(LAST_SELECTION_KEY, selection);
			runSelection(selection);
		}),

		vscode.commands.registerCommand("legacyVbWorkbench.refresh", () => {
			const last = context.workspaceState.get<unknown>(LAST_SELECTION_KEY);
			if (!isLastSelection(last)) {
				void vscode.window.showWarningMessage(
					"先に「Legacy VB: Select Solution」または「Legacy VB: Select VB Project」で対象を選択してください。",
				);
				return;
			}
			runSelection(last);
		}),

		vscode.commands.registerCommand("legacyVbWorkbench.openFile", (node: unknown) => {
			if (!isFileNode(node)) {
				return;
			}
			void openProjectFile(node);
		}),
	);

	// 起動時に前回の選択があれば自動で復元する
	const last = context.workspaceState.get<unknown>(LAST_SELECTION_KEY);
	if (isLastSelection(last) && fs.existsSync(last.path)) {
		runSelection(last, true);
	}
}

export function deactivate(): void {}

/** コマンド引数が FileNode かどうかの型ガード(自前ツリー以外からの呼び出し対策) */
function isFileNode(value: unknown): value is FileNode {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return record["type"] === "file" && typeof record["item"] === "object";
}

/** Tree View からのクリックで物理ファイルを開く(Designer 関連は確認を挟む) */
async function openProjectFile(node: FileNode): Promise<void> {
	const item = node.item;
	if (item.sourcePath === undefined) {
		void vscode.window.showWarningMessage(
			`このファイルは開けません: ${item.include}\n${item.unresolvedReason ?? ""}`,
		);
		return;
	}
	if (!item.exists) {
		void vscode.window.showWarningMessage(
			`ファイルが存在しません: ${item.sourcePath}`,
		);
		return;
	}
	if (item.isSensitive) {
		const choice = await vscode.window.showWarningMessage(
			`「${node.label}」は Designer 関連ファイルです。`,
			{
				modal: true,
				detail:
					"Visual Studio が自動生成・管理するファイルのため、手動編集はフォームデザイナーの破損につながる可能性があります。開きますか?",
			},
			"開く",
		);
		if (choice !== "開く") {
			return;
		}
	}
	await vscode.window.showTextDocument(vscode.Uri.file(item.sourcePath), {
		preview: true,
	});
}

interface RunOptions {
	quiet?: boolean;
}

/** ファイルを UTF-8 で読む。失敗時はエラーメッセージを返して undefined */
function tryReadFile(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(
			`ファイルを読み込めません: ${filePath}(${message})`,
		);
		return undefined;
	}
}

/** .vbproj 単体を解析し、ツリー更新と Output Channel への出力を行う */
function runParseVbproj(
	projectPath: string,
	channel: vscode.OutputChannel,
	provider: LegacyProjectTreeProvider,
	options: RunOptions = {},
): void {
	const xml = tryReadFile(projectPath);
	if (xml === undefined) {
		return;
	}
	const result = parseVbproj(xml, projectPath, FS_DEPS);
	const tree = buildLogicalTree(result);
	provider.setRoot(tree.root);

	printHeader(channel, `解析: ${projectPath}`);
	printProjectBody(result, tree.diagnostics, channel);
	notifyCompletion(
		[...result.diagnostics, ...tree.diagnostics],
		`解析完了: ${result.items.length} 項目`,
		channel,
		options,
	);
}

/** .sln を解析し、含まれる全 .vbproj を読み込んでツリーを構築する */
function runParseSolution(
	solutionPath: string,
	channel: vscode.OutputChannel,
	provider: LegacyProjectTreeProvider,
	options: RunOptions = {},
): void {
	const content = tryReadFile(solutionPath);
	if (content === undefined) {
		return;
	}
	const slnResult = parseSln(content, solutionPath, FS_DEPS);

	const projectResults: VbprojParseResult[] = [];
	const readDiagnostics: ParseDiagnostic[] = [];
	for (const project of slnResult.projects) {
		if (!project.exists) {
			continue; // buildSolutionTree 側で警告ノードになる
		}
		try {
			const xml = fs.readFileSync(project.absolutePath, "utf8");
			projectResults.push(parseVbproj(xml, project.absolutePath, FS_DEPS));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			readDiagnostics.push({
				severity: "error",
				message: `プロジェクトの読み込みに失敗しました: ${project.absolutePath}(${message})`,
			});
		}
	}

	const tree = buildSolutionTree(slnResult, projectResults);
	provider.setRoot(tree.root);

	printHeader(channel, `ソリューション解析: ${solutionPath}`);
	printDiagnostics("診断(.sln)", [...slnResult.diagnostics, ...readDiagnostics], channel);
	for (const result of projectResults) {
		channel.appendLine(`--- プロジェクト: ${result.projectPath} ---`);
		printProjectBody(result, [], channel);
	}
	printDiagnostics("診断(ツリー構築)", tree.diagnostics, channel);

	const allDiagnostics = [
		...slnResult.diagnostics,
		...readDiagnostics,
		...projectResults.flatMap((result) => result.diagnostics),
		...tree.diagnostics,
	];
	const totalItems = projectResults.reduce((sum, r) => sum + r.items.length, 0);
	notifyCompletion(
		allDiagnostics,
		`解析完了: ${slnResult.projects.length} プロジェクト / ${totalItems} 項目`,
		channel,
		options,
	);
}

function notifyCompletion(
	diagnostics: readonly ParseDiagnostic[],
	successMessage: string,
	channel: vscode.OutputChannel,
	options: RunOptions,
): void {
	if (options.quiet === true) {
		return;
	}
	channel.show(true);
	const errorCount = diagnostics.filter((d) => d.severity === "error").length;
	const warningCount = diagnostics.filter((d) => d.severity === "warning").length;
	if (errorCount > 0) {
		void vscode.window.showErrorMessage(
			"解析でエラーが発生しました。Output「Legacy VB Workbench」を確認してください。",
		);
	} else {
		void vscode.window.showInformationMessage(
			`${successMessage}(警告 ${warningCount} 件)`,
		);
	}
}

function printHeader(channel: vscode.OutputChannel, title: string): void {
	channel.appendLine("========================================");
	channel.appendLine(`[${new Date().toLocaleString()}] ${title}`);
}

function printDiagnostics(
	title: string,
	diagnostics: readonly ParseDiagnostic[],
	channel: vscode.OutputChannel,
): void {
	if (diagnostics.length === 0) {
		return;
	}
	channel.appendLine(`${title}:`);
	for (const diagnostic of diagnostics) {
		const suffix =
			diagnostic.itemInclude === undefined
				? ""
				: ` (Include="${diagnostic.itemInclude}")`;
		channel.appendLine(`  [${diagnostic.severity}] ${diagnostic.message}${suffix}`);
	}
}

function printProjectBody(
	result: VbprojParseResult,
	treeDiagnostics: readonly ParseDiagnostic[],
	channel: vscode.OutputChannel,
): void {
	const statusCounts = new Map<ProjectItemStatus, number>();
	for (const item of result.items) {
		statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
	}
	const statusSummary = STATUS_ORDER.filter((status) => statusCounts.has(status))
		.map((status) => `${status}: ${statusCounts.get(status)}`)
		.join(" / ");
	const sensitiveCount = result.items.filter((item) => item.isSensitive).length;

	channel.appendLine(
		`項目数: ${result.items.length}` +
			(statusSummary === "" ? "" : `(${statusSummary})`),
	);
	channel.appendLine(`Designer 関連(要注意): ${sensitiveCount}`);
	printDiagnostics("診断(解析)", result.diagnostics, channel);
	printDiagnostics("診断(ツリー構築)", treeDiagnostics, channel);
	channel.appendLine("--- ProjectItem[] (JSON) ---");
	channel.appendLine(JSON.stringify(result.items, null, 2));
	channel.appendLine("");
}
