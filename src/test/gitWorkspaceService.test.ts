/**
 * gitWorkspaceService の単体テスト。
 * 実機は Windows なので path.win32 を注入し、ファイルシステムは fake にする。
 */

import * as assert from "assert";
import * as path from "path";
import {
	evaluateGitWorkspace,
	findGitRoot,
	type GitWorkspaceDeps,
	isSameOrInside,
	looksLikeNonUtf8,
} from "../services/gitWorkspaceService";

function makeDeps(existing: string[]): GitWorkspaceDeps {
	const lower = existing.map((p) => p.toLowerCase());
	return {
		pathExists: (p) => lower.includes(p.toLowerCase()),
		pathModule: path.win32,
	};
}

suite("gitWorkspaceService: findGitRoot", () => {
	test(".sln と同じフォルダーの .git を見つける", () => {
		const deps = makeDeps(["I:\\Work\\App\\.git"]);
		assert.strictEqual(findGitRoot("I:\\Work\\App", deps), "I:\\Work\\App");
	});

	test("上位フォルダーの .git を見つける(.sln がリポジトリの下位にある)", () => {
		const deps = makeDeps(["I:\\Work\\.git"]);
		assert.strictEqual(findGitRoot("I:\\Work\\App\\Src", deps), "I:\\Work");
	});

	test(".git が無ければ undefined", () => {
		assert.strictEqual(findGitRoot("I:\\Work\\App", makeDeps([])), undefined);
	});
});

suite("gitWorkspaceService: isSameOrInside", () => {
	test("大文字小文字を区別しない", () => {
		assert.ok(isSameOrInside("i:\\work\\app", "I:\\Work", path.win32));
		assert.ok(isSameOrInside("I:\\Work", "i:\\work\\", path.win32));
	});

	test("名前が前方一致するだけの兄弟フォルダーは配下ではない", () => {
		assert.ok(!isSameOrInside("I:\\Work2\\App", "I:\\Work", path.win32));
	});

	test("別ドライブは配下ではない", () => {
		assert.ok(!isSameOrInside("D:\\Work", "I:\\Work", path.win32));
	});
});

suite("gitWorkspaceService: evaluateGitWorkspace", () => {
	const deps = makeDeps(["I:\\Repo\\.git"]);
	const sln = "I:\\Repo\\Sln\\App.sln";

	test("Git 管理外", () => {
		assert.deepStrictEqual(evaluateGitWorkspace(sln, ["I:\\Repo"], makeDeps([])), {
			kind: "no-repository",
		});
	});

	test("リポジトリルートを開いていれば covered", () => {
		const status = evaluateGitWorkspace(sln, ["i:\\repo"], deps);
		assert.strictEqual(status.kind, "covered");
	});

	test("リポジトリより上位のフォルダーを開いていても covered", () => {
		assert.strictEqual(evaluateGitWorkspace(sln, ["I:\\"], deps).kind, "covered");
	});

	test(".sln のフォルダーだけを開いていると parent-of-workspace", () => {
		const status = evaluateGitWorkspace(sln, ["I:\\Repo\\Sln"], deps);
		assert.deepStrictEqual(status, {
			kind: "parent-of-workspace",
			repositoryRoot: "I:\\Repo",
			workspaceFolder: "I:\\Repo\\Sln",
		});
	});

	test("空ウィンドウ・無関係なフォルダーでは outside", () => {
		assert.deepStrictEqual(evaluateGitWorkspace(sln, [], deps), {
			kind: "outside",
			repositoryRoot: "I:\\Repo",
		});
		assert.strictEqual(evaluateGitWorkspace(sln, ["C:\\Other"], deps).kind, "outside");
	});
});

suite("gitWorkspaceService: looksLikeNonUtf8", () => {
	test("ASCII のみ・UTF-8・BOM 付きは false", () => {
		assert.ok(!looksLikeNonUtf8(Buffer.from("Public Class A", "utf8")));
		assert.ok(!looksLikeNonUtf8(Buffer.from("' 受注", "utf8")));
		assert.ok(!looksLikeNonUtf8(Buffer.from([0xef, 0xbb, 0xbf, 0x41])));
	});

	test("Shift_JIS の日本語は true", () => {
		// 「受注」の CP932: 8E F3 92 8D
		assert.ok(looksLikeNonUtf8(Buffer.from([0x27, 0x20, 0x8e, 0xf3, 0x92, 0x8d])));
	});
});
