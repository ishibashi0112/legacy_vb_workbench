/**
 * slnParser の単体テスト。
 * fixture の Sample.sln と、インライン文字列による頑健性ケースで検証する。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { parseSln } from "../slnParser";
import type { SlnParseResult } from "../types";

const FIXTURES_ROOT = path.resolve(__dirname, "..", "..", "test-fixtures");

const realFs = { fileExists: (p: string): boolean => fs.existsSync(p) };

function parseSampleSln(): SlnParseResult {
	const solutionPath = path.join(FIXTURES_ROOT, "solution", "Sample.sln");
	return parseSln(fs.readFileSync(solutionPath, "utf8"), solutionPath, realFs);
}

suite("slnParser: Sample.sln fixture", () => {
	const result = parseSampleSln();

	test(".vbproj のプロジェクトのみ抽出する", () => {
		assert.deepStrictEqual(
			result.projects.map((p) => p.name),
			["Basic", "LinkedApp", "Gone"],
		);
	});

	test("名前・GUID・相対パスを取得する", () => {
		const basic = result.projects[0];
		assert.strictEqual(basic.name, "Basic");
		assert.strictEqual(basic.relativePath, "..\\basic\\Basic.vbproj");
		assert.strictEqual(basic.projectGuid, "A1111111-1111-1111-1111-111111111111");
		assert.strictEqual(
			basic.projectTypeGuid,
			"F184B08F-C81C-45F6-A57F-5ABD9991F28F",
		);
	});

	test("相対パスを .sln 基準の絶対パスへ解決し、存在確認する", () => {
		const basic = result.projects[0];
		assert.strictEqual(
			basic.absolutePath,
			path.join(FIXTURES_ROOT, "basic", "Basic.vbproj"),
		);
		assert.strictEqual(basic.exists, true);
		const gone = result.projects[2];
		assert.strictEqual(gone.exists, false);
	});

	test("Solution Folder と他言語プロジェクトはスキップし診断に残す", () => {
		assert.ok(
			result.diagnostics.some(
				(d) => d.severity === "info" && d.message.includes("Solution Folder"),
			),
		);
		assert.ok(
			result.diagnostics.some(
				(d) => d.severity === "info" && d.message.includes("CSharpLib.csproj"),
			),
		);
	});
});

suite("slnParser: 入力の頑健性", () => {
	test("BOM 付きでも解析できる", () => {
		const content =
			"\uFEFF" +
			"Microsoft Visual Studio Solution File, Format Version 12.00\n" +
			'Project("{F184B08F-C81C-45F6-A57F-5ABD9991F28F}") = "App", "App\\App.vbproj", "{B1111111-1111-1111-1111-111111111111}"\n' +
			"EndProject\n";
		const result = parseSln(content, "/tmp/sol/Test.sln", {
			fileExists: () => true,
		});
		assert.strictEqual(result.projects.length, 1);
		assert.strictEqual(result.projects[0].name, "App");
	});

	test("VB プロジェクトが 1 件もない場合は警告を残す", () => {
		const content = "Microsoft Visual Studio Solution File, Format Version 12.00\n";
		const result = parseSln(content, "/tmp/sol/Empty.sln", realFs);
		assert.strictEqual(result.projects.length, 0);
		assert.ok(
			result.diagnostics.some(
				(d) => d.severity === "warning" && d.message.includes("見つかりません"),
			),
		);
	});

	test(".sln らしくない内容にはヘッダー警告を出す", () => {
		const result = parseSln("<xml />", "/tmp/sol/NotSln.sln", realFs);
		assert.ok(
			result.diagnostics.some(
				(d) => d.severity === "warning" && d.message.includes("ヘッダー"),
			),
		);
	});
});
