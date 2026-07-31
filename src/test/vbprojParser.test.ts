/**
 * vbprojParser の単体テスト。
 * パーサーは純粋関数のため vscode モジュールには依存しない。
 * ファイル存在確認は基本的に fake を注入し、実ファイルを使う fixture
 * (basic / linked-file)のみ実 fs で検証する。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type { ProjectItem, VbprojParseResult } from "../types";
import { parseVbproj } from "../vbprojParser";

/** out/test からリポジトリ直下の test-fixtures を参照する */
const FIXTURES_ROOT = path.resolve(__dirname, "..", "..", "test-fixtures");

const realFs = { fileExists: (p: string): boolean => fs.existsSync(p) };

function parseFixture(
	relativeVbprojPath: string,
	deps: { fileExists(p: string): boolean } = realFs,
): VbprojParseResult {
	const projectPath = path.join(FIXTURES_ROOT, relativeVbprojPath);
	const xml = fs.readFileSync(projectPath, "utf8");
	return parseVbproj(xml, projectPath, deps);
}

/** Include 値で項目を特定する(見つからなければ fail) */
function findItem(result: VbprojParseResult, include: string): ProjectItem {
	const item = result.items.find((candidate) => candidate.include === include);
	assert.ok(item !== undefined, `Include="${include}" の項目が見つかりません`);
	return item;
}

suite("vbprojParser: basic fixture", () => {
	const result = parseFixture("basic/Basic.vbproj");

	test("ファイル項目を全件抽出する(Reference は対象外)", () => {
		assert.strictEqual(result.items.length, 7);
		assert.ok(result.items.every((item) => item.kind !== "Reference"));
	});

	test("実在するファイルは resolved / exists=true になる", () => {
		for (const item of result.items) {
			assert.strictEqual(item.status, "resolved", item.include);
			assert.strictEqual(item.exists, true, item.include);
			assert.ok(item.sourcePath !== undefined && path.isAbsolute(item.sourcePath));
		}
	});

	test("SubType / DependentUpon を抽出する", () => {
		assert.strictEqual(findItem(result, "Forms\\OrderForm.vb").subType, "Form");
		assert.strictEqual(
			findItem(result, "Forms\\OrderForm.Designer.vb").dependentUpon,
			"OrderForm.vb",
		);
		assert.strictEqual(
			findItem(result, "Forms\\OrderForm.resx").dependentUpon,
			"OrderForm.vb",
		);
	});

	test("Designer 関連の判定(拡張子・AutoGen・Generator)", () => {
		assert.strictEqual(findItem(result, "Forms\\OrderForm.Designer.vb").isSensitive, true);
		assert.strictEqual(findItem(result, "Forms\\OrderForm.resx").isSensitive, true);
		assert.strictEqual(
			findItem(result, "My Project\\Application.Designer.vb").isSensitive,
			true,
		);
		// Generator / LastGenOutput を持つ .myapp も対象
		assert.strictEqual(
			findItem(result, "My Project\\Application.myapp").isSensitive,
			true,
		);
		assert.strictEqual(findItem(result, "Module1.vb").isSensitive, false);
		assert.strictEqual(findItem(result, "Forms\\OrderForm.vb").isSensitive, false);
	});

	test("メタデータを未知のものも含めて保持する", () => {
		const myapp = findItem(result, "My Project\\Application.myapp");
		assert.strictEqual(myapp.metadata["Generator"], "MyApplicationCodeGenerator");
		assert.strictEqual(myapp.metadata["LastGenOutput"], "Application.Designer.vb");
	});

	test("Reference は未対応種別として診断に記録される", () => {
		const diagnostic = result.diagnostics.find((d) =>
			d.message.includes("Reference ×2"),
		);
		assert.ok(diagnostic !== undefined, "Reference の診断がありません");
		assert.strictEqual(diagnostic.severity, "info");
	});
});

suite("vbprojParser: linked-file fixture", () => {
	const result = parseFixture("linked-file/App/Linked.vbproj");

	test("Link が論理パスに使われる", () => {
		const item = findItem(result, "..\\Shared\\DateHelper.vb");
		assert.strictEqual(item.link, "Common\\DateHelper.vb");
		assert.strictEqual(item.logicalPath, "Common\\DateHelper.vb");
	});

	test("外部相対パスが .vbproj 基準で解決され実在する", () => {
		const item = findItem(result, "..\\Shared\\DateHelper.vb");
		const expected = path.join(FIXTURES_ROOT, "linked-file", "Shared", "DateHelper.vb");
		assert.strictEqual(item.sourcePath, expected);
		assert.strictEqual(item.status, "resolved");
		assert.strictEqual(item.exists, true);
	});
});

