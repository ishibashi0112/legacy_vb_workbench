/**
 * runSettings(デバッグなしで開始の設定解決)の単体テスト。
 * VS2013 が保存する .vbproj / .vbproj.user / .sln の形をインラインで再現する。
 */

import * as assert from "assert";
import * as path from "path";
import {
	buildCrashEventQueryScript,
	buildSpawnInvocation,
	describeExitCode,
	encodePowerShellCommand,
	evaluateSimpleCondition,
	findBuildOutputPath,
	type LaunchPlanDeps,
	type ProjectRunSettings,
	resolveLaunchPlan,
	resolveRunSettings,
	resolveSolutionProjectConfiguration,
} from "../services/runSettings";

const PROJECT_DIR = path.resolve("/work/OrderApp");
const PROJECT_PATH = path.join(PROJECT_DIR, "OrderApp.vbproj");

/** VS2013 が生成する WinForms アプリの .vbproj(要点のみ) */
const VBPROJ = `\uFEFF<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="12.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" Condition="Exists('$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props')" />
  <PropertyGroup>
    <Configuration Condition=" '$(Configuration)' == '' ">Debug</Configuration>
    <Platform Condition=" '$(Platform)' == '' ">AnyCPU</Platform>
    <OutputType>WinExe</OutputType>
    <StartupObject>OrderApp.My.MyApplication</StartupObject>
    <RootNamespace>OrderApp</RootNamespace>
    <AssemblyName>受注管理</AssemblyName>
  </PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)|$(Platform)' == 'Debug|AnyCPU' ">
    <DebugSymbols>true</DebugSymbols>
    <OutputPath>bin\\Debug\\</OutputPath>
  </PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)|$(Platform)' == 'Release|AnyCPU' ">
    <OutputPath>bin\\Release\\</OutputPath>
  </PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)|$(Platform)' == 'Debug|x86' ">
    <OutputPath>bin\\x86\\Debug\\</OutputPath>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Form1.vb" />
  </ItemGroup>
</Project>`;

/** VS2013 のデバッグタブが保存する .vbproj.user */
const VBPROJ_USER = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="12.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup Condition="'$(Configuration)|$(Platform)' == 'Debug|AnyCPU'">
    <StartArguments>/user admin /mode "テスト 環境"</StartArguments>
    <StartWorkingDirectory>..\\Data\\</StartWorkingDirectory>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)' == 'Release|AnyCPU'">
    <StartArguments>/mode release</StartArguments>
  </PropertyGroup>
  <PropertyGroup>
    <ProjectView>ProjectFiles</ProjectView>
  </PropertyGroup>
</Project>`;

suite("runSettings: evaluateSimpleCondition", () => {
	const state = new Map([
		["configuration", "Debug"],
		["platform", "AnyCPU"],
	]);

	test("Configuration|Platform の比較を評価する", () => {
		assert.strictEqual(
			evaluateSimpleCondition(" '$(Configuration)|$(Platform)' == 'Debug|AnyCPU' ", state),
			true,
		);
		assert.strictEqual(
			evaluateSimpleCondition("'$(Configuration)|$(Platform)' == 'Release|AnyCPU'", state),
			false,
		);
	});

	test("大文字小文字を区別しない(MSBuild と同じ)", () => {
		assert.strictEqual(evaluateSimpleCondition("'$(configuration)' == 'DEBUG'", state), true);
	});

	test("!= と未定義プロパティ(空文字扱い)", () => {
		assert.strictEqual(evaluateSimpleCondition("'$(Foo)' == ''", state), true);
		assert.strictEqual(evaluateSimpleCondition("'$(Configuration)' != ''", state), true);
	});

	test("Exists() や and/or、プロパティ関数は評価しない", () => {
		assert.strictEqual(evaluateSimpleCondition("Exists('a.targets')", state), undefined);
		assert.strictEqual(
			evaluateSimpleCondition("'$(A)' == '' and '$(B)' == ''", state),
			undefined,
		);
		assert.strictEqual(
			evaluateSimpleCondition("'$([System.DateTime]::Now)' == ''", state),
			undefined,
		);
	});
});

suite("runSettings: resolveRunSettings", () => {
	test("Debug: OutputPath・AssemblyName・.user の引数と作業ディレクトリを読む", () => {
		const settings = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: VBPROJ,
			userXml: VBPROJ_USER,
			configuration: "Debug",
		});
		assert.strictEqual(settings.platform, "AnyCPU");
		assert.strictEqual(settings.outputType, "WinExe");
		assert.strictEqual(settings.assemblyName, "受注管理");
		assert.strictEqual(settings.outputDir, path.join(PROJECT_DIR, "bin", "Debug"));
		assert.strictEqual(settings.startArguments, '/user admin /mode "テスト 環境"');
		assert.strictEqual(settings.startWorkingDirectory, "..\\Data\\");
		assert.strictEqual(settings.startAction, "Project");
		assert.strictEqual(settings.userFileFound, true);
		assert.deepStrictEqual(
			settings.diagnostics.filter((d) => d.severity !== "info"),
			[],
		);
	});

	test("Release: 構成に合う PropertyGroup だけを使う", () => {
		const settings = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: VBPROJ,
			userXml: VBPROJ_USER,
			configuration: "Release",
		});
		assert.strictEqual(settings.outputDir, path.join(PROJECT_DIR, "bin", "Release"));
		assert.strictEqual(settings.startArguments, "/mode release");
		assert.strictEqual(settings.startWorkingDirectory, undefined);
	});

	test(".sln から与えたプラットフォームはプロジェクトの既定値より優先する", () => {
		const settings = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: VBPROJ,
			userXml: VBPROJ_USER,
			configuration: "Debug",
			platform: "x86",
		});
		assert.strictEqual(settings.platform, "x86");
		assert.strictEqual(settings.outputDir, path.join(PROJECT_DIR, "bin", "x86", "Debug"));
		// .user には Debug|x86 の設定が無い
		assert.strictEqual(settings.startArguments, undefined);
	});

	test(".vbproj.user が無くても EXE の設定は読める", () => {
		const settings = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: VBPROJ,
			configuration: "Debug",
		});
		assert.strictEqual(settings.userFileFound, false);
		assert.strictEqual(settings.startArguments, undefined);
		assert.strictEqual(settings.outputDir, path.join(PROJECT_DIR, "bin", "Debug"));
	});

	test("AssemblyName が無ければプロジェクト名を使う", () => {
		const xml = `<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup><OutputType>WinExe</OutputType><OutputPath>bin\\</OutputPath></PropertyGroup>
