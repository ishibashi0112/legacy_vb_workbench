/**
 * repomixExporter の単体テスト。
 * ファイル読み込みは fake を注入し、basic fixture の解析結果で検証する。
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as iconv from "iconv-lite";
import {
	buildRepomixOutput,
	decodeSourceBuffer,
	type RepomixSource,
} from "../services/repomixExporter";
import type { VbprojParseResult } from "../types";
import { parseVbproj } from "../vbprojParser";

const FIXTURES_ROOT = path.resolve(__dirname, "..", "..", "test-fixtures");

function parseBasic(): VbprojParseResult {
	const projectPath = path.join(FIXTURES_ROOT, "basic", "Basic.vbproj");
	return parseVbproj(fs.readFileSync(projectPath, "utf8"), projectPath, {
		fileExists: (p) => fs.existsSync(p),
	});
}

/** どのファイルにも同じ内容を返す fake reader */
const fakeDeps = {
	readTextFile: (absolutePath: string): string | undefined =>
		`' content of ${path.basename(absolutePath)}`,
};

suite("repomixExporter: buildRepomixOutput", () => {
	const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
	const result = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
		includeSensitive: false,
		maskCredentials: false,
	});

	test("Repomix 形式のセクション構造を持つ", () => {
		for (const section of [
			"<file_summary>",
			"<directory_structure>",
			"<files>",
			"<skipped_files>",
		]) {
			assert.ok(result.content.includes(section), `${section} がありません`);
		}
	});

	test("論理ツリーが directory_structure に出力される", () => {
		assert.ok(result.content.includes("Basic/"));
		assert.ok(result.content.includes("  Forms/"));
		assert.ok(result.content.includes("    OrderForm.vb"));
	});

	test("通常のソースは論理パス付きで内容が含まれる", () => {
		assert.ok(result.content.includes('<file path="Basic\\Module1.vb">'));
		assert.ok(result.content.includes("' content of Module1.vb"));
		assert.ok(result.content.includes('<file path="Basic\\Forms\\OrderForm.vb">'));
	});

	test("Designer 関連は既定で除外され、理由付きでスキップ一覧に載る", () => {
		assert.ok(
			!result.content.includes('<file path="Basic\\Forms\\OrderForm.Designer.vb"'),
		);
		const skippedDesigner = result.skipped.find(
			(s) => s.path === "Basic\\Forms\\OrderForm.Designer.vb",
		);
		assert.ok(skippedDesigner !== undefined);
		assert.ok(skippedDesigner.reason.includes("Designer"));
	});

	test("EmbeddedResource(.resx)は常に除外される", () => {
		assert.ok(!result.content.includes('<file path="Basic\\Forms\\OrderForm.resx"'));
		assert.ok(
			result.skipped.some((s) => s.path === "Basic\\Forms\\OrderForm.resx"),
		);
	});

	test("件数・文字数の統計が返る", () => {
		// Module1.vb / OrderForm.vb / App.config の 3 件(Designer 系・resx は除外)
		assert.strictEqual(result.fileCount, 3);
		assert.ok(result.totalChars > 0);
	});

	test("includeSensitive で Designer 関連も含められる", () => {
		const withSensitive = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
			includeSensitive: true,
			maskCredentials: false,
		});
		assert.ok(
			withSensitive.content.includes(
				'<file path="Basic\\Forms\\OrderForm.Designer.vb">',
			),
		);
		// resx は includeSensitive でも除外のまま
		assert.ok(
			!withSensitive.content.includes('<file path="Basic\\Forms\\OrderForm.resx"'),
		);
	});

	test("読み込み失敗はスキップ一覧に載る", () => {
		const failing = buildRepomixOutput(
			"Basic.vbproj",
			sources,
			{ readTextFile: () => undefined },
			{ includeSensitive: false, maskCredentials: false },
		);
		assert.strictEqual(failing.fileCount, 0);
		assert.ok(
			failing.skipped.some((s) => s.reason.includes("読み込みに失敗")),
		);
	});
});

