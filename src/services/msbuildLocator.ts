/**
 * MSBuild.exe / devenv.exe の検出(handoff §19 の検出順を拡張)。
 *
 * 1. 拡張設定のパス
 * 2. レジストリ(reg.exe query)— VS2013(12.0)。レガシーと同条件を最優先
 * 3. vswhere.exe — VS2017 以降(2022 / 2026 等)はレジストリ登録されないため
 * 4. 既知パス
 *
 * 実行環境依存(ファイル存在確認・レジストリ照会・vswhere 実行)はすべて
 * deps 注入とし、Mac 上の単体テストで検証できる純粋ロジックに保つ。
 * 実際の Windows での動作は W 検証項目。
 */

import * as path from "path";

/** 実行環境依存の注入口 */
export interface LocatorDeps {
	/** 拡張設定に入力されたパス(空文字・未設定は undefined 扱いにする) */
	configuredPath: string | undefined;
	fileExists(absolutePath: string): boolean;
	/**
	 * reg.exe query の標準出力を返す(キー不在・実行失敗時は undefined)。
	 * view32 が true のときは /reg:32(32bit ビュー)で照会する。
	 */
	queryRegistry(
		keyPath: string,
		valueName: string,
		view32: boolean,
	): Promise<string | undefined>;
	/**
	 * vswhere.exe を指定引数で実行し標準出力を返す
	 * (vswhere 不在・実行失敗時は undefined)。
	 */
	runVswhere(args: readonly string[]): Promise<string | undefined>;
}

/** 検出結果(source は表示用) */
export interface LocatedExecutable {
	path: string;
	source: "設定" | "レジストリ" | "vswhere" | "既定パス";
}

interface ExecutableSpec {
	registryKey: string;
	registryValue: string;
	/** レジストリ値(ディレクトリ)に連結する実行ファイル名 */
	exeName: string;
	/** vswhere.exe に渡す引数(VS2017 以降の検出用) */
	vswhereArgs: readonly string[];
	knownPaths: readonly string[];
}

/** MSBuild 12.0(VS2013)を最優先に、順にフォールバックする */
const MSBUILD_SPEC: ExecutableSpec = {
	registryKey: "HKLM\\SOFTWARE\\Microsoft\\MSBuild\\ToolsVersions\\12.0",
	registryValue: "MSBuildToolsPath",
	exeName: "MSBuild.exe",
	vswhereArgs: [
		"-latest",
		"-products",
		"*",
		"-requires",
		"Microsoft.Component.MSBuild",
		"-find",
		"MSBuild\\**\\Bin\\MSBuild.exe",
		"-utf8",
	],
	knownPaths: [
		"C:\\Program Files (x86)\\MSBuild\\12.0\\Bin\\MSBuild.exe",
		"C:\\Program Files (x86)\\MSBuild\\14.0\\Bin\\MSBuild.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2026\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
		"C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\MSBuild.exe",
	],
};

/** Visual Studio の devenv.exe(2013 をレジストリ、2017 以降を vswhere で検出) */
const DEVENV_SPEC: ExecutableSpec = {
	registryKey: "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\12.0",
	registryValue: "InstallDir",
	exeName: "devenv.exe",
	// productPath は devenv.exe のフルパスを返す
	vswhereArgs: ["-latest", "-products", "*", "-property", "productPath", "-utf8"],
	knownPaths: [
		"C:\\Program Files (x86)\\Microsoft Visual Studio 12.0\\Common7\\IDE\\devenv.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\Common7\\IDE\\devenv.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\2026\\Community\\Common7\\IDE\\devenv.exe",
		"C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\devenv.exe",
	],
};

/**
 * reg.exe query の出力から REG_SZ / REG_EXPAND_SZ の値を取り出す。
 * 出力例:
 *   HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\MSBuild\ToolsVersions\12.0
 *       MSBuildToolsPath    REG_SZ    C:\Program Files (x86)\MSBuild\12.0\bin\
 */
export function parseRegSzValue(
	output: string,
	valueName: string,
): string | undefined {
	for (const line of output.split(/\r?\n/)) {
		const match = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line);
		if (match !== null && match[1].toLowerCase() === valueName.toLowerCase()) {
			const value = match[2].trim();
			return value === "" ? undefined : value;
		}
	}
	return undefined;
}

/** vswhere の出力(1 行 1 パス)から最初の非空行を取り出す */
export function parseVswhereOutput(output: string): string | undefined {
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed !== "") {
			return trimmed;
		}
	}
	return undefined;
}

async function locateExecutable(
	spec: ExecutableSpec,
	deps: LocatorDeps,
): Promise<LocatedExecutable | undefined> {
	const configured = deps.configuredPath?.trim();
	if (configured !== undefined && configured !== "" && deps.fileExists(configured)) {
		return { path: configured, source: "設定" };
	}

	// VS2013(12.0)のレジストリを最優先(レガシーと同条件のビルドを守るため)。
	// 64bit ビュー → 32bit ビューの順で照会する
	for (const view32 of [false, true]) {
		const output = await deps.queryRegistry(
			spec.registryKey,
			spec.registryValue,
			view32,
		);
		if (output === undefined) {
			continue;
		}
		const directory = parseRegSzValue(output, spec.registryValue);
		if (directory === undefined) {
			continue;
		}
		const exePath = path.win32.join(directory, spec.exeName);
		if (deps.fileExists(exePath)) {
			return { path: exePath, source: "レジストリ" };
		}
	}

	// VS2017 以降(2022 / 2026 等)はレジストリ登録がないため vswhere で探す
	const vswhereOutput = await deps.runVswhere(spec.vswhereArgs);
	if (vswhereOutput !== undefined) {
		const exePath = parseVswhereOutput(vswhereOutput);
		if (exePath !== undefined && deps.fileExists(exePath)) {
			return { path: exePath, source: "vswhere" };
		}
	}

	for (const known of spec.knownPaths) {
		if (deps.fileExists(known)) {
			return { path: known, source: "既定パス" };
		}
	}
	return undefined;
}

export function locateMsbuild(
	deps: LocatorDeps,
): Promise<LocatedExecutable | undefined> {
	return locateExecutable(MSBUILD_SPEC, deps);
}

export function locateDevenv(
	deps: LocatorDeps,
): Promise<LocatedExecutable | undefined> {
	return locateExecutable(DEVENV_SPEC, deps);
}
