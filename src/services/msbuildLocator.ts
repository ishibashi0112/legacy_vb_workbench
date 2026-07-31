/**
 * MSBuild.exe / devenv.exe の検出(handoff §19 の検出順)。
 *
 * 1. 拡張設定のパス
 * 2. レジストリ(reg.exe query の出力を解析)
 * 3. 既知パス
 *
 * 実行環境依存(ファイル存在確認・レジストリ照会)はすべて deps 注入とし、
 * Mac 上の単体テストで検証できる純粋ロジックに保つ。
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
}

/** 検出結果(source は表示用) */
export interface LocatedExecutable {
	path: string;
	source: "設定" | "レジストリ" | "既定パス";
}

interface ExecutableSpec {
	registryKey: string;
	registryValue: string;
	/** レジストリ値(ディレクトリ)に連結する実行ファイル名 */
	exeName: string;
	knownPaths: readonly string[];
}

/** MSBuild 12.0(VS2013)を最優先に、順にフォールバックする */
const MSBUILD_SPEC: ExecutableSpec = {
	registryKey: "HKLM\\SOFTWARE\\Microsoft\\MSBuild\\ToolsVersions\\12.0",
	registryValue: "MSBuildToolsPath",
	exeName: "MSBuild.exe",
	knownPaths: [
		"C:\\Program Files (x86)\\MSBuild\\12.0\\Bin\\MSBuild.exe",
		"C:\\Program Files (x86)\\MSBuild\\14.0\\Bin\\MSBuild.exe",
		"C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\MSBuild.exe",
	],
};

/** Visual Studio 2013(12.0)の devenv.exe */
const DEVENV_SPEC: ExecutableSpec = {
	registryKey: "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\12.0",
	registryValue: "InstallDir",
	exeName: "devenv.exe",
	knownPaths: [
		"C:\\Program Files (x86)\\Microsoft Visual Studio 12.0\\Common7\\IDE\\devenv.exe",
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

async function locateExecutable(
	spec: ExecutableSpec,
	deps: LocatorDeps,
): Promise<LocatedExecutable | undefined> {
	const configured = deps.configuredPath?.trim();
	if (configured !== undefined && configured !== "" && deps.fileExists(configured)) {
		return { path: configured, source: "設定" };
	}

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
