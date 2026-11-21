/**
 * 「デバッグなしで開始」(Visual Studio の Ctrl+F5 相当)のための設定解決。
 *
 * Visual Studio 2013 はプロジェクトのデバッグタブの設定
 * (コマンドライン引数・作業ディレクトリ・外部プログラムの開始)を
 * `<プロジェクト>.vbproj.user` の構成別 PropertyGroup に保存する。
 * ここではそれと .vbproj 本体の PropertyGroup を静的に読み、
 * 起動する EXE・引数・作業ディレクトリを決める。
 *
 * MSBuild の完全な評価ではない。PropertyGroup の Condition は
 * `'$(Configuration)|$(Platform)' == 'Debug|AnyCPU'` のような
 * 単純な文字列比較だけを評価し、それ以外(Exists() や and/or 等)は
 * 評価せず診断に残す。EXE の場所はビルド出力の `プロジェクト名 -> パス`
 * 行(MSBuild が評価した結果)を優先し、静的計算は予備に使う。
 *
 * vscode モジュールに依存しない純粋関数(単体テスト対象)。
 */

import * as path from "path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { resolveWindowsPath } from "../paths";
import type { ParseDiagnostic } from "../types";

// ---------------------------------------------------------------------------
// XML ユーティリティ(vbprojParser と同じ方針)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function toArray(value: unknown): unknown[] {
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) ? value : [value];
}

/** PropertyGroup 内の 1 プロパティ(文書順) */
interface RawProperty {
	name: string;
	value: string;
	groupCondition?: string;
	propertyCondition?: string;
	source: string;
}

/** XML から PropertyGroup のプロパティを文書順に取り出す */
function readProperties(
	xmlContent: string,
	sourceLabel: string,
	diagnostics: ParseDiagnostic[],
): RawProperty[] | undefined {
	const xml = xmlContent.replace(/^\uFEFF/, "");
	const validation = XMLValidator.validate(xml);
	if (validation !== true) {
		diagnostics.push({
			severity: "error",
			message: `${sourceLabel} を XML として解析できません: ${validation.err.msg}(${validation.err.line}行目)`,
		});
		return undefined;
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
			message: `${sourceLabel} の XML 解析に失敗しました: ${message}`,
		});
		return undefined;
	}
	const project = isRecord(parsed) ? parsed["Project"] : undefined;
	if (!isRecord(project)) {
		diagnostics.push({
			severity: "error",
			message: `${sourceLabel} に <Project> 要素が見つかりません`,
		});
		return undefined;
	}

	const properties: RawProperty[] = [];
	for (const group of toArray(project["PropertyGroup"])) {
		if (!isRecord(group)) {
			continue; // <PropertyGroup/> は空文字列になる
		}
		const groupCondition = asString(group["@_Condition"]);
		for (const [name, rawValue] of Object.entries(group)) {
			if (name.startsWith("@_") || name === "#text") {
				continue;
			}
			for (const entry of toArray(rawValue)) {
				if (typeof entry === "string") {
					properties.push({ name, value: entry, groupCondition, source: sourceLabel });
					continue;
				}
				if (isRecord(entry)) {
					// <Platform Condition="...">x86</Platform> のような属性付き、または空要素
					properties.push({
						name,
						value: asString(entry["#text"]) ?? "",
						groupCondition,
						propertyCondition: asString(entry["@_Condition"]),
						source: sourceLabel,
					});
				}
			}
		}
	}
	return properties;
}

// ---------------------------------------------------------------------------
// プロパティ評価(単純な Condition のみ)
// ---------------------------------------------------------------------------

/** プロパティ名は大文字小文字を区別しない(MSBuild の仕様) */
type PropertyState = Map<string, string>;

const PROPERTY_REFERENCE = /\$\(([A-Za-z_][A-Za-z0-9_.-]*)\)/g;

/** $(Name) を展開する。未知の参照があれば unresolved に名前を入れる */
function expandProperties(
	value: string,
	state: PropertyState,
	unresolved: Set<string>,
): string {
	return value.replace(PROPERTY_REFERENCE, (whole, name: string) => {
		const known = state.get(name.toLowerCase());
		if (known === undefined) {
			unresolved.add(name);
			return whole;
		}
		return known;
	});
}

