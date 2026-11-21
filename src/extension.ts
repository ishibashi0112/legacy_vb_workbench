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
import {
	type BuildOutputEncoding,
	BuildService,
} from "./services/buildService";
import {
	locateDevenv,
	locateMsbuild,
	type LocatorDeps,
} from "./services/msbuildLocator";
import { GitignoreEvaluator } from "./services/gitignoreService";
import {
	evaluateGitWorkspace,
	isSameOrInside,
	looksLikeNonUtf8,
} from "./services/gitWorkspaceService";
import {
	buildRepomixOutput,
	decodeSourceBuffer,
	type RepomixSource,
} from "./services/repomixExporter";
import { RunService } from "./services/runService";
import {
	isRunnableOutputType,
	findBuildOutputPath,
	resolveLaunchPlan,
	resolveRunSettings,
	resolveSolutionProjectConfiguration,
	type ProjectRunSettings,
} from "./services/runSettings";
import { launchVisualStudio } from "./services/visualStudioLauncher";
import { parseSln } from "./slnParser";
import type {
	FileNode,
	ParseDiagnostic,
	ProjectItemStatus,
	SlnParseResult,
	SolutionProject,
	VbprojParseResult,
} from "./types";
import { parseVbproj } from "./vbprojParser";

/** 直近に選択した .vbproj / .sln(手動更新・起動時復元で再利用) */
const LAST_SELECTION_KEY = "legacyVbWorkbench.lastSelection";

/**
 * .sln ごとのスタートアッププロジェクト(キーは小文字化した .sln パス)。
 * Visual Studio はこれをバイナリの .suo に保存しており読めないため、
 * 拡張側で一度選んでもらって記憶する。
 */
const STARTUP_PROJECTS_KEY = "legacyVbWorkbench.startupProjects";

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
	listFileNames: (absolutePath: string): string[] | undefined => {
		try {
			return fs
				.readdirSync(absolutePath, { withFileTypes: true })
				.filter((entry) => entry.isFile())
				.map((entry) => entry.name);
		} catch {
			return undefined;
		}
	},
};

export function activate(context: vscode.ExtensionContext): void {
	const channel = vscode.window.createOutputChannel("Legacy VB Workbench");
	const buildChannel = vscode.window.createOutputChannel("Legacy VB Build");
	const buildService = new BuildService(buildChannel);
	const runChannel = vscode.window.createOutputChannel("Legacy VB Run");
	const runService = new RunService(runChannel);
	context.subscriptions.push(buildChannel, runChannel);
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
			provider.setStartupProject(getStartupProject(context, selection.path));
		} else {
			runParseVbproj(selection.path, channel, provider, { quiet });
			provider.setStartupProject(undefined);
		}
		void vscode.commands.executeCommand("setContext", "legacyVbWorkbench.hasTarget", true);
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
			void checkGitIntegration(context, selection);
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
			void checkGitIntegration(context, selection);
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
			"legacyVbWorkbench.startWithoutDebugging",
			(node: unknown) => {
				void startWithoutDebugging(
					{ context, buildService, buildChannel, runService, runChannel, provider },
					node,
				);
			},
		),

		vscode.commands.registerCommand(
			"legacyVbWorkbench.setStartupProject",
			(node: unknown) => {
				void setStartupProjectCommand(context, provider, node);
			},
		),

		vscode.commands.registerCommand(
			"legacyVbWorkbench.openInVisualStudio",
			(node: unknown) => {
				void openInVisualStudio(resolveBuildTarget(node, context));
			},
		),

		vscode.commands.registerCommand("legacyVbWorkbench.exportRepomix", (node: unknown) => {
			void exportRepomix(context, node);
		}),

		vscode.commands.registerCommand(
			"legacyVbWorkbench.openGitRepositoryFolder",
			(node: unknown) => {
				const target = resolveBuildTarget(node, context);
				if (target === undefined) {
					void vscode.window.showWarningMessage(
						"先に「Legacy VB: Select Solution」または「Legacy VB: Select VB Project」で対象を選択してください。",
					);
					return;
				}
				const kind = target.toLowerCase().endsWith(".sln") ? "sln" : "vbproj";
				void checkGitIntegration(context, { kind, path: target }, { manual: true });
			},
		),

		vscode.commands.registerCommand("legacyVbWorkbench.openGitChanges", (node: unknown) => {
			if (!isFileNode(node)) {
				return;
			}
			void openGitChanges(node);
		}),
	);

	// フォルダーを開き直した直後は、開く前に選んでいた .sln / .vbproj を引き継ぐ
	adoptPendingSelection(context);

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

/** ビルドの結果。output は MSBuild の出力全文(EXE パスの取得に使う) */
interface BuildOutcome {
	status: "succeeded" | "failed" | "cancelled" | "not-started";
	output: string;
}