suite("repomixExporter: 認証情報マスク統合", () => {
	test("マスク有効時は内容が置換され masked_credentials に記録される", () => {
		const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
		const secretDeps = {
			readTextFile: (absolutePath: string): string | undefined =>
				absolutePath.toLowerCase().endsWith(".vb")
					? 'Public Pub_DB_Pswd As String = "inf001"'
					: "Password=inf001;",
		};
		const result = buildRepomixOutput("Basic.vbproj", sources, secretDeps, {
			includeSensitive: false,
			maskCredentials: true,
		});
		assert.ok(!result.content.includes("inf001"));
		assert.ok(result.content.includes('= "[MASKED]"'));
		assert.ok(result.content.includes("<masked_credentials>"));
		assert.ok(result.content.includes("パスワード"));
		assert.ok(result.maskedCount > 0);
		assert.ok(
			result.maskedFiles.some((f) => f.path === "Basic\\Module1.vb"),
		);
	});

	test("マスク無効時はそのまま出力され、無効であることが明記される", () => {
		const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
		const secretDeps = {
			readTextFile: (absolutePath: string): string | undefined =>
				absolutePath.toLowerCase().endsWith(".vb")
					? 'Public Pub_DB_Pswd As String = "inf001"'
					: "Password=inf001;",
		};
		const result = buildRepomixOutput("Basic.vbproj", sources, secretDeps, {
			includeSensitive: false,
			maskCredentials: false,
		});
		assert.ok(result.content.includes("inf001"));
		assert.strictEqual(result.maskedCount, 0);
		assert.ok(result.content.includes("マスク機能は設定で無効化"));
	});
});

suite("repomixExporter: .gitignore 連携", () => {
	test("ignoreReasonFor が除外を返したファイルはスキップされ理由が明記される", () => {
		const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
		const result = buildRepomixOutput(
			"Basic.vbproj",
			sources,
			{
				readTextFile: fakeDeps.readTextFile,
				ignoreReasonFor: (absolutePath) =>
					absolutePath.endsWith("Module1.vb") ? "/base/.gitignore" : undefined,
			},
			{ includeSensitive: false, maskCredentials: false },
		);
		assert.ok(!result.content.includes('<file path="Basic\\Module1.vb">'));
		assert.ok(
			result.skipped.some(
				(s) =>
					s.path === "Basic\\Module1.vb" &&
					s.reason.includes(".gitignore により除外"),
			),
		);
		assert.ok(result.content.includes("本家 repomix と同様"));
	});

	test("ignoreReasonFor 未指定なら従来どおり全ファイルを含める", () => {
		const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];
		const result = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
			includeSensitive: false,
			maskCredentials: false,
		});
		assert.ok(result.content.includes('<file path="Basic\\Module1.vb">'));
		assert.ok(result.content.includes("exportRespectGitignore で無効化"));
	});
});

suite("repomixExporter: 未解決項目の扱い", () => {
	test("missing / 未解決式は内容なしでスキップ一覧と印付きツリーに載る", () => {
		const projectPath = path.join(FIXTURES_ROOT, "edge-cases", "EdgeCases.vbproj");
		const parseResult = parseVbproj(
			fs.readFileSync(projectPath, "utf8"),
			projectPath,
			{ fileExists: () => false },
		);
		const result = buildRepomixOutput(
			"EdgeCases.vbproj",
			[{ label: "EdgeCases", parseResult }],
			fakeDeps,
			{ includeSensitive: false, maskCredentials: false },
		);
		assert.strictEqual(result.fileCount, 0);
		assert.ok(result.content.includes("Missing.vb [ファイルなし]"));
		assert.ok(result.content.includes("Helper.vb [未解決式]"));
		assert.ok(
			result.skipped.some(
				(s) => s.path === "EdgeCases\\Missing.vb" && s.reason.includes("存在しません"),
			),
		);
	});
});

