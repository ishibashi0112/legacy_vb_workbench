/**
 * 拡張のエントリポイント。
 * .vbproj 単体または .sln を選択 → 静的解析 → 専用 Tree View に論理構造を表示する。
 * 解析結果の JSON は引き続き Output Channel でも確認できる。
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { buildLogicalTree, buildSolutionTree } from "./logicalTreeBuilder";
import { LegacyProjectDragController } from "./legacyProjectDragController";
import { LegacyProjectTreeProvider } from "./legacyProjectTreeProvider";
import { BuildService } from "./services/buildService";
import {
	locateDevenv,
	locateMsbuild,
	type LocatorDeps,
} from "./services/msbuildLocator";
import {
	buildRepomixOutput,
	decodeSourceBuffer,
	type RepomixSource,
} from "./services/repomixExporter";
import { launchVisualStudio } from "./services/visualStudioLauncher";
import { parseSln } from "./slnParser";
import type {
	FileNode,
	ParseDiagnostic,
	ProjectItemStatus,
	SlnParseResult,
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
	const buildChannel = vscode.window.createOutputChannel("Legacy VB Build");
	const buildService = new BuildService(buildChannel);
	context.subscriptions.push(buildChannel);
	const provider = new LegacyProjectTreeProvider();
	const treeView = vscode.window.createTreeView("legacyVbWorkbench.projects", {
		treeDataProvider: provider,
		dragAndDropController: new LegacyProjectDragController(),
		// Ctrl/Cmd+クリックで複数選択してまとめてドラッグできるようにする
		canSelectMany: true,
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

		vscode.commands.registerCommand("legacyVbWorkbench.buildSolution", (node: unknown) => {
			void runBuild(buildService, buildChannel, resolveBuildTarget(node, context));
		}),

		vscode.commands.registerCommand(
			"legacyVbWorkbench.openInVisualStudio",
			(node: unknown) => {
				void openInVisualStudio(resolveBuildTarget(node, context));
			},
		),

		vscode.commands.registerCommand("legacyVbWorkbench.exportRepomix", (node: unknown) => {
			void exportRepomix(context, node);
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

/**
 * ダブルクリック検出用の状態。
 * TreeView のクリックはコマンド発火のみでシングル/ダブルの区別がないため、
 * 標準エクスプローラーと同様の「1回目=プレビュー / 2回目=タブ固定」を
 * 同一ノードへの連続クリック時間で判定する。
 */
const DOUBLE_CLICK_THRESHOLD_MS = 500;
let lastClick: { nodeId: string; time: number } | undefined;

/** Designer 確認ダイアログ表示中のノード(ダブルクリックでの二重ダイアログ防止) */
const pendingConfirms = new Map<string, { pin: boolean }>();

/** Tree View からのクリックで物理ファイルを開く(Designer 関連は確認を挟む) */
async function openProjectFile(node: FileNode): Promise<void> {
	const now = Date.now();
	const isDoubleClick =
		lastClick !== undefined &&
		lastClick.nodeId === node.id &&
		now - lastClick.time < DOUBLE_CLICK_THRESHOLD_MS;
	lastClick = { nodeId: node.id, time: now };

	// 確認ダイアログ表示中に再クリックされた場合は、固定要求だけ引き継いで終了
	const pending = pendingConfirms.get(node.id);
	if (pending !== undefined) {
		if (isDoubleClick) {
			pending.pin = true;
		}
		return;
	}

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

	let pin = isDoubleClick;
	if (item.isSensitive) {
		const state = { pin };
		pendingConfirms.set(node.id, state);
		let choice: string | undefined;
		try {
			choice = await vscode.window.showWarningMessage(
				`「${node.label}」は Designer 関連ファイルです。`,
				{
					modal: true,
					detail:
						"Visual Studio が自動生成・管理するファイルのため、手動編集はフォームデザイナーの破損につながる可能性があります。開きますか?",
				},
				"開く",
			);
		} finally {
			pendingConfirms.delete(node.id);
		}
		if (choice !== "開く") {
			return;
		}
		pin = state.pin;
	}
	await vscode.window.showTextDocument(vscode.Uri.file(item.sourcePath), {
		preview: !pin,
	});
}

// ---------------------------------------------------------------------------
// MSBuild ビルド / Visual Studio 起動(handoff §19–20)
// ---------------------------------------------------------------------------

/**
 * ビルド・VS 起動の対象パスを決める。
 * コンテキストメニューから呼ばれた場合はそのノードの .sln / .vbproj、
 * コマンドパレットからの場合は前回選択した対象を使う。
 */