</Project>`;
		const settings = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: xml,
			configuration: "Debug",
		});
		assert.strictEqual(settings.assemblyName, "OrderApp");
	});

	test("$(SolutionDir) は .sln 経由なら展開し、未知の参照は未解決として警告する", () => {
		const xml = `<Project>
  <PropertyGroup><OutputPath>$(SolutionDir)Output\\</OutputPath></PropertyGroup>
</Project>`;
		const solutionDir = path.resolve("/work");
		const viaSln = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: xml,
			configuration: "Debug",
			solutionDir,
		});
		assert.strictEqual(viaSln.outputDir, path.join(solutionDir, "Output"));

		const direct = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: xml,
			configuration: "Debug",
		});
		assert.strictEqual(direct.outputDir, undefined);
		assert.ok(
			direct.diagnostics.some(
				(d) => d.severity === "warning" && d.message.includes("$(SolutionDir)"),
			),
		);
	});

	test("評価できない Condition の PropertyGroup は無視して警告する", () => {
		const xml = `<Project>
  <PropertyGroup><OutputType>WinExe</OutputType><OutputPath>bin\\Debug\\</OutputPath></PropertyGroup>
  <PropertyGroup Condition="Exists('custom.props')"><OutputPath>custom\\</OutputPath></PropertyGroup>
</Project>`;
		const settings = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: xml,
			configuration: "Debug",
		});
		assert.strictEqual(settings.outputDir, path.join(PROJECT_DIR, "bin", "Debug"));
		assert.ok(
			settings.diagnostics.some(
				(d) => d.severity === "warning" && d.message.includes("Exists('custom.props')"),
			),
		);
	});

	test("「外部プログラムの開始」(StartAction=Program)を読む", () => {
		const user = `<Project>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)' == 'Debug|AnyCPU'">
    <StartAction>Program</StartAction>
    <StartProgram>C:\\Host\\Host.exe</StartProgram>
    <StartArguments>/plugin OrderApp.dll</StartArguments>
  </PropertyGroup>
</Project>`;
		const settings = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: VBPROJ,
			userXml: user,
			configuration: "Debug",
		});
		assert.strictEqual(settings.startAction, "Program");
		assert.strictEqual(settings.startProgram, "C:\\Host\\Host.exe");
		assert.strictEqual(settings.startArguments, "/plugin OrderApp.dll");
	});

	test("壊れた .vbproj.user はエラー診断にし、.vbproj の設定は残す", () => {
		const settings = resolveRunSettings({
			projectPath: PROJECT_PATH,
			projectXml: VBPROJ,
			userXml: "<Project><PropertyGroup>",
			configuration: "Debug",
		});
		assert.strictEqual(settings.outputDir, path.join(PROJECT_DIR, "bin", "Debug"));
		assert.ok(settings.diagnostics.some((d) => d.severity === "error"));
	});
});

suite("runSettings: resolveSolutionProjectConfiguration", () => {
	const GUID = "A1111111-1111-1111-1111-111111111111";
	const sln = (platforms: string, mapping: string): string => `
