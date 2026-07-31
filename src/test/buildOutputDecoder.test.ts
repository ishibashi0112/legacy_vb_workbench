/**
 * BuildOutputDecoder の単体テスト。
 * 社給PC(MSBuild 18 = UTF-8 出力)で cp932 固定デコードが文字化けした
 * 実障害の再発防止。
 */

import * as assert from "assert";
import * as iconv from "iconv-lite";
import { BuildOutputDecoder } from "../services/buildService";

const JAPANESE_LINE = "ビルドを開始しました。\n";

suite("BuildOutputDecoder", () => {
	test("auto: CP932 出力(MSBuild 12.0)を正しくデコードする", () => {
		const decoder = new BuildOutputDecoder("auto");
		const result = decoder.push(iconv.encode(JAPANESE_LINE, "cp932"));
		assert.strictEqual(result, JAPANESE_LINE);
	});

	test("auto: UTF-8 出力(MSBuild 17/18)を正しくデコードする", () => {
		const decoder = new BuildOutputDecoder("auto");
		const result = decoder.push(Buffer.from(JAPANESE_LINE, "utf8"));
		assert.strictEqual(result, JAPANESE_LINE);
	});

	test("auto: ASCII のみの行は判定を保留したまま出力し、後続で判定する", () => {
		const decoder = new BuildOutputDecoder("auto");
		assert.strictEqual(
			decoder.push(Buffer.from("ValidateSolutionConfiguration:\n", "utf8")),
			"ValidateSolutionConfiguration:\n",
		);
		// 後から日本語(CP932)が来たら CP932 と判定される
		assert.strictEqual(
			decoder.push(iconv.encode(JAPANESE_LINE, "cp932")),
			JAPANESE_LINE,
		);
	});

	test("一度判定したエンコーディングを維持する", () => {
		const decoder = new BuildOutputDecoder("auto");
		decoder.push(Buffer.from(JAPANESE_LINE, "utf8"));
		// 2 行目以降も UTF-8 として解釈される
		assert.strictEqual(
			decoder.push(Buffer.from("警告 MSB3245\n", "utf8")),
			"警告 MSB3245\n",
		);
	});

	test("マルチバイト文字がチャンク境界で分割されても壊れない", () => {
		const decoder = new BuildOutputDecoder("auto");
		const bytes = Buffer.from(JAPANESE_LINE, "utf8");
		// 「ビ」の 3 バイトの途中で分割する
		const first = decoder.push(bytes.subarray(0, 4));
		const second = decoder.push(bytes.subarray(4));
		assert.strictEqual(first + second, JAPANESE_LINE);
	});

	test("改行のない末尾は flush でデコードされる", () => {
		const decoder = new BuildOutputDecoder("auto");
		assert.strictEqual(decoder.push(iconv.encode("ビルド終了", "cp932")), "");
		assert.strictEqual(decoder.flush(), "ビルド終了");
	});

	test("cp932 固定・utf8 固定も指定どおり動く", () => {
		const fixed932 = new BuildOutputDecoder("cp932");
		assert.strictEqual(
			fixed932.push(iconv.encode(JAPANESE_LINE, "cp932")),
			JAPANESE_LINE,
		);
		const fixedUtf8 = new BuildOutputDecoder("utf8");
		assert.strictEqual(
			fixedUtf8.push(Buffer.from(JAPANESE_LINE, "utf8")),
			JAPANESE_LINE,
		);
	});
});
