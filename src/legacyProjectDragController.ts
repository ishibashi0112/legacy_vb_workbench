/**
 * ツリーからエディター領域へのドラッグ&ドロップ対応。
 *
 * 標準エクスプローラーと同様に text/uri-list を提供することで、
 * エディターへのドロップ(分割エリア含む)やターミナルへのパス貼り付けが
 * そのまま機能する。ツリー内へのドロップ(ファイル移動)は .vbproj の
 * 書き換えが必要になるため受け付けない(既存プロジェクト不変更の原則)。
 */

import * as vscode from "vscode";
import type { LegacyTreeNode } from "./types";

export class LegacyProjectDragController
	implements vscode.TreeDragAndDropController<LegacyTreeNode>
{
	/** ツリーへのドロップは受け付けない */
	readonly dropMimeTypes: readonly string[] = [];
	readonly dragMimeTypes: readonly string[] = ["text/uri-list"];

	handleDrag(
		source: readonly LegacyTreeNode[],
		dataTransfer: vscode.DataTransfer,
	): void {
		// 物理パスが解決済みで実在するファイルのみドラッグ可能にする
		const uris: string[] = [];
		for (const node of source) {
			if (node.type !== "file") {
				continue;
			}
			const { sourcePath, exists } = node.item;
			if (sourcePath === undefined || !exists) {
				continue;
			}
			uris.push(vscode.Uri.file(sourcePath).toString());
		}
		if (uris.length > 0) {
			// uri-list の仕様(RFC 2483)に合わせ CRLF 区切り
			dataTransfer.set(
				"text/uri-list",
				new vscode.DataTransferItem(uris.join("\r\n")),
			);
		}
	}
}