/** `'左辺' == '右辺'` / `!=` の 1 比較だけを受け付ける */
const SIMPLE_COMPARISON = /^\s*'([^']*)'\s*(==|!=)\s*'([^']*)'\s*$/;

/**
 * Condition を評価する。
 * true / false、または評価できない場合 undefined を返す。
 * 未定義プロパティは MSBuild と同じく空文字として扱う。
 */
export function evaluateSimpleCondition(
	condition: string,
	state: ReadonlyMap<string, string>,
): boolean | undefined {
	const match = SIMPLE_COMPARISON.exec(condition);
	if (match === null) {
		return undefined;
	}
	const [, left, operator, right] = match;
	// $([System...]) のようなプロパティ関数・@()・%() は対象外
	if (/\$\(\[|[@%]\(/.test(left + right)) {
		return undefined;
	}
	const expand = (text: string): string =>
		text.replace(PROPERTY_REFERENCE, (_whole, name: string) => state.get(name.toLowerCase()) ?? "");
	if (/\$\(/.test(expand(left) + expand(right))) {
		return undefined;
	}
	// MSBuild の文字列比較は大文字小文字を区別しない
	const equal = expand(left).toLowerCase() === expand(right).toLowerCase();
	return operator === "==" ? equal : !equal;
}

/** 実行に関係するプロパティ(ここに無いものは評価結果に含めない) */
export interface ProjectRunSettings {
	projectPath: string;
	projectDir: string;
	/** MSBuildProjectName(.vbproj のファイル名から拡張子を除いたもの) */
	projectName: string;
	configuration: string;
	platform?: string;
	assemblyName?: string;
	outputType?: string;
	/** プロジェクトディレクトリ基準で解決した OutputPath。未解決式を含むと undefined */
	outputDir?: string;
	/** 既定は Project(ビルドした EXE を起動) */
	startAction: string;
	startProgram?: string;
	/** Visual Studio と同じく、コマンドライン文字列をそのまま渡す */
	startArguments?: string;
	startWorkingDirectory?: string;
	/** .vbproj.user を読めたか */
	userFileFound: boolean;
	diagnostics: ParseDiagnostic[];
}

export interface RunSettingsInput {
	projectPath: string;
	projectXml: string;
	/** `<プロジェクト>.vbproj.user` の内容(無ければ undefined) */
	userXml?: string;
	/** ビルドに使う構成(.sln 経由ならプロジェクト側へ対応付け済みの値) */
	configuration: string;
	/**
	 * グローバルプロパティとして与えるプラットフォーム。
	 * .sln 経由のビルドでは .sln の対応表から決まる。
	 * .vbproj 単体ビルドでは undefined(プロジェクトの既定値を使う)。
	 */
	platform?: string;
	/** .sln 経由のときの .sln ディレクトリ($(SolutionDir) の展開用) */
	solutionDir?: string;
}

const RUN_PROPERTY_NAMES = [
	"AssemblyName",
	"OutputType",
	"OutputPath",
	"StartAction",
	"StartProgram",
	"StartArguments",
	"StartWorkingDirectory",
] as const;

function withTrailingBackslash(dir: string): string {
	return dir.endsWith("\\") || dir.endsWith("/") ? dir : `${dir}\\`;
}

/** .vbproj と .vbproj.user から実行設定を求める */
export function resolveRunSettings(input: RunSettingsInput): ProjectRunSettings {
	const diagnostics: ParseDiagnostic[] = [];
	const projectDir = path.dirname(input.projectPath);
	const fileName = path.basename(input.projectPath);
	const projectName = fileName.replace(/\.[^.]+$/, "");

	// グローバルプロパティ(プロジェクト内の定義では上書きされない)
	const globals = new Set<string>(["configuration"]);
	const state: PropertyState = new Map();
	state.set("configuration", input.configuration);
	if (input.platform !== undefined) {
		state.set("platform", input.platform);
		globals.add("platform");
	}
	if (input.solutionDir !== undefined) {
		state.set("solutiondir", withTrailingBackslash(input.solutionDir));
		globals.add("solutiondir");
	}
	// MSBuild の予約プロパティ(常に利用可能)
	state.set("msbuildprojectname", projectName);
	state.set("msbuildprojectfile", fileName);
	state.set("msbuildprojectdirectory", projectDir);
	state.set("msbuildthisfiledirectory", withTrailingBackslash(projectDir));

	const sources: Array<{ label: string; xml: string }> = [
		{ label: fileName, xml: input.projectXml },
	];
	if (input.userXml !== undefined) {
		// .vbproj.user は Microsoft.Common.targets から最後に読み込まれるため後勝ち
		sources.push({ label: `${fileName}.user`, xml: input.userXml });
	}

	const reportedConditions = new Set<string>();
	for (const source of sources) {
		const properties = readProperties(source.xml, source.label, diagnostics);
		if (properties === undefined) {
			continue;
		}
		for (const property of properties) {
			const key = property.name.toLowerCase();
			if (globals.has(key)) {
				continue;
			}
			let skip = false;
			for (const condition of [property.groupCondition, property.propertyCondition]) {
				if (condition === undefined || skip) {
					continue;
				}
				const result = evaluateSimpleCondition(condition, state);
				if (result === false) {
					skip = true;
				} else if (result === undefined) {
					skip = true;
					if (!reportedConditions.has(condition)) {
						reportedConditions.add(condition);
						diagnostics.push({
							severity: "warning",
							message: `${source.label}: 評価できない Condition のため、この PropertyGroup/プロパティは無視しました: ${condition}`,
						});
					}
				}
			}
			if (skip) {
				continue;
			}
			const unresolved = new Set<string>();
			const value = expandProperties(property.value, state, unresolved);
			if (unresolved.size > 0 && isRunProperty(property.name)) {
				diagnostics.push({
					severity: "warning",
					message: `${source.label}: ${property.name} に未解決のプロパティ参照があります: ${[...unresolved].map((n) => `$(${n})`).join(", ")}`,
				});
			}
			state.set(key, value);
		}
	}

	const read = (name: string): string | undefined => {
		const value = state.get(name.toLowerCase());
		return value === undefined || value.trim() === "" ? undefined : value.trim();
	};

	const rawOutputPath = read("OutputPath");
	let outputDir: string | undefined;
	if (rawOutputPath !== undefined && !/\$\(/.test(rawOutputPath)) {
		outputDir = resolveWindowsPath(rawOutputPath, projectDir);
	}

	return {
		projectPath: input.projectPath,
		projectDir,
		projectName,
		configuration: input.configuration,
		platform: read("Platform"),
		// Microsoft.Common.targets の既定: AssemblyName 未指定なら MSBuildProjectName
		assemblyName: read("AssemblyName") ?? projectName,
		outputType: read("OutputType"),
		outputDir,
		startAction: read("StartAction") ?? "Project",
		startProgram: read("StartProgram"),
		// 引数は前後の空白も意味を持ち得るため trim しない
		startArguments: nonEmpty(state.get("startarguments")),
		startWorkingDirectory: read("StartWorkingDirectory"),
		userFileFound: input.userXml !== undefined,
		diagnostics,
	};
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === "" ? undefined : value;
}

function isRunProperty(name: string): boolean {
	return RUN_PROPERTY_NAMES.some((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

/** 実行ファイルとして起動できる OutputType か(未指定は Exe とみなす) */
export function isRunnableOutputType(outputType: string | undefined): boolean {
	if (outputType === undefined) {
		return true;
	}
	return ["exe", "winexe"].includes(outputType.toLowerCase());
}

// ---------------------------------------------------------------------------
// .sln の構成対応表(ProjectConfigurationPlatforms)
// ---------------------------------------------------------------------------

export interface ProjectConfigurationMapping {
	/** プロジェクト側の構成(例: Debug) */
	configuration: string;
	/** プロジェクト側のプラットフォーム(例: AnyCPU / x86) */
	platform: string;
	/** ソリューション側で使ったプラットフォーム(例: Any CPU) */
	solutionPlatform: string;
	/** この構成でビルド対象になっているか(Build.0 行の有無) */
	builds: boolean;
}

/**
 * MSBuild が .sln をプラットフォーム指定なしでビルドしたときの既定の
 * ソリューションプラットフォームを選ぶ(MSBuild の SolutionFile と同じ規則:
 * "Mixed Platforms" → "Any CPU" → 先頭)。
 */
function pickDefaultSolutionPlatform(platforms: readonly string[]): string | undefined {
	const find = (name: string): string | undefined =>
		platforms.find((p) => p.toLowerCase() === name.toLowerCase());
	return find("Mixed Platforms") ?? find("Any CPU") ?? platforms[0];
}

/**
 * .sln の対応表から、指定したソリューション構成でのプロジェクト側の構成と
 * プラットフォームを求める。見つからなければ undefined。
 */
export function resolveSolutionProjectConfiguration(
	slnContent: string,
	projectGuid: string,
	solutionConfiguration: string,
): ProjectConfigurationMapping | undefined {
	const lines = slnContent.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());

	// GlobalSection(SolutionConfigurationPlatforms) の "Debug|Any CPU = Debug|Any CPU"
	const solutionPlatforms: string[] = [];
	let inSolutionSection = false;
	for (const line of lines) {
		if (/^GlobalSection\(SolutionConfigurationPlatforms\)/i.test(line)) {
			inSolutionSection = true;
			continue;
		}
		if (inSolutionSection && /^EndGlobalSection/i.test(line)) {
			inSolutionSection = false;
			continue;
		}
		if (!inSolutionSection) {
			continue;
		}
		const match = /^([^|=]+)\|([^=]+?)\s*=/.exec(line);
		if (match !== null && match[1].trim().toLowerCase() === solutionConfiguration.toLowerCase()) {
			solutionPlatforms.push(match[2].trim());
		}
	}
	const solutionPlatform = pickDefaultSolutionPlatform(solutionPlatforms);
	if (solutionPlatform === undefined) {
		return undefined;
	}

	const guid = projectGuid.replace(/[{}]/g, "").toLowerCase();
	const prefix = `{${guid}}.${solutionConfiguration}|${solutionPlatform}.`.toLowerCase();
	let mapping: ProjectConfigurationMapping | undefined;
	let builds = false;
	for (const line of lines) {
		const lower = line.toLowerCase();
		if (!lower.startsWith(prefix)) {
			continue;
		}
		const rest = line.slice(prefix.length);
		const active = /^ActiveCfg\s*=\s*([^|]+)\|(.+)$/i.exec(rest);
		if (active !== null) {
			mapping = {
				configuration: active[1].trim(),
				// .sln では "Any CPU"、プロジェクト側では "AnyCPU" と書く
				platform: active[2].trim().replace(/^Any CPU$/i, "AnyCPU"),
				solutionPlatform,
				builds: false,
			};
		} else if (/^Build\.0\s*=/i.test(rest)) {
			builds = true;
		}
	}
	return mapping === undefined ? undefined : { ...mapping, builds };
}

// ---------------------------------------------------------------------------
// ビルド出力からの EXE パス取得
// ---------------------------------------------------------------------------

/** `  Basic -> C:\work\Basic\bin\Debug\Basic.exe`(/m 時の `1>` 接頭辞も許容) */
const BUILD_OUTPUT_LINE = /^\s*(?:\d+>)?\s*(.+?) -> ((?:[A-Za-z]:[\\/]|\\\\).+?)\s*$/;

/**
 * MSBuild の出力から、指定プロジェクトの出力ファイル(TargetPath)を探す。
 * MSBuild は `$(MSBuildProjectName) -> $(TargetPath)` を毎回出力するので、
 * これが MSBuild の評価結果としての EXE パスになる。
 */
export function findBuildOutputPath(
	buildOutput: string,
	projectName: string,
): string | undefined {
	let found: string | undefined;
	for (const line of buildOutput.split(/\r?\n/)) {
		const match = BUILD_OUTPUT_LINE.exec(line);
		if (match === null) {
			continue;
		}
		if (match[1].trim().toLowerCase() !== projectName.toLowerCase()) {
			continue;
		}
		const outputPath = match[2];
		// .exe を優先(同名で別の出力行がある場合に備える)
		if (/\.exe$/i.test(outputPath) || found === undefined) {
			found = outputPath;
		}
	}
	return found;
}

// ---------------------------------------------------------------------------
// 起動計画
// ---------------------------------------------------------------------------

export interface LaunchPlan {
	exePath: string;
	/** コマンドライン引数(そのまま渡す)。無ければ空文字 */
	argumentsLine: string;
	workingDirectory: string;
	/** EXE の決め方 */
	exeSource: "build-output" | "static" | "start-program";
	/** Output に記録する補足 */
	notes: string[];
}

export type LaunchPlanResult =
	| { ok: true; plan: LaunchPlan }
	| { ok: false; reason: string };

export interface LaunchPlanDeps {
	fileExists(absolutePath: string): boolean;
	directoryExists(absolutePath: string): boolean;
}

/** 実行設定とビルド出力から、起動する EXE・引数・作業ディレクトリを決める */
export function resolveLaunchPlan(
	settings: ProjectRunSettings,
	buildOutputPath: string | undefined,
	deps: LaunchPlanDeps,
): LaunchPlanResult {
	const notes: string[] = [];
	const action = settings.startAction.toLowerCase();
	let exePath: string;
	let exeSource: LaunchPlan["exeSource"];

	if (action === "url") {
		return {
			ok: false,
			reason: "開始動作が「URL で開始」になっています。この起動方法には対応していません。",
		};
	}
	if (action === "program") {
		if (settings.startProgram === undefined) {
			return {
				ok: false,
				reason: "開始動作が「外部プログラムの開始」ですが、プログラム(StartProgram)が設定されていません。",
			};
		}
		if (/\$\(/.test(settings.startProgram)) {
			return {
				ok: false,
				reason: `外部プログラムのパスに未解決のプロパティ参照があります: ${settings.startProgram}`,
			};
		}
		exePath = resolveWindowsPath(settings.startProgram, settings.projectDir);
		exeSource = "start-program";
		notes.push("開始動作: 外部プログラムの開始(.vbproj.user の StartProgram)");
	} else if (action === "project") {
		if (!isRunnableOutputType(settings.outputType)) {
			return {
				ok: false,
				reason:
					`出力の種類が ${settings.outputType} のため直接起動できません。` +
					"Visual Studio のデバッグタブで「外部プログラムの開始」を設定するか、EXE のプロジェクトをスタートアッププロジェクトにしてください。",
			};
		}
		const staticPath =
			settings.outputDir === undefined
				? undefined
				: path.join(settings.outputDir, `${settings.assemblyName ?? settings.projectName}.exe`);
		if (buildOutputPath !== undefined && /\.exe$/i.test(buildOutputPath)) {
			exePath = buildOutputPath;
			exeSource = "build-output";
			if (staticPath !== undefined && staticPath.toLowerCase() !== buildOutputPath.toLowerCase()) {
				notes.push(`静的解析の EXE パス(${staticPath})とビルド結果が異なるため、ビルド結果を使います`);
			}
		} else if (staticPath !== undefined) {
			exePath = staticPath;
			exeSource = "static";
			notes.push("EXE パスは .vbproj の OutputPath と AssemblyName から求めました(ビルド出力から特定できなかったため)");
		} else {
			return {
				ok: false,
				reason:
					"起動する EXE の場所を特定できませんでした(ビルド出力に「プロジェクト名 -> パス」行がなく、" +
					"OutputPath も静的に解決できません)。Output「Legacy VB Build」を確認してください。",
			};
		}
	} else {
		return {
			ok: false,
			reason: `未知の開始動作(StartAction=${settings.startAction})です。`,
		};
	}

	if (!deps.fileExists(exePath)) {
		return { ok: false, reason: `起動する EXE が見つかりません: ${exePath}` };
	}

	let workingDirectory = path.dirname(exePath);
	if (settings.startWorkingDirectory !== undefined) {
		if (/\$\(/.test(settings.startWorkingDirectory)) {
			return {
				ok: false,
				reason: `作業ディレクトリに未解決のプロパティ参照があります: ${settings.startWorkingDirectory}`,
			};
		}
		// 相対パスはプロジェクトディレクトリ基準で解決する
		workingDirectory = resolveWindowsPath(settings.startWorkingDirectory, settings.projectDir);
		notes.push(`作業ディレクトリ: ${workingDirectory}(.vbproj.user の StartWorkingDirectory)`);
		if (!deps.directoryExists(workingDirectory)) {
			return { ok: false, reason: `作業ディレクトリが存在しません: ${workingDirectory}` };
		}
	}

	return {
		ok: true,
		plan: {
			exePath,
			argumentsLine: settings.startArguments ?? "",
			workingDirectory,
			exeSource,
			notes,
		},
	};
}

/**
 * child_process.spawn に渡す引数を組み立てる。
 * StartArguments は Visual Studio と同じくコマンドライン文字列として
 * そのまま渡したいので windowsVerbatimArguments を使う。その場合
 * argv[0] も引用符なしで連結されるため、EXE パスは自前で引用符を付ける
 * (パスに空白があるとアプリ側の引数解析がずれるのを防ぐ)。
 */
export function buildSpawnInvocation(plan: LaunchPlan): {
	command: string;
	args: string[];
	argv0: string;
} {
	return {
		command: plan.exePath,
		args: plan.argumentsLine === "" ? [] : [plan.argumentsLine],
		argv0: `"${plan.exePath}"`,
	};
}

// ---------------------------------------------------------------------------
// 終了コード・クラッシュ情報
// ---------------------------------------------------------------------------

/** よく見る異常終了コード(NTSTATUS / CLR 例外コード) */
const KNOWN_EXIT_CODES: ReadonlyMap<number, string> = new Map([
	[0xe0434352, ".NET の未処理例外でプロセスが終了しました"],
	[0xe0434f4d, ".NET の未処理例外でプロセスが終了しました(旧 CLR)"],
	[0xc0000005, "アクセス違反(ネイティブ DLL / COM 側の可能性)"],
	[0xc00000fd, "スタックオーバーフロー(無限再帰など)"],
	[0xc0000409, "スタック バッファー オーバーラン、または Environment.FailFast"],
	[0xc0000135, "必要な DLL が見つかりません"],
	[0xc000007b, "DLL の形式が不正です(32bit / 64bit の不一致の可能性)"],
	[0x80131506, "CLR の内部エラー(ExecutionEngineException)"],
	[0xc000013a, "Ctrl+C / コンソールを閉じたことによる終了"],
]);

export interface ExitCodeDescription {
	/** 0x 付き 16 進表記(8 桁) */
	hex: string;
	meaning?: string;
	abnormal: boolean;
}

export function describeExitCode(code: number): ExitCodeDescription {
	// Windows の終了コードは DWORD。負数で来た場合も符号なしに揃える
	const unsigned = code >>> 0;
	const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}`;
	return {
		hex,
		meaning: KNOWN_EXIT_CODES.get(unsigned),
		abnormal: unsigned !== 0,
	};
}

/**
 * 異常終了時に Windows イベントログ(Application)から .NET Runtime(1026)/
 * Application Error(1000)のイベントを取得する PowerShell スクリプト。
 * 未処理例外の型とスタックトレースはここに記録される。
 * 出力は BOM なし UTF-8 に固定する。
 */
export function buildCrashEventQueryScript(exeFileName: string, secondsAgo: number): string {
	const escaped = exeFileName.replace(/'/g, "''");
	const seconds = Math.max(1, Math.ceil(secondsAgo));
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
		`$name = '${escaped}'`,
		"Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = @('.NET Runtime', 'Application Error'); " +
			`StartTime = (Get-Date).AddSeconds(-${seconds}) } |`,
		"  Where-Object { $_.Message -and $_.Message.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |",
		"  Sort-Object TimeCreated |",
		"  ForEach-Object { '--- ' + $_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss') + ' [' + $_.ProviderName + ' / ' + $_.Id + ']'; $_.Message; '' }",
	].join("\n");
}

/** powershell.exe -EncodedCommand 用に UTF-16LE + Base64 へ変換する */
export function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}