Microsoft Visual Studio Solution File, Format Version 12.00
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
${platforms}
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
${mapping}
	EndGlobalSection
EndGlobal
`;

	test("Any CPU を既定にし、プロジェクト側 AnyCPU へ対応付ける", () => {
		const content = sln(
			"\t\tDebug|Any CPU = Debug|Any CPU\n\t\tRelease|Any CPU = Release|Any CPU",
			`\t\t{${GUID}}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\n\t\t{${GUID}}.Debug|Any CPU.Build.0 = Debug|Any CPU`,
		);
		assert.deepStrictEqual(resolveSolutionProjectConfiguration(content, GUID, "Debug"), {
			configuration: "Debug",
			platform: "AnyCPU",
			solutionPlatform: "Any CPU",
			builds: true,
		});
	});

	test("Mixed Platforms を優先し、x86 への対応付けとビルド対象外を検出する", () => {
		const content = sln(
			"\t\tDebug|Any CPU = Debug|Any CPU\n\t\tDebug|Mixed Platforms = Debug|Mixed Platforms\n\t\tDebug|x86 = Debug|x86",
			`\t\t{${GUID.toLowerCase()}}.Debug|Mixed Platforms.ActiveCfg = Debug|x86`,
		);
		assert.deepStrictEqual(
			resolveSolutionProjectConfiguration(content, `{${GUID}}`, "debug"),
			{
				configuration: "Debug",
				platform: "x86",
				solutionPlatform: "Mixed Platforms",
				builds: false,
			},
		);
	});

	test("対応表に無ければ undefined", () => {
		const content = sln("\t\tDebug|x86 = Debug|x86", "");
		assert.strictEqual(resolveSolutionProjectConfiguration(content, GUID, "Debug"), undefined);
	});
});

suite("runSettings: findBuildOutputPath", () => {
	const output = [
		"ビルドを開始しました。",
		"  CommonLib -> C:\\work\\CommonLib\\bin\\Debug\\CommonLib.dll",
		"  OrderApp -> C:\\work\\OrderApp\\bin\\Debug\\受注管理.exe",
		"1>  Order App 2 -> C:\\work\\Order App 2\\bin\\Debug\\OrderApp2.exe",
		"ビルドに成功しました。",
	].join("\r\n");

	test("プロジェクト名の行から EXE パスを取る", () => {
		assert.strictEqual(
			findBuildOutputPath(output, "orderapp"),
			"C:\\work\\OrderApp\\bin\\Debug\\受注管理.exe",
		);
	});

	test("空白を含むプロジェクト名と /m の接頭辞に対応する", () => {
		assert.strictEqual(
			findBuildOutputPath(output, "Order App 2"),
			"C:\\work\\Order App 2\\bin\\Debug\\OrderApp2.exe",
		);
	});

	test("見つからなければ undefined", () => {
		assert.strictEqual(findBuildOutputPath(output, "Missing"), undefined);
	});
});

suite("runSettings: resolveLaunchPlan", () => {
	const baseSettings = (overrides: Partial<ProjectRunSettings> = {}): ProjectRunSettings => ({
		projectPath: PROJECT_PATH,
		projectDir: PROJECT_DIR,
		projectName: "OrderApp",
		configuration: "Debug",
		platform: "AnyCPU",
		assemblyName: "受注管理",
		outputType: "WinExe",
		outputDir: path.join(PROJECT_DIR, "bin", "Debug"),
		startAction: "Project",
		userFileFound: true,
		diagnostics: [],
		...overrides,
	});
	const staticExe = path.join(PROJECT_DIR, "bin", "Debug", "受注管理.exe");
	const allExist: LaunchPlanDeps = { fileExists: () => true, directoryExists: () => true };

	test("ビルド出力の EXE を優先し、既定の作業ディレクトリは EXE のフォルダ", () => {
		const buildExe = path.join(PROJECT_DIR, "out", "受注管理.exe");
		const result = resolveLaunchPlan(baseSettings({ startArguments: "/a 1" }), buildExe, allExist);
		assert.ok(result.ok);
		assert.strictEqual(result.plan.exePath, buildExe);
		assert.strictEqual(result.plan.exeSource, "build-output");
		assert.strictEqual(result.plan.argumentsLine, "/a 1");
		assert.strictEqual(result.plan.workingDirectory, path.dirname(buildExe));
		assert.ok(result.plan.notes.some((note) => note.includes("異なる")));
	});

	test("ビルド出力が無ければ OutputPath + AssemblyName から求める", () => {
		const result = resolveLaunchPlan(baseSettings(), undefined, allExist);
		assert.ok(result.ok);
		assert.strictEqual(result.plan.exePath, staticExe);
		assert.strictEqual(result.plan.exeSource, "static");
		assert.strictEqual(result.plan.argumentsLine, "");
	});

	test("相対の作業ディレクトリはプロジェクト基準で解決し、無ければエラー", () => {
		const settings = baseSettings({ startWorkingDirectory: "..\\Data\\" });
		const ok = resolveLaunchPlan(settings, undefined, allExist);
		assert.ok(ok.ok);
		assert.strictEqual(ok.plan.workingDirectory, path.resolve(PROJECT_DIR, "..", "Data"));

		const missing = resolveLaunchPlan(settings, undefined, {
			fileExists: () => true,
			directoryExists: () => false,
		});
		assert.ok(!missing.ok);
		assert.ok(missing.reason.includes("作業ディレクトリ"));
	});

	test("EXE が存在しなければエラー", () => {
		const result = resolveLaunchPlan(baseSettings(), undefined, {
			fileExists: () => false,
			directoryExists: () => true,
		});
		assert.ok(!result.ok);
		assert.ok(result.reason.includes(staticExe));
	});

	test("クラスライブラリは直接起動できない", () => {
		const result = resolveLaunchPlan(baseSettings({ outputType: "Library" }), undefined, allExist);
		assert.ok(!result.ok);
		assert.ok(result.reason.includes("Library"));
	});

	test("外部プログラムの開始は StartProgram を起動する", () => {
		const result = resolveLaunchPlan(
			baseSettings({
				outputType: "Library",
				startAction: "Program",
				startProgram: "C:\\Host\\Host.exe",
				startArguments: "/plugin x",
			}),
			undefined,
			allExist,
		);
		assert.ok(result.ok);
		assert.strictEqual(result.plan.exePath, "C:\\Host\\Host.exe");
		assert.strictEqual(result.plan.exeSource, "start-program");
		assert.strictEqual(result.plan.argumentsLine, "/plugin x");
	});

	test("URL で開始は未対応としてエラー", () => {
		const result = resolveLaunchPlan(baseSettings({ startAction: "URL" }), undefined, allExist);
		assert.ok(!result.ok);
	});
});

suite("runSettings: 起動引数と終了コード", () => {
	test("EXE パスを引用符で囲み、引数文字列はそのまま渡す", () => {
		const invocation = buildSpawnInvocation({
			exePath: "C:\\Program Files\\受注 管理\\受注管理.exe",
			argumentsLine: '/user admin /mode "テスト 環境"',
			workingDirectory: "C:\\",
			exeSource: "static",
			notes: [],
		});
		assert.deepStrictEqual(invocation, {
			command: "C:\\Program Files\\受注 管理\\受注管理.exe",
			args: ['/user admin /mode "テスト 環境"'],
			argv0: '"C:\\Program Files\\受注 管理\\受注管理.exe"',
		});
	});

	test("引数なしなら args は空", () => {
		const invocation = buildSpawnInvocation({
			exePath: "C:\\a.exe",
			argumentsLine: "",
			workingDirectory: "C:\\",
			exeSource: "static",
			notes: [],
		});
		assert.deepStrictEqual(invocation.args, []);
	});

	test("正常終了と .NET 未処理例外(負数・符号なしの両方)", () => {
		assert.deepStrictEqual(describeExitCode(0), {
			hex: "0x00000000",
			meaning: undefined,
			abnormal: false,
		});
		for (const code of [-532462766, 3762504530]) {
			const description = describeExitCode(code);
			assert.strictEqual(description.hex, "0xE0434352");
			assert.ok(description.meaning?.includes("未処理例外"));
			assert.strictEqual(description.abnormal, true);
		}
		assert.strictEqual(describeExitCode(1).meaning, undefined);
		assert.strictEqual(describeExitCode(1).abnormal, true);
	});

	test("イベントログ照会スクリプトは EXE 名の ' をエスケープし、Base64 で往復できる", () => {
		const script = buildCrashEventQueryScript("O'Brien.exe", 12.3);
		assert.ok(script.includes("$name = 'O''Brien.exe'"));
		assert.ok(script.includes("AddSeconds(-13)"));
		assert.ok(script.includes("'.NET Runtime', 'Application Error'"));
		const decoded = Buffer.from(encodePowerShellCommand(script), "base64").toString("utf16le");
		assert.strictEqual(decoded, script);
	});
});
