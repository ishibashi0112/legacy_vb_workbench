/**
 * 論理ツリー(LegacyTreeNode)を VS Code の TreeItem へ変換する層。
 * ドメインモデルと vscode API の境界はこのファイルに閉じ込める。
 */

import * as vscode from "vscode";
import type { FileNode, LegacyTreeNode, ProjectItemStatus } from "./types";

/** status ごとの表示ラベル(resolved は表示しない) */
const STATUS_LABELS: Record<ProjectItemStatus, string | undefined> = {
	resolved: undefined,
	missing: "ファイルなし",
	"unresolved-expression": "未解決式",
	wildcard: "ワイルドカード未展開",
	conditional: "条件付き",
};

/** 問題のある status には警告アイコンを出す */
const WARNING_STATUSES: readonly ProjectItemStatus[] = [
	"missing",
	"unresolved-expression",
	"wildcard",
];

export class LegacyProjectTreeProvider
	implements vscode.TreeDataProvider<LegacyTreeNode>
{
	private root: LegacyTreeNode | undefined;

	private readonly onDidChangeEmitter = new vscode.EventEmitter<
		LegacyTreeNode | undefined
	>();
	readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

	/** 解析し直した結果でツリー全体を差し替える */
	setRoot(root: LegacyTreeNode | undefined): void {
		this.root = root;
		this.onDidChangeEmitter.fire(undefined);
	}

	getChildren(node?: LegacyTreeNode): LegacyTreeNode[] {
		if (node === undefined) {
			return this.root === undefined ? [] : [this.root];
		}
		return node.children;
	}

	getTreeItem(node: LegacyTreeNode): vscode.TreeItem {
		switch (node.type) {
			case "solution":
				return this.solutionTreeItem(node.label, node.solutionPath, node.id);
			case "project":
				return this.projectTreeItem(node.label, node.projectPath, node.id);
			case "folder":
				return this.folderTreeItem(node.label, node.id);
			case "file":
				return this.fileTreeItem(node);
			case "warning":
				return this.warningTreeItem(node.label, node.id);
		}
	}

	private solutionTreeItem(
		label: string,
		solutionPath: string,
		id: string,
	): vscode.TreeItem {
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
		item.id = id;
		item.iconPath = new vscode.ThemeIcon("folder-library");
		item.tooltip = solutionPath;
		item.contextValue = "solution";
		return item;
	}

	private projectTreeItem(label: string, projectPath: string, id: string): vscode.TreeItem {
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
		item.id = id;
		item.iconPath = new vscode.ThemeIcon("project");
		item.tooltip = projectPath;
		item.contextValue = "project";
		return item;
	}

	private folderTreeItem(label: string, id: string): vscode.TreeItem {
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
		item.id = id;
		item.iconPath = new vscode.ThemeIcon("folder");
		item.contextValue = "folder";
		return item;
	}

	private warningTreeItem(label: string, id: string): vscode.TreeItem {
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.id = id;
		item.iconPath = new vscode.ThemeIcon(
			"error",
			new vscode.ThemeColor("list.errorForeground"),
		);
		item.contextValue = "warning";
		return item;
	}

	private fileTreeItem(node: FileNode): vscode.TreeItem {
		const projectItem = node.item;
		const treeItem = new vscode.TreeItem(
			node.label,
			node.children.length > 0
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		treeItem.id = node.id;

		// 物理パスが解決済みならファイルアイコンテーマを効かせる
		if (projectItem.sourcePath !== undefined) {
			treeItem.resourceUri = vscode.Uri.file(projectItem.sourcePath);
		}
		if (WARNING_STATUSES.includes(projectItem.status)) {
			treeItem.iconPath = new vscode.ThemeIcon(
				"warning",
				new vscode.ThemeColor("list.warningForeground"),
			);
		}

		const descriptionParts: string[] = [];
		const statusLabel = STATUS_LABELS[projectItem.status];
		if (statusLabel !== undefined) {
			descriptionParts.push(statusLabel);
		}
		// conditional などで実ファイルが無い場合も分かるようにする
		if (
			projectItem.sourcePath !== undefined &&
			!projectItem.exists &&
			projectItem.status !== "missing"
		) {
			descriptionParts.push("ファイルなし");
		}
		if (projectItem.isSensitive) {
			descriptionParts.push("Designer関連");
		}
		if (descriptionParts.length > 0) {
			treeItem.description = descriptionParts.join(" / ");
		}

		treeItem.tooltip = this.fileTooltip(node);
		treeItem.contextValue = projectItem.isSensitive ? "file-sensitive" : "file";
		treeItem.command = {
			command: "legacyVbWorkbench.openFile",
			title: "開く",
			arguments: [node],
		};
		return treeItem;
	}

	private fileTooltip(node: FileNode): string {
		const projectItem = node.item;
		const lines: string[] = [
			`Include: ${projectItem.include}`,
			`論理パス: ${projectItem.logicalPath}`,
			`種別: ${projectItem.kind}`,
			`状態: ${projectItem.status}`,
		];
		if (projectItem.sourcePath !== undefined) {
			lines.push(`物理パス: ${projectItem.sourcePath}`);
		}
		if (projectItem.condition !== undefined) {
			lines.push(`Condition: ${projectItem.condition}`);
		}
		if (projectItem.unresolvedReason !== undefined) {
			lines.push(`備考: ${projectItem.unresolvedReason}`);
		}
		if (projectItem.isSensitive) {
			lines.push("⚠ Designer 関連ファイル(手動編集非推奨)");
		}
		return lines.join("\n");
	}
}