function resolveBuildTarget(
	node: unknown,
	context: vscode.ExtensionContext,
): string | undefined {
	if (typeof node === "object" && node !== null) {
		const record = node as Record<string, unknown>;
		if (record["type"] === "solution" && typeof record["solutionPath"] === "string") {
			return record["solutionPath"];
		}
		if (record["type"] === "project" && typeof record["projectPath"] === "string") {
			return record["projectPath"];
		}
	}
	const last = context.workspaceState.get<unknown>(LAST_SELECTION_KEY);
	return isLastSelection(last) ? last.path : undefined;
}

/** reg.exe query を実行して標準出力を返す(失敗時 undefined) */
function queryRegistry(
	keyPath: string,
	valueName: string,
	view32: boolean,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const args = ["query", keyPath, "/v", valueName];
		if (view32) {
			args.push("/reg:32");
		}
		execFile("reg", args, { windowsHide: true }, (error, stdout) => {
			resolve(error !== null ? undefined : stdout);
		});
	});
}

/** vswhere.exe の既定の場所(VS2017 以降のインストーラーが必ずここに置く) */
const VSWHERE_PATH =
	"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";

/** vswhere.exe を実行して標準出力を返す(不在・失敗時 undefined) */
function runVswhere(args: readonly string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		if (!fs.existsSync(VSWHERE_PATH)) {
			resolve(undefined);
			return;
		}
		execFile(VSWHERE_PATH, [...args], { windowsHide: true }, (error, stdout) => {
			resolve(error !== null ? undefined : stdout);
		});
	});
}

function locatorDeps(configKey: "msbuildPath" | "devenvPath"): LocatorDeps {
	const configured = vscode.workspace
		.getConfiguration("legacyVbWorkbench")
		.get<string>(configKey);
	return {
		configuredPath:
			configured === undefined || configured.trim() === "" ? undefined : configured,
		fileExists: (absolutePath) => fs.existsSync(absolutePath),
		queryRegistry,
		runVswhere,
	};
}

/** 自動検出に失敗したとき、手動選択させて設定に保存する */
async function promptForExecutable(
	displayName: string,
	configKey: "msbuildPath" | "devenvPath",
): Promise<string | undefined> {
	const choice = await vscode.window.showErrorMessage(
		`${displayName} が見つかりませんでした。場所を手動で選択できます。`,
		"選択する...",
	);
	if (choice !== "選択する...") {
		return undefined;
	}
	const picked = await vscode.window.showOpenDialog({
		canSelectMany: false,
		openLabel: `この ${displayName} を使用`,
		filters: { "実行ファイル": ["exe"] },
	});
	const exePath = picked?.[0]?.fsPath;
	if (exePath === undefined) {
		return undefined;
	}
	// 次回以降の検出のためユーザー設定へ保存する
	await vscode.workspace
		.getConfiguration("legacyVbWorkbench")
		.update(configKey, exePath, vscode.ConfigurationTarget.Global);
	return exePath;
}

async function runBuild(
	buildService: BuildService,
	buildChannel: vscode.OutputChannel,
	targetPath: string | undefined,
): Promise<void> {
	if (process.platform !== "win32") {
		void vscode.window.showWarningMessage(
			"MSBuild ビルドは Windows 環境でのみ実行できます。",
		);
		return;
	}
	if (targetPath === undefined) {
		void vscode.window.showWarningMessage(
			"先に「Legacy VB: Select Solution」等でビルド対象を選択してください。",
		);
		return;
	}
	if (buildService.isRunning) {
		void vscode.window.showWarningMessage(
			"ビルドが実行中です。完了を待つか、通知からキャンセルしてください。",
		);
		return;
	}

	const located = await locateMsbuild(locatorDeps("msbuildPath"));
	const msbuildPath =
		located?.path ?? (await promptForExecutable("MSBuild.exe", "msbuildPath"));
	if (msbuildPath === undefined) {
		return;
	}

	const config = vscode.workspace.getConfiguration("legacyVbWorkbench");
	const configuration = config.get<string>("buildConfiguration") ?? "Debug";
	const encoding = config.get<string>("msbuildOutputEncoding") ?? "cp932";

	buildChannel.show(true);
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `MSBuild ビルド中: ${path.basename(targetPath)}(${configuration})`,
			cancellable: true,
		},
		async (_progress, token) => {
			token.onCancellationRequested(() => buildService.cancel());
			try {
				const exitCode = await buildService.run(
					msbuildPath,
					targetPath,
					configuration,
					encoding,
				);
				if (token.isCancellationRequested || exitCode === null) {
					void vscode.window.showWarningMessage("ビルドをキャンセルしました。");
				} else if (exitCode === 0) {
					void vscode.window.showInformationMessage(
						`ビルド成功(${configuration})`,
					);
				} else {
					void vscode.window.showErrorMessage(
						`ビルド失敗(exit code: ${exitCode})。Output「Legacy VB Build」を確認してください。`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(
					`MSBuild を起動できませんでした: ${message}`,
				);
			}
		},
	);
}