const NOT_STARTED: BuildOutcome = { status: "not-started", output: "" };

async function runBuild(
	buildService: BuildService,
	buildChannel: vscode.OutputChannel,
	targetPath: string | undefined,
	options: { notifySuccess?: boolean } = {},
): Promise<BuildOutcome> {
	if (process.platform !== "win32") {
		void vscode.window.showWarningMessage(
			"MSBuild ビルドは Windows 環境でのみ実行できます。",
		);
		return NOT_STARTED;
	}
	if (targetPath === undefined) {
		void vscode.window.showWarningMessage(
			"先に「Legacy VB: Select Solution」等でビルド対象を選択してください。",
		);
		return NOT_STARTED;
	}
	if (buildService.isRunning) {
		void vscode.window.showWarningMessage(
			"ビルドが実行中です。完了を待つか、通知からキャンセルしてください。",
		);
		return NOT_STARTED;
	}

	const located = await locateMsbuild(locatorDeps("msbuildPath"));
	const msbuildPath =
		located?.path ?? (await promptForExecutable("MSBuild.exe", "msbuildPath"));
	if (msbuildPath === undefined) {
		return NOT_STARTED;
	}

	const config = vscode.workspace.getConfiguration("legacyVbWorkbench");
	const configuration = config.get<string>("buildConfiguration") ?? "Debug";
	const encodingRaw = config.get<string>("msbuildOutputEncoding");
	const encoding: BuildOutputEncoding =
		encodingRaw === "cp932" || encodingRaw === "utf8" ? encodingRaw : "auto";

	buildChannel.show(true);
	const chunks: string[] = [];
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `MSBuild ビルド中: ${path.basename(targetPath)}(${configuration})`,
			cancellable: true,
		},
		async (_progress, token): Promise<BuildOutcome> => {
			token.onCancellationRequested(() => buildService.cancel());
			try {
				const exitCode = await buildService.run(
					msbuildPath,
					targetPath,
					configuration,
					encoding,
					(text) => chunks.push(text),
				);
				const output = chunks.join("");
				if (token.isCancellationRequested || exitCode === null) {
					void vscode.window.showWarningMessage("ビルドをキャンセルしました。");
					return { status: "cancelled", output };
				}
				if (exitCode === 0) {
					if (options.notifySuccess !== false) {
						void vscode.window.showInformationMessage(
							`ビルド成功(${configuration})`,
						);
					}
					return { status: "succeeded", output };
				}
				void vscode.window.showErrorMessage(
					`ビルド失敗(exit code: ${exitCode})。Output「Legacy VB Build」を確認してください。`,
				);
				return { status: "failed", output };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(
					`MSBuild を起動できませんでした: ${message}`,
				);
				return NOT_STARTED;
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
// デバッグなしで開始(Visual Studio の Ctrl+F5 相当)
// ---------------------------------------------------------------------------

interface RunCommandContext {
	context: vscode.ExtensionContext;
	buildService: BuildService;
	buildChannel: vscode.OutputChannel;
	runService: RunService;
	runChannel: vscode.OutputChannel;
	provider: LegacyProjectTreeProvider;
}

function readStartupMap(context: vscode.ExtensionContext): Record<string, string> {
	const raw = context.workspaceState.get<unknown>(STARTUP_PROJECTS_KEY);
	const result: Record<string, string> = {};
	if (typeof raw !== "object" || raw === null) {
		return result;
	}
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") {
			result[key] = value;
		}
	}
	return result;
}

function getStartupProject(
	context: vscode.ExtensionContext,
	solutionPath: string,
): string | undefined {
	return readStartupMap(context)[solutionPath.toLowerCase()];
}

async function saveStartupProject(
	context: vscode.ExtensionContext,
	solutionPath: string,
	projectPath: string,
): Promise<void> {
	const map = readStartupMap(context);
	map[solutionPath.toLowerCase()] = projectPath;
	await context.workspaceState.update(STARTUP_PROJECTS_KEY, map);
}

