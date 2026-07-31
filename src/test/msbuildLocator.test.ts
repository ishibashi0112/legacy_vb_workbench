/**
 * msbuildLocator / buildService(引数組み立て)の単体テスト。
 * 実行環境依存(fs・レジストリ)はすべて fake を注入して Mac 上で検証する。
 * 実 Windows での reg.exe・MSBuild 実行は W 検証項目。
 */

import * as assert from "assert";
import { buildMsbuildArgs } from "../services/buildService";
import {
	type LocatorDeps,
	locateDevenv,
	locateMsbuild,
	parseRegSzValue,
} from "../services/msbuildLocator";

/** 実際の reg.exe query 出力を模したサンプル */
const REG_OUTPUT_MSBUILD = [
	"",
	"HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\MSBuild\\ToolsVersions\\12.0",
	"    MSBuildToolsPath    REG_SZ    C:\\Program Files (x86)\\MSBuild\\12.0\\bin\\",
	"",
].join("\r\n");

function makeDeps(overrides: Partial<LocatorDeps>): LocatorDeps {
	return {
		configuredPath: undefined,
		fileExists: () => false,
		queryRegistry: () => Promise.resolve(undefined),
		...overrides,
	};
}

suite("msbuildLocator: parseRegSzValue", () => {
	test("REG_SZ の値を取り出せる", () => {
		assert.strictEqual(
			parseRegSzValue(REG_OUTPUT_MSBUILD, "MSBuildToolsPath"),
			"C:\\Program Files (x86)\\MSBuild\\12.0\\bin\\",
		);
	});

	test("値名は大文字小文字を区別しない", () => {
		assert.strictEqual(
			parseRegSzValue(REG_OUTPUT_MSBUILD, "msbuildtoolspath"),
			"C:\\Program Files (x86)\\MSBuild\\12.0\\bin\\",
		);
	});

	test("REG_EXPAND_SZ も取り出せる", () => {
		const output = "    InstallDir    REG_EXPAND_SZ    C:\\VS\\Common7\\IDE\\";
		assert.strictEqual(parseRegSzValue(output, "InstallDir"), "C:\\VS\\Common7\\IDE\\");
	});

	test("該当値がなければ undefined", () => {
		assert.strictEqual(parseRegSzValue(REG_OUTPUT_MSBUILD, "Other"), undefined);
	});
});

suite("msbuildLocator: locateMsbuild", () => {
	test("設定パスが最優先される", async () => {
		const deps = makeDeps({
			configuredPath: "D:\\tools\\MSBuild.exe",
			fileExists: (p) => p === "D:\\tools\\MSBuild.exe",
		});
		const result = await locateMsbuild(deps);
		assert.deepStrictEqual(result, {
			path: "D:\\tools\\MSBuild.exe",
			source: "設定",
		});
	});

	test("設定パスが実在しない場合はレジストリへフォールバックする", async () => {
		const exe = "C:\\Program Files (x86)\\MSBuild\\12.0\\bin\\MSBuild.exe";
		const deps = makeDeps({
			configuredPath: "D:\\wrong\\MSBuild.exe",
			fileExists: (p) => p === exe,
			queryRegistry: () => Promise.resolve(REG_OUTPUT_MSBUILD),
		});
		const result = await locateMsbuild(deps);
		assert.deepStrictEqual(result, { path: exe, source: "レジストリ" });
	});

	test("レジストリの ToolsPath 末尾の \\ があっても正しく連結する", async () => {
		const deps = makeDeps({
			fileExists: (p) =>
				p === "C:\\Program Files (x86)\\MSBuild\\12.0\\bin\\MSBuild.exe",
			queryRegistry: () => Promise.resolve(REG_OUTPUT_MSBUILD),
		});
		const result = await locateMsbuild(deps);
		assert.strictEqual(
			result?.path,
			"C:\\Program Files (x86)\\MSBuild\\12.0\\bin\\MSBuild.exe",
		);
	});

	test("64bit ビューで見つからなければ 32bit ビューを照会する", async () => {
		const views: boolean[] = [];
		const deps = makeDeps({
			fileExists: (p) =>
				p === "C:\\Program Files (x86)\\MSBuild\\12.0\\bin\\MSBuild.exe",
			queryRegistry: (_key, _value, view32) => {
				views.push(view32);
				return Promise.resolve(view32 ? REG_OUTPUT_MSBUILD : undefined);
			},
		});
		const result = await locateMsbuild(deps);
		assert.deepStrictEqual(views, [false, true]);
		assert.strictEqual(result?.source, "レジストリ");
	});

	test("レジストリで見つからなければ既知パスへフォールバックする", async () => {
		const known = "C:\\Program Files (x86)\\MSBuild\\12.0\\Bin\\MSBuild.exe";
		const deps = makeDeps({ fileExists: (p) => p === known });
		const result = await locateMsbuild(deps);
		assert.deepStrictEqual(result, { path: known, source: "既定パス" });
	});

	test("どの手段でも見つからなければ undefined", async () => {
		const result = await locateMsbuild(makeDeps({}));
		assert.strictEqual(result, undefined);
	});
});

suite("msbuildLocator: locateDevenv", () => {
	test("レジストリの InstallDir から devenv.exe を解決する", async () => {
		const output =
			"    InstallDir    REG_SZ    C:\\Program Files (x86)\\Microsoft Visual Studio 12.0\\Common7\\IDE\\";
		const exe =
			"C:\\Program Files (x86)\\Microsoft Visual Studio 12.0\\Common7\\IDE\\devenv.exe";
		const deps = makeDeps({
			fileExists: (p) => p === exe,
			queryRegistry: () => Promise.resolve(output),
		});
		const result = await locateDevenv(deps);
		assert.deepStrictEqual(result, { path: exe, source: "レジストリ" });
	});

	test("既知パス(VS2013)へフォールバックする", async () => {
		const exe =
			"C:\\Program Files (x86)\\Microsoft Visual Studio 12.0\\Common7\\IDE\\devenv.exe";
		const deps = makeDeps({ fileExists: (p) => p === exe });
		const result = await locateDevenv(deps);
		assert.deepStrictEqual(result, { path: exe, source: "既定パス" });
	});
});

suite("buildService: buildMsbuildArgs", () => {
	test("handoff §19 の初期コマンド例と同じ引数を組み立てる", () => {
		assert.deepStrictEqual(
			buildMsbuildArgs("C:\\work\\App\\App.sln", "Debug"),
			["C:\\work\\App\\App.sln", "/t:Build", "/p:Configuration=Debug", "/nologo"],
		);
	});

	test("Configuration を差し替えられる(/m は付けない)", () => {
		const args = buildMsbuildArgs("C:\\work\\App\\App.sln", "Release");
		assert.ok(args.includes("/p:Configuration=Release"));
		assert.ok(!args.some((a) => a === "/m" || a.startsWith("/m:")));
	});
});