suite("vbprojParser: edge-cases fixture", () => {
	// D:\Shared\External.vb だけが「存在する」fake ファイルシステム
	const fakeFs = {
		fileExists: (p: string): boolean => p === "D:\\Shared\\External.vb",
	};
	const result = parseFixture("edge-cases/EdgeCases.vbproj", fakeFs);

	test("MSBuild 式は unresolved-expression(Link は論理パスに反映)", () => {
		const item = findItem(result, "$(SharedSourceRoot)\\Common\\Helper.vb");
		assert.strictEqual(item.status, "unresolved-expression");
		assert.strictEqual(item.sourcePath, undefined);
		assert.strictEqual(item.logicalPath, "Common\\Helper.vb");
		assert.ok(item.unresolvedReason !== undefined);
	});

	test("ワイルドカードは wildcard として展開しない", () => {
		const item = findItem(result, "Common\\**\\*.vb");
		assert.strictEqual(item.status, "wildcard");
		assert.strictEqual(item.sourcePath, undefined);
	});

	test("存在しないファイルは missing / exists=false", () => {
		const item = findItem(result, "Missing.vb");
		assert.strictEqual(item.status, "missing");
		assert.strictEqual(item.exists, false);
	});

	test("ドライブ絶対パスは Windows パスとして正規化する", () => {
		const item = findItem(result, "D:\\Shared\\External.vb");
		assert.strictEqual(item.sourcePath, "D:\\Shared\\External.vb");
		assert.strictEqual(item.status, "resolved");
		assert.strictEqual(item.exists, true);
	});

	test("ItemGroup の Condition は配下の項目へ継承される", () => {
		const item = findItem(result, "DebugOnly.vb");
		assert.strictEqual(item.status, "conditional");
		assert.strictEqual(item.condition, "'$(Configuration)' == 'Debug'");
		// Condition 付きでもパス解決と存在確認は行う
		assert.ok(item.sourcePath !== undefined);
		assert.strictEqual(item.exists, false);
	});

	test("Item 単体の Condition も conditional になる", () => {
		const item = findItem(result, "ItemCond.vb");
		assert.strictEqual(item.status, "conditional");
		assert.strictEqual(item.condition, "'$(BuildFlavor)' == 'Special'");
	});

	test("Include のない項目はスキップし警告を残す", () => {
		assert.ok(
			result.diagnostics.some(
				(d) => d.severity === "warning" && d.message.includes("Include 属性のない"),
			),
		);
	});

	test("Import / Choose / 参照系は診断として報告される", () => {
		assert.ok(result.diagnostics.some((d) => d.message.includes("<Import>")));
		assert.ok(
			result.diagnostics.some(
				(d) => d.severity === "warning" && d.message.includes("<Choose>"),
			),
		);
		const unsupported = result.diagnostics.find((d) =>
			d.message.includes("未対応の項目種別"),
		);
		assert.ok(unsupported !== undefined);
		assert.ok(unsupported.message.includes("ProjectReference ×1"));
		assert.ok(unsupported.message.includes("Reference ×1"));
		assert.ok(unsupported.message.includes("COMReference ×1"));
	});

	test("Choose 内の項目は抽出されない(評価しないため)", () => {
		assert.ok(result.items.every((item) => item.include !== "ChooseOnly.vb"));
		assert.ok(result.items.every((item) => item.include !== "ChooseOtherwise.vb"));
	});
});

suite("vbprojParser: 入力の頑健性", () => {
	test("BOM 付き XML を解析できる", () => {
		const xml =
			"\uFEFF" +
			'<?xml version="1.0" encoding="utf-8"?>' +
			'<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">' +
			'<ItemGroup><Compile Include="A.vb" /></ItemGroup>' +
			"</Project>";
		const result = parseVbproj(xml, "/tmp/Bom.vbproj", { fileExists: () => true });
		assert.strictEqual(result.items.length, 1);
		assert.strictEqual(result.items[0].status, "resolved");
	});

	test("単一 ItemGroup・単一 Compile でも配列として扱う", () => {
		const xml =
			'<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">' +
			'<ItemGroup><Compile Include="Only.vb" /></ItemGroup>' +
			"</Project>";
		const result = parseVbproj(xml, "/tmp/Single.vbproj", { fileExists: () => true });
		assert.strictEqual(result.items.length, 1);
		assert.strictEqual(result.items[0].include, "Only.vb");
	});

	test("壊れた XML は error 診断を返し、項目は空になる", () => {
		const result = parseFixture("malformed/Broken.vbproj");
		assert.strictEqual(result.items.length, 0);
		assert.ok(result.diagnostics.some((d) => d.severity === "error"));
	});

	test("Project 要素がない XML は error 診断を返す", () => {
		const result = parseVbproj("<Foo />", "/tmp/NotProj.vbproj", realFs);
		assert.strictEqual(result.items.length, 0);
		assert.ok(
			result.diagnostics.some(
				(d) => d.severity === "error" && d.message.includes("<Project>"),
			),
		);
	});
});