/** ツリーのプロジェクトノードから .vbproj パスを取り出す */
function projectPathFromNode(node: unknown): string | undefined {
	if (typeof node !== "object" || node === null) {
		return undefined;
	}
	const record = node as Record<string, unknown>;
	return record["type"] === "project" && typeof record["projectPath"] === "string"
		? record["projectPath"]
		: undefined;
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function currentConfiguration(): string {
	return (
		vscode.workspace.getConfiguration("legacyVbWorkbench").get<string>("buildConfiguration") ??
		"Debug"
	);
}

function readUserFile(projectPath: string): string | undefined {
	try {
		return fs.readFileSync(`${projectPath}.user`, "utf8");
	} catch {
		return undefined;
	}
}

/** .sln 内の実在するプロジェクトを読み、実行設定を付けて返す */
function loadSolutionProjects(
	solutionPath: string,
): Array<{ project: SolutionProject; settings: ProjectRunSettings }> | undefined {
	const content = tryReadFile(solutionPath);
	if (content === undefined) {
		return undefined;
	}
	const sln = parseSln(content, solutionPath, FS_DEPS);
	const configuration = currentConfiguration();
	const loaded: Array<{ project: SolutionProject; settings: ProjectRunSettings }> = [];
	for (const project of sln.projects) {
		if (!project.exists) {
			continue;
		}
		try {
			const projectXml = fs.readFileSync(project.absolutePath, "utf8");
			loaded.push({
				project,
				settings: resolveRunSettings({
					projectPath: project.absolutePath,
					projectXml,
					userXml: readUserFile(project.absolutePath),
					configuration,
				}),
			});
		} catch {
			// 読めないプロジェクトは候補から外す(ツリー側で警告済み)
		}
	}
	return loaded;
}

function canStart(settings: ProjectRunSettings): boolean {
	return (
		isRunnableOutputType(settings.outputType) ||
		settings.startAction.toLowerCase() === "program"
	);
}

/**
 * .sln のスタートアッププロジェクトを決める。
 * 記憶済みならそれ、起動可能なプロジェクトが 1 つならそれ、
 * 複数なら選んでもらって記憶する。
 */
async function pickStartupProject(
	context: vscode.ExtensionContext,
	solutionPath: string,
	forceAsk: boolean,
): Promise<string | undefined> {
	const loaded = loadSolutionProjects(solutionPath);
	if (loaded === undefined) {
		return undefined;
	}
	if (loaded.length === 0) {
		void vscode.window.showErrorMessage(
			"この .sln に起動できる VB プロジェクトが見つかりません。",
		);
		return undefined;
	}
	const remembered = getStartupProject(context, solutionPath);
	if (
		!forceAsk &&
		remembered !== undefined &&
		loaded.some(({ project }) => samePath(project.absolutePath, remembered))
	) {
		return remembered;
	}
	const runnable = loaded.filter(({ settings }) => canStart(settings));
	if (!forceAsk && runnable.length === 1) {
		return runnable[0].project.absolutePath;
	}
	const candidates = runnable.length > 0 ? runnable : loaded;
	const firstPath = loaded[0].project.absolutePath;
	const picked = await vscode.window.showQuickPick(
		candidates.map(({ project, settings }) => ({
			label: project.name,
			description: [
				settings.outputType ?? "",
				samePath(project.absolutePath, firstPath) ? "(.sln の先頭 = Visual Studio の既定)" : "",
				remembered !== undefined && samePath(project.absolutePath, remembered) ? "現在のスタートアップ" : "",
			]
				.filter((part) => part !== "")
				.join(" "),
			detail: project.absolutePath,
			projectPath: project.absolutePath,
		})),
		{
			title: "スタートアッププロジェクトを選択",
			placeHolder:
				"起動するプロジェクトを選んでください(この .sln について記憶します。後から「Set as Startup Project」で変更できます)",
		},
	);
	if (picked === undefined) {
		return undefined;
	}
	await saveStartupProject(context, solutionPath, picked.projectPath);
	return picked.projectPath;
}

async function setStartupProjectCommand(
	context: vscode.ExtensionContext,
	provider: LegacyProjectTreeProvider,
	node: unknown,
): Promise<void> {
	const last = context.workspaceState.get<unknown>(LAST_SELECTION_KEY);
	if (!isLastSelection(last) || last.kind !== "sln") {
		void vscode.window.showInformationMessage(
			"スタートアッププロジェクトは .sln を選択しているときに設定できます(.vbproj 単体ではそのプロジェクトを起動します)。",
		);
		return;
	}
	const fromNode = projectPathFromNode(node);
	const projectPath = fromNode ?? (await pickStartupProject(context, last.path, true));
	if (projectPath === undefined) {
		return;
	}
	if (fromNode !== undefined) {
		await saveStartupProject(context, last.path, fromNode);
	}
	provider.setStartupProject(projectPath);
	void vscode.window.showInformationMessage(
		`スタートアッププロジェクト: ${path.basename(projectPath)}`,
	);
}

/** ビルドして EXE を起動する(デバッガーは接続しない) */
async function startWithoutDebugging(ctx: RunCommandContext, node: unknown): Promise<void> {
	const { context, runService, runChannel } = ctx;
	if (process.platform !== "win32") {
		void vscode.window.showWarningMessage("アプリの起動は Windows 環境でのみ実行できます。");
		return;
	}
	const last = context.workspaceState.get<unknown>(LAST_SELECTION_KEY);
	const lastSelection = isLastSelection(last) ? last : undefined;

	// 1. ビルド対象とスタートアッププロジェクトを決める
	let buildTarget: string | undefined;
	let startupPath: string | undefined;
	const nodeProject = projectPathFromNode(node);
	if (nodeProject !== undefined) {
		// プロジェクトの右クリック → そのプロジェクトを起動(ビルドは選択中の .sln 単位)
		startupPath = nodeProject;
		buildTarget = lastSelection?.kind === "sln" ? lastSelection.path : nodeProject;
	} else {
		buildTarget = resolveBuildTarget(node, context);
		if (buildTarget === undefined) {
			void vscode.window.showWarningMessage(
				"先に「Legacy VB: Select Solution」等で対象を選択してください。",
			);
			return;
		}
		if (/\.sln$/i.test(buildTarget)) {
			startupPath = await pickStartupProject(context, buildTarget, false);
			if (startupPath !== undefined) {
				ctx.provider.setStartupProject(startupPath);
			}
		} else {
			startupPath = buildTarget;
		}
	}
	if (startupPath === undefined) {
		return;
	}

	// 2. 前回起動したアプリが動いていると EXE がロックされビルドが失敗する
	if (runService.runningCount > 0) {
		const choice = await vscode.window.showWarningMessage(
			"前回起動したアプリがまだ実行中です。",
			{
				modal: true,
				detail:
					"実行中の EXE はロックされるため、ビルドで上書きできません。終了してから再ビルド・起動しますか?",
			},
			"終了して起動",
		);
		if (choice !== "終了して起動") {
			return;
		}
		await runService.killAll();
	}

	// 3. 実行設定(.vbproj / .vbproj.user)を読む
	const configuration = currentConfiguration();
	const projectXml = tryReadFile(startupPath);
	if (projectXml === undefined) {
		return;
	}
	let projectConfiguration = configuration;
	let platform: string | undefined;
	let solutionDir: string | undefined;
	const mappingNotes: string[] = [];
	if (/\.sln$/i.test(buildTarget)) {
		const slnContent = tryReadFile(buildTarget);
		const slnProject =
			slnContent === undefined
				? undefined
				: parseSln(slnContent, buildTarget, FS_DEPS).projects.find((project) =>
						samePath(project.absolutePath, startupPath),
					);
		solutionDir = path.dirname(buildTarget);
		if (slnContent !== undefined && slnProject !== undefined) {
			const mapping = resolveSolutionProjectConfiguration(
				slnContent,
				slnProject.projectGuid,
				configuration,
			);
			if (mapping !== undefined) {
				projectConfiguration = mapping.configuration;
				platform = mapping.platform;
				mappingNotes.push(
					`構成: ソリューション ${configuration}|${mapping.solutionPlatform} → プロジェクト ${mapping.configuration}|${mapping.platform}`,
				);
				if (!mapping.builds) {
					mappingNotes.push(
						"このプロジェクトはソリューション構成でビルド対象外になっています(構成マネージャーの「ビルド」が未チェック)",
					);
				}
			}
		}
	}
	const settings = resolveRunSettings({
		projectPath: startupPath,
		projectXml,
		userXml: readUserFile(startupPath),
		configuration: projectConfiguration,
		platform,
		solutionDir,
	});

	// 構成・プラットフォームが合わず引数が使われなかった場合は、保存済みの引数から選んでもらう
	// (推測で別の構成の引数を使うことはしない)
	let argumentsOverride: string | undefined;
	const unmatchedArguments = settings.startArgumentCandidates.filter((candidate) => !candidate.used);
	if (settings.startArguments === undefined && unmatchedArguments.length > 0) {
		const picked = await vscode.window.showQuickPick(
			[
				...unmatchedArguments.map((candidate) => ({
					label: candidate.value,
					description: candidate.condition ?? "(条件なし)",
					detail: `${candidate.source} に保存されている引数`,
					value: candidate.value,
				})),
				{ label: "引数なしで起動", description: "", detail: undefined, value: "" },
			],
			{
				title: `今回の構成(${settings.configuration}|${settings.platform ?? "プラットフォーム不明"})向けのコマンドライン引数がありません`,
				placeHolder:
					".vbproj.user には別の構成・プラットフォーム向けの引数が保存されています。使う引数を選んでください",
				ignoreFocusOut: true,
			},
		);
		if (picked === undefined) {
			return;
		}
		argumentsOverride = picked.value;
	}

	// 4. ビルド(既定で有効。VS の F5 / Ctrl+F5 と同じく起動前にビルドする)
	const buildFirst =
		vscode.workspace.getConfiguration("legacyVbWorkbench").get<boolean>("runBuildBeforeStart") ??
		true;
	let buildOutput = "";
	if (buildFirst) {
		const outcome = await runBuild(ctx.buildService, ctx.buildChannel, buildTarget, {
			notifySuccess: false,
		});
		if (outcome.status !== "succeeded") {
			return; // 失敗・キャンセルの通知は runBuild 側で表示済み
		}
		buildOutput = outcome.output;
	}

	// 5. 起動計画を立てる
	const result = resolveLaunchPlan(
		settings,
		findBuildOutputPath(buildOutput, settings.projectName),
		{
			fileExists: (absolutePath) => fs.existsSync(absolutePath),
			directoryExists: (absolutePath) => {
				try {
					return fs.statSync(absolutePath).isDirectory();
				} catch {
					return false;
				}
			},
		},
	);
	runChannel.show(true);
	if (!result.ok) {
		runChannel.appendLine("========================================");
		runChannel.appendLine(`[${new Date().toLocaleString()}] 起動できません: ${startupPath}`);
		runChannel.appendLine(`  ${result.reason}`);
		printRunDiagnostics(settings, mappingNotes, runChannel);
		void vscode.window.showErrorMessage(`起動できません: ${result.reason}`);
		return;
	}
	const plan = result.plan;
	if (argumentsOverride !== undefined) {
		plan.argumentsLine = argumentsOverride;
		plan.notes.push(
			argumentsOverride === ""
				? "引数: 構成に合う引数がないため、選択により引数なしで起動します"
				: "引数: 構成に合う引数がないため、選択された別構成の引数を使います",
		);
	}
	plan.notes.unshift(
		...mappingNotes,
		settings.userFileFound
			? `起動設定: ${path.basename(startupPath)}.user を読み込みました`
			: `起動設定: ${path.basename(startupPath)}.user がないため、引数なしで起動します`,
	);

	// 6. 起動して終了を見守る
	const launched = runService.launch(plan);
	printRunDiagnostics(settings, [], runChannel);
	const exeName = path.basename(plan.exePath);
	void vscode.window.showInformationMessage(`起動しました: ${exeName}`);
	try {
		const exit = await launched.exited;
		if (exit.description?.abnormal === true) {
			const choice = await vscode.window.showWarningMessage(
				`${exeName} が異常終了しました(${exit.description.hex}` +
					`${exit.description.meaning === undefined ? "" : `: ${exit.description.meaning}`})。`,
				"Output を表示",
			);
			if (choice === "Output を表示") {
				runChannel.show();
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`${exeName} を起動できませんでした: ${message}`);
	}
}

function printRunDiagnostics(
	settings: ProjectRunSettings,
	notes: readonly string[],
	runChannel: vscode.OutputChannel,
): void {
	for (const note of notes) {
		runChannel.appendLine(`  ※ ${note}`);
	}
	runChannel.appendLine(
		`  設定の検索条件: ${settings.configuration}|${settings.platform ?? "(プラットフォーム不明)"}`,
	);
	if (settings.startArgumentCandidates.length === 0) {
		runChannel.appendLine("  StartArguments: .vbproj / .vbproj.user のどちらにもありません");
	}
	for (const candidate of settings.startArgumentCandidates) {
		runChannel.appendLine(
			`  StartArguments [${candidate.used ? "採用" : "不一致"}] ${candidate.source}` +
				` / ${candidate.condition ?? "条件なし"}: ${candidate.value}`,
		);
	}
	for (const diagnostic of settings.diagnostics) {
		runChannel.appendLine(`  [${diagnostic.severity}] ${diagnostic.message}`);
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
	const exportConfig = vscode.workspace.getConfiguration("legacyVbWorkbench");
	const includeSensitive =
		exportConfig.get<boolean>("exportIncludeDesignerFiles") ?? false;
	const maskCredentials = exportConfig.get<boolean>("exportMaskCredentials") ?? true;
	const strictMask = exportConfig.get<boolean>("exportStrictMask") ?? true;
	const respectGitignore =
		exportConfig.get<boolean>("exportRespectGitignore") ?? true;
	const uiSummary = exportConfig.get<boolean>("exportUiSummary") ?? true;

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

	// .gitignore / .repomixignore の尊重(本家 repomix と同じ既定挙動)
	const gitignore = new GitignoreEvaluator(
		{
			readTextFileIfExists: (absolutePath) => {
				try {
					return fs.readFileSync(absolutePath, "utf8");
				} catch {
					return undefined;
				}
			},
			directoryExists: (absolutePath) => {
				try {
					return fs.statSync(absolutePath).isDirectory();
				} catch {
					return false;
				}
			},
		},
		path.dirname(target),
	);

	const output = buildRepomixOutput(
		path.basename(target),
		sources,
		{
			readTextFile: readSourceTextFile,
			ignoreReasonFor: respectGitignore
				? (absolutePath) => gitignore.ignoreReasonFor(absolutePath)
				: undefined,
		},
		{ includeSensitive, maskCredentials, strictMask, uiSummary },
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
		// BOM 付き UTF-8 で保存(Windows 系ツールのエンコーディング誤判定を防ぐ)
		fs.writeFileSync(saveUri.fsPath, "\uFEFF" + output.content, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`出力ファイルを書き込めません: ${message}`);
		return;
	}
	const document = await vscode.workspace.openTextDocument(saveUri);
	await vscode.window.showTextDocument(document, { preview: true });
	const maskNote = maskCredentials
		? ` / 認証情報マスク ${output.maskedCount} 件`
		: "(マスク無効)";
	const uiSummaryNote =
		output.uiSummaryCount > 0 ? ` / UI サマリー ${output.uiSummaryCount} 件` : "";
	void vscode.window.showInformationMessage(
		`Repomix 形式で出力しました: ${output.fileCount} ファイル / 約 ${Math.max(
			1,
			Math.round(output.totalChars / 1000),
		)}K 文字(スキップ ${output.skipped.length} 件${maskNote}${uiSummaryNote})`,
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

// ---------------------------------------------------------------------------
// VS Code 標準のソース管理(Git)との連携
// ---------------------------------------------------------------------------

/**
 * フォルダーを開き直す前に選んでいた対象(キーは小文字化したフォルダーパス)。
 * workspaceState はフォルダーごとに別物なので、開き直すと前回の選択が消える。
 * globalState に一時保存し、新しいウィンドウ側の activate で引き取る。
 */
const PENDING_SELECTIONS_KEY = "legacyVbWorkbench.pendingSelections";
/** 「今後表示しない」を選んだリポジトリ(小文字化したルートパス) */
const GIT_PROMPT_DISMISSED_KEY = "legacyVbWorkbench.gitPromptDismissed";
/** 文字コード案内を「今後表示しない」にしたか */
const ENCODING_PROMPT_DISMISSED_KEY = "legacyVbWorkbench.encodingPromptDismissed";

function readStringRecord(
	context: vscode.ExtensionContext,
	key: string,
): Record<string, unknown> {
	const raw = context.globalState.get<unknown>(key);
	return typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? { ...(raw as Record<string, unknown>) }
		: {};
}

async function savePendingSelection(
	context: vscode.ExtensionContext,
	folder: string,
	selection: LastSelection,
): Promise<void> {
	const map = readStringRecord(context, PENDING_SELECTIONS_KEY);
	map[folder.toLowerCase()] = selection;
	await context.globalState.update(PENDING_SELECTIONS_KEY, map);
}

function adoptPendingSelection(context: vscode.ExtensionContext): void {
	const folders = workspaceFolderPaths();
	if (folders.length === 0) {
		return;
	}
	const map = readStringRecord(context, PENDING_SELECTIONS_KEY);
	let changed = false;
	for (const folder of folders) {
		const key = folder.toLowerCase();
		const pending = map[key];
		if (pending === undefined) {
			continue;
		}
		delete map[key];
		changed = true;
		if (isLastSelection(pending)) {
			void context.workspaceState.update(LAST_SELECTION_KEY, pending);
		}
	}
	if (changed) {
		void context.globalState.update(PENDING_SELECTIONS_KEY, map);
	}
}

function workspaceFolderPaths(): string[] {
	return (vscode.workspace.workspaceFolders ?? [])
		.filter((folder) => folder.uri.scheme === "file")
		.map((folder) => folder.uri.fsPath);
}

/**
 * .sln / .vbproj を選んだときに、VS Code のソース管理で差分が見られる状態かを確認する。
 * 1. git.exe があるか(VS2013 は git.exe なしで Git を扱えるが、VS Code は必須)
 * 2. リポジトリのフォルダーがワークスペースとして開かれているか
 * 3. Shift_JIS のソースが文字化けしない設定か
 */
async function checkGitIntegration(
	context: vscode.ExtensionContext,
	selection: LastSelection,
	options: { manual?: boolean } = {},
): Promise<void> {
	const manual = options.manual === true;
	const status = evaluateGitWorkspace(selection.path, workspaceFolderPaths(), {
		pathExists: (p) => fs.existsSync(p),
	});

	if (status.kind === "no-repository") {
		if (manual) {
			void vscode.window.showInformationMessage(
				`${path.basename(selection.path)} の上位フォルダーに .git が見つかりません(Git 管理外のため、ソース管理ビューには表示されません)。`,
			);
		}
		await suggestEncodingSettings(context, selection, manual);
		return;
	}

	if (!(await ensureGitAvailable())) {
		return;
	}

	const root = status.repositoryRoot;
	const dismissed = readStringRecord(context, GIT_PROMPT_DISMISSED_KEY);
	if (status.kind === "covered") {
		if (manual) {
			void vscode.window.showInformationMessage(
				`リポジトリ ${root} はワークスペースとして開かれています。サイドバーの「ソース管理」で差分を確認できます。`,
			);
			void vscode.commands.executeCommand("workbench.view.scm");
		}
	} else if (manual || dismissed[root.toLowerCase()] !== true) {
		const openLabel = "リポジトリのフォルダーを開く";
		const addLabel = "ワークスペースに追加";
		const dismissLabel = "今後表示しない";
		const message =
			status.kind === "parent-of-workspace"
				? `${path.basename(selection.path)} の Git リポジトリは上位の ${root} です。` +
					"今のフォルダーのままだと VS Code は親フォルダーのリポジトリを自動では開きません。" +
					"ソース管理で差分を見るには、リポジトリのフォルダーを開いてください。"
				: `${path.basename(selection.path)} は Git リポジトリ ${root} 内にありますが、` +
					"VS Code でこのフォルダーが開かれていないため、ソース管理(差分表示)に出てきません。";
		const buttons =
			status.kind === "parent-of-workspace"
				? [openLabel, dismissLabel]
				: [openLabel, addLabel, dismissLabel];
		const choice = await vscode.window.showInformationMessage(message, ...buttons);
		if (choice === openLabel) {
			await savePendingSelection(context, root, selection);
			await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), {
				forceNewWindow: false,
			});
			return;
		}
		if (choice === addLabel) {
			// フォルダー 0 → 1 個の追加では拡張ホストが再起動することがあるため、選択も引き継ぐ
			await savePendingSelection(context, root, selection);
			const count = vscode.workspace.workspaceFolders?.length ?? 0;
			vscode.workspace.updateWorkspaceFolders(count, 0, { uri: vscode.Uri.file(root) });
		} else if (choice === dismissLabel) {
			dismissed[root.toLowerCase()] = true;
			await context.globalState.update(GIT_PROMPT_DISMISSED_KEY, dismissed);
		}
	}

	await suggestEncodingSettings(context, selection, manual);
}

/** git.path 設定(または PATH 上の git)で git.exe を実行できるか */
function gitCandidates(): string[] {
	const configured = vscode.workspace.getConfiguration("git").get<unknown>("path");
	const list = Array.isArray(configured) ? configured : [configured];
	const paths = list.filter(
		(value): value is string => typeof value === "string" && value.trim() !== "",
	);
	return paths.length > 0 ? paths : ["git"];
}

function canRunGit(gitPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile(gitPath, ["--version"], { windowsHide: true, timeout: 10_000 }, (error) => {
			resolve(error === null);
		});
	});
}

async function ensureGitAvailable(): Promise<boolean> {
	if (vscode.workspace.getConfiguration("git").get<boolean>("enabled") === false) {
		void vscode.window.showWarningMessage(
			"VS Code の設定 git.enabled が false のため、ソース管理(差分表示)が無効になっています。",
		);
		return false;
	}
	for (const candidate of gitCandidates()) {
		if (await canRunGit(candidate)) {
			return true;
		}
	}
	const downloadLabel = "Git for Windows のダウンロードページを開く";
	const choice = await vscode.window.showWarningMessage(
		"git.exe が見つかりません。Visual Studio 2013 は git.exe なしで Git を扱えますが、" +
			"VS Code のソース管理(差分表示)には Git for Windows のインストールが必要です。" +
			"インストール済みなら設定 git.path に git.exe のフルパスを指定してください。",
		downloadLabel,
	);
	if (choice === downloadLabel) {
		void vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/download/win"));
	}
	return false;
}

/** 文字コード判定のために調べるソースの上限(大きなソリューションでも一瞬で終わる量) */
const ENCODING_SAMPLE_LIMIT = 30;

function collectSourcePaths(selection: LastSelection): string[] {
	const results: VbprojParseResult[] = [];
	if (selection.kind === "sln") {
		const bundle = parseSolutionProjects(selection.path);
		if (bundle !== undefined) {
			results.push(...bundle.projectResults);
		}
	} else {
		const xml = tryReadFile(selection.path);
		if (xml !== undefined) {
			results.push(parseVbproj(xml, selection.path, FS_DEPS));
		}
	}
	return results
		.flatMap((result) => result.items)
		.filter((item) => item.kind === "Compile" && item.exists && item.sourcePath !== undefined)
		.map((item) => item.sourcePath as string);
}

/**
 * Shift_JIS のソースがあり、VS Code が UTF-8 固定で開く設定なら自動判定を勧める。
 * 差分ビューも同じ設定で読むため、これをしないと差分が文字化けする。
 * .vscode/settings.json を作るとリポジトリに未追跡ファイルが増えるので、ユーザー設定に書く。
 */
async function suggestEncodingSettings(
	context: vscode.ExtensionContext,
	selection: LastSelection,
	manual: boolean,
): Promise<void> {
	if (!manual && context.globalState.get<boolean>(ENCODING_PROMPT_DISMISSED_KEY) === true) {
		return;
	}
	const files = vscode.workspace.getConfiguration("files");
	if (files.get<boolean>("autoGuessEncoding") === true) {
		return;
	}
	const encoding = files.get<string>("encoding") ?? "utf8";
	if (encoding !== "utf8" && encoding !== "utf8bom") {
		return; // shiftjis などを明示設定済み
	}
	const sample = collectSourcePaths(selection).slice(0, ENCODING_SAMPLE_LIMIT);
	const nonUtf8 = sample.filter((filePath) => {
		try {
			return looksLikeNonUtf8(fs.readFileSync(filePath));
		} catch {
			return false;
		}
	});
	if (nonUtf8.length === 0) {
		return;
	}
	const enableLabel = "文字コードの自動判定を有効にする";
	const dismissLabel = "今後表示しない";
	const choice = await vscode.window.showWarningMessage(
		`Shift_JIS と思われるソースがあります(例: ${path.basename(nonUtf8[0] ?? "")})。` +
			"VS Code の既定(UTF-8)のままだと、編集画面とソース管理の差分表示が文字化けします。" +
			"ユーザー設定の files.autoGuessEncoding を有効にしますか?",
		enableLabel,
		dismissLabel,
	);
	if (choice === enableLabel) {
		await files.update("autoGuessEncoding", true, vscode.ConfigurationTarget.Global);
		void vscode.window.showInformationMessage(
			"files.autoGuessEncoding を有効にしました。開いている .vb は一度閉じて開き直してください。",
		);
	} else if (choice === dismissLabel) {
		await context.globalState.update(ENCODING_PROMPT_DISMISSED_KEY, true);
	}
}

/** VS Code 組み込み Git 拡張の API のうち、ここで使う部分だけの型 */
interface GitApiLike {
	getRepository: (uri: vscode.Uri) => unknown;
}

function isGitApiLike(value: unknown): value is GitApiLike {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>)["getRepository"] === "function"
	);
}