suite("repomixExporter: ui_summary(Designer 要約)", () => {
	/** Designer.vb だけ fixture の実内容を返し、他は fake を返す reader */
	const designerAwareDeps = {
		readTextFile: (absolutePath: string): string | undefined =>
			/\.designer\.vb$/i.test(absolutePath)
				? fs.readFileSync(absolutePath, "utf8")
				: fakeDeps.readTextFile(absolutePath),
	};
	const sources: RepomixSource[] = [{ label: "Basic", parseResult: parseBasic() }];

	test("既定で Designer.vb は <ui_summary> として要約される", () => {
		const result = buildRepomixOutput("Basic.vbproj", sources, designerAwareDeps, {
			includeSensitive: false,
			maskCredentials: false,
		});
		assert.strictEqual(result.uiSummaryCount, 1);
		assert.ok(
			result.content.includes(
				'<ui_summary path="Basic\\Forms\\OrderForm.Designer.vb" form="OrderForm">',
			),
		);
		assert.ok(result.content.includes('- btnSave: Button — Text "保存"'));
		assert.ok(result.content.includes('フォームタイトル: "受注入力"'));
		// 原文(座標行)は含まれない
		assert.ok(!result.content.includes("System.Drawing.Point"));
		assert.ok(
			result.skipped.some(
				(s) =>
					s.path === "Basic\\Forms\\OrderForm.Designer.vb" &&
					s.reason.includes("要約済み"),
			),
		);
	});

	test("uiSummary: false で従来どおり要約なしのスキップになる", () => {
		const result = buildRepomixOutput("Basic.vbproj", sources, designerAwareDeps, {
			includeSensitive: false,
			maskCredentials: false,
			uiSummary: false,
		});
		assert.strictEqual(result.uiSummaryCount, 0);
		assert.ok(!result.content.includes("<ui_summary path="));
	});

	test("includeSensitive: true では原文が含まれ要約は出さない", () => {
		const result = buildRepomixOutput("Basic.vbproj", sources, designerAwareDeps, {
			includeSensitive: true,
			maskCredentials: false,
		});
		assert.strictEqual(result.uiSummaryCount, 0);
		assert.ok(!result.content.includes("<ui_summary path="));
		assert.ok(
			result.content.includes('<file path="Basic\\Forms\\OrderForm.Designer.vb">'),
		);
	});

	test(".gitignore 対象の Designer.vb は要約もしない", () => {
		const result = buildRepomixOutput(
			"Basic.vbproj",
			sources,
			{
				readTextFile: designerAwareDeps.readTextFile,
				ignoreReasonFor: (absolutePath) =>
					/\.designer\.vb$/i.test(absolutePath) ? "/base/.gitignore" : undefined,
			},
			{ includeSensitive: false, maskCredentials: false },
		);
		assert.strictEqual(result.uiSummaryCount, 0);
		assert.ok(!result.content.includes("<ui_summary path="));
	});

	test("コントロールを抽出できない Designer.vb は通常スキップ扱い", () => {
		const result = buildRepomixOutput("Basic.vbproj", sources, fakeDeps, {
			includeSensitive: false,
			maskCredentials: false,
		});
		assert.strictEqual(result.uiSummaryCount, 0);
		assert.ok(!result.content.includes("<ui_summary path="));
		assert.ok(
			result.skipped.some(
				(s) =>
					s.path === "Basic\\Forms\\OrderForm.Designer.vb" &&
					s.reason.includes("Designer"),
			),
		);
	});
});

suite("repomixExporter: decodeSourceBuffer", () => {
	test("CP932(Shift_JIS)を自動判定して復元する", () => {
		const original = "' 日本語コメント付きの VB コード\r\nModule M\r\nEnd Module";
		const buffer = iconv.encode(original, "cp932");
		assert.strictEqual(decodeSourceBuffer(buffer), original);
	});

	test("UTF-8 BOM 付きは BOM を除去して読む", () => {
		const buffer = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from("Module M", "utf8"),
		]);
		assert.strictEqual(decodeSourceBuffer(buffer), "Module M");
	});

	test("BOM なし UTF-8 はそのまま読む", () => {
		const original = "' 日本語も UTF-8 のまま";
		assert.strictEqual(decodeSourceBuffer(Buffer.from(original, "utf8")), original);
	});

	test("UTF-16 LE(BOM 付き)も読める", () => {
		const original = "Module ユニコード";
		const buffer = iconv.encode(original, "utf16-le", { addBOM: true });
		assert.strictEqual(decodeSourceBuffer(buffer), original);
	});
});