async function openInVisualStudio(targetPath: string | undefined): Promise<void> {
	if (process.platform !== "win32") {
		void vscode.window.showWarningMessage(
			"Visual Studio 起動は Windows 環境でのみ実行できます。",
		);
		return;
	}
	if (targetPath === undefined) {
		void vscode.window.showWarningMessage(
			"先に「Legacy VB: Select Solution」等で対象を選択してください。",
		);
		return;
	}
	const located = await locateDevenv(locatorDeps("devenvPath"));
	const devenvPath =
		located?.path ??
		(await promptForExecutable("devenv.exe(Visual Studio 2013)", "devenvPath"));
	if (devenvPath === undefined) {
		return;
	}
	try {
		launchVisualStudio(devenvPath, targetPath);
		void vscode.window.showInformationMessage(
			`Visual Studio で開いています: ${path.basename(targetPath)}`,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(
			`Visual Studio を起動できませんでした: ${message}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Repomix 形式エクスポート
// ---------------------------------------------------------------------------

/** ソースファイルを文字コード自動判定(BOM / UTF-8 / CP932)で読み込む */
function readSourceTextFile(absolutePath: string): string | undefined {
	try {
		return decodeSourceBuffer(fs.readFileSync(absolutePath));
	} catch {
		return undefined;
	}
}

/** 現在の選択(.sln / .vbproj)を Repomix 形式の 1 ファイルに出力する */
async function exportRepomix(
	context: vscode.ExtensionContext,
	node: unknown,
): Promise<void> {
	const target = resolveBuildTarget(node, context);
	if (target === undefined) {
		void vscode.window.showWarningMessage(
			"先に「Legacy VB: Select Solution」等で対象を選択してください。",
		);
		return;
	}
	const includeSensitive =
		vscode.workspace
			.getConfiguration("legacyVbWorkbench")
			.get<boolean>("exportIncludeDesignerFiles") ?? false;

	let sources: RepomixSource[];
	if (/\.sln$/i.test(target)) {
		const bundle = parseSolutionProjects(target);
		if (bundle === undefined) {
			return;
		}
		const resultByPath = new Map(
			bundle.projectResults.map((result) => [
				result.projectPath.toLowerCase(),
				result,
			]),
		);
		sources = [];
		for (const project of bundle.slnResult.projects) {
			const result = resultByPath.get(project.absolutePath.toLowerCase());
			if (result !== undefined) {
				sources.push({ label: project.name, parseResult: result });
			}
		}
	} else {
		const xml = tryReadFile(target);
		if (xml === undefined) {
			return;
		}
		sources = [
			{
				label: path.basename(target).replace(/\.vbproj$/i, ""),
				parseResult: parseVbproj(xml, target, FS_DEPS),
			},
		];
	}
	if (sources.length === 0) {
		void vscode.window.showWarningMessage("出力対象のプロジェクトがありません。");
		return;
	}

	const output = buildRepomixOutput(
		path.basename(target),
		sources,
		{ readTextFile: readSourceTextFile },
		{ includeSensitive },
	);

	const saveUri = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(
			path.join(path.dirname(target), "repomix-output.xml"),
		),
		filters: { "Repomix 出力": ["xml", "txt"] },
	});
	if (saveUri === undefined) {
		return;
	}
	try {
		fs.writeFileSync(saveUri.fsPath, output.content, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`出力ファイルを書き込めません: ${message}`);
		return;
	}
	const document = await vscode.workspace.openTextDocument(saveUri);
	await vscode.window.showTextDocument(document, { preview: true });
	void vscode.window.showInformationMessage(
		`Repomix 形式で出力しました: ${output.fileCount} ファイル / 約 ${Math.max(
			1,
			Math.round(output.totalChars / 1000),
		)}K 文字(スキップ ${output.skipped.length} 件)`,
	);
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

/** .sln と配下の全 .vbproj を解析する(ツリー表示とエクスポートで共用) */
interface SolutionParseBundle {
	slnResult: SlnParseResult;
	projectResults: VbprojParseResult[];
	readDiagnostics: ParseDiagnostic[];
}

function parseSolutionProjects(solutionPath: string): SolutionParseBundle | undefined {
	const content = tryReadFile(solutionPath);
	if (content === undefined) {
		return undefined;
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
	return { slnResult, projectResults, readDiagnostics };
}

/** .sln を解析し、含まれる全 .vbproj を読み込んでツリーを構築する */
function runParseSolution(
	solutionPath: string,
	channel: vscode.OutputChannel,
	provider: LegacyProjectTreeProvider,
	options: RunOptions = {},
): void {
	const bundle = parseSolutionProjects(solutionPath);
	if (bundle === undefined) {
		return;
	}
	const { slnResult, projectResults, readDiagnostics } = bundle;

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
