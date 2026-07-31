/**
 * LegacyProjectDragController の単体テスト。
 * vscode.DataTransfer を使うため、拡張テストホスト内で実行される。
 */

import * as assert from "assert";
import * as vscode from "vscode";
import { LegacyProjectDragController } from "../legacyProjectDragController";
import type { FileNode, FolderNode, ProjectItem } from "../types";

function makeFileNode(
	id: string,
	overrides: Partial<ProjectItem> & { include: string },
): FileNode {
	const item: ProjectItem = {
		kind: "Compile",
		logicalPath: overrides.include,
		exists: true,
		status: "resolved",
		isSensitive: false,
		metadata: {},
		...overrides,
	};
	return { type: "file", id, label: overrides.include, item, children: [] };
}

suite("LegacyProjectDragController", () => {
	const controller = new LegacyProjectDragController();

	test("実在するファイルのみ text/uri-list に載せる", async () => {
		const resolved = makeFileNode("f1", {
			include: "Module1.vb",
			sourcePath: "/tmp/proj/Module1.vb",
		});
		const missing = makeFileNode("f2", {
			include: "Missing.vb",
			sourcePath: "/tmp/proj/Missing.vb",
			exists: false,
			status: "missing",
		});
		const unresolved = makeFileNode("f3", {
			include: "$(Root)\\Helper.vb",
			exists: false,
			status: "unresolved-expression",
		});
		const folder: FolderNode = {
			type: "folder",
			id: "d1",
			label: "Forms",
			logicalPath: "Forms",
			children: [],
		};

		const dataTransfer = new vscode.DataTransfer();
		controller.handleDrag([resolved, missing, unresolved, folder], dataTransfer);

		const entry = dataTransfer.get("text/uri-list");
		assert.ok(entry !== undefined, "text/uri-list が設定されていません");
		const value = await entry.asString();
		assert.strictEqual(value, vscode.Uri.file("/tmp/proj/Module1.vb").toString());
	});

	test("複数ファイルは CRLF 区切りで載せる", async () => {
		const a = makeFileNode("a", { include: "A.vb", sourcePath: "/tmp/proj/A.vb" });
		const b = makeFileNode("b", { include: "B.vb", sourcePath: "/tmp/proj/B.vb" });

		const dataTransfer = new vscode.DataTransfer();
		controller.handleDrag([a, b], dataTransfer);

		const value = await dataTransfer.get("text/uri-list")?.asString();
		assert.strictEqual(
			value,
			[
				vscode.Uri.file("/tmp/proj/A.vb").toString(),
				vscode.Uri.file("/tmp/proj/B.vb").toString(),
			].join("\r\n"),
		);
	});

	test("ドラッグ可能なファイルがなければ何も設定しない", () => {
		const missing = makeFileNode("m", {
			include: "Missing.vb",
			sourcePath: "/tmp/proj/Missing.vb",
			exists: false,
			status: "missing",
		});
		const dataTransfer = new vscode.DataTransfer();
		controller.handleDrag([missing], dataTransfer);
		assert.strictEqual(dataTransfer.get("text/uri-list"), undefined);
	});
});