async function getGitApi(): Promise<GitApiLike | undefined> {
	const extension = vscode.extensions.getExtension<unknown>("vscode.git");
	if (extension === undefined) {
		return undefined;
	}
	try {
		const exports: unknown = extension.isActive ? extension.exports : await extension.activate();
		if (typeof exports !== "object" || exports === null) {
			return undefined;
		}
		const getAPI = (exports as Record<string, unknown>)["getAPI"];
		if (typeof getAPI !== "function") {
			return undefined;
		}
		const api: unknown = getAPI.call(exports, 1);
		return isGitApiLike(api) ? api : undefined;
	} catch {
		return undefined; // git.exe が無い・git.enabled=false など
	}
}

/** ツリーのファイルについて、VS Code 標準の差分ビュー(HEAD との比較)を開く */
async function openGitChanges(node: FileNode): Promise<void> {
	const sourcePath = node.item.sourcePath;
	if (sourcePath === undefined || !node.item.exists) {
		void vscode.window.showWarningMessage(
			`物理ファイルが無いため差分を表示できません: ${node.item.include}`,
		);
		return;
	}
	const uri = vscode.Uri.file(sourcePath);
	const api = await getGitApi();
	if (api === undefined) {
		if (await ensureGitAvailable()) {
			void vscode.window.showWarningMessage(
				"VS Code の Git 拡張を利用できません(組み込み拡張「Git」が無効になっていないか確認してください)。",
			);
		}
		return;
	}
	if (api.getRepository(uri) === null) {
		const inWorkspace = workspaceFolderPaths().some((folder) =>
			isSameOrInside(sourcePath, folder),
		);
		void vscode.window.showWarningMessage(
			inWorkspace
				? `${path.basename(sourcePath)} は Git リポジトリとして認識されていません(Git 管理外か、リポジトリの検出待ちです)。`
				: `${path.basename(sourcePath)} のリポジトリが VS Code で開かれていません。` +
					"ソリューションを右クリック →「Legacy VB: Open Git Repository Folder」でリポジトリのフォルダーを開いてください。",
		);
		return;
	}
	try {
		await vscode.commands.executeCommand("git.openChange", uri);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(`差分を開けませんでした: ${sourcePath}(${message})`);
	}
}
