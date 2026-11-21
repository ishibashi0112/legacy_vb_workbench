/**
 * VS Code 標準のソース管理(Git)で .sln / .vbproj の差分を見られるようにするための判定。
 *
 * VS Code の Git 拡張は「開いているフォルダー(ワークスペース)」配下のリポジトリしか
 * 自動では認識しない。この拡張は .sln をファイル選択ダイアログで選ぶため、
 * ワークスペース外(または空ウィンドウ)の .sln を選ぶとソース管理ビューが空になる。
 * ここではリポジトリルートを探し、ワークスペースで覆われているかを判定する。
 *
 * vscode に依存しない純粋関数にして単体テストできるようにしている。
 */

import * as path from "path";

export interface GitWorkspaceDeps {
	/** ファイル・ディレクトリを問わず存在するか(.git はワークツリー/サブモジュールではファイル) */
	pathExists: (absolutePath: string) => boolean;
	/** パス区切り・大文字小文字の扱い(既定は実行環境。テストで差し替える) */
	pathModule?: path.PlatformPath;
}

/**
 * startDir から親方向へ `.git` を探し、見つかったディレクトリ(リポジトリルート)を返す。
 * 見つからなければ undefined(Git 管理外のプロジェクト)。
 */
export function findGitRoot(startDir: string, deps: GitWorkspaceDeps): string | undefined {
	const p = deps.pathModule ?? path;
	let current = p.resolve(startDir);
	for (;;) {
		if (deps.pathExists(p.join(current, ".git"))) {
			return current;
		}
		const parent = p.dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/**
 * child が parent と同じか、その配下にあるか。
 * Windows 前提のため大文字小文字は区別しない。
 */
export function isSameOrInside(
	child: string,
	parent: string,
	pathModule: path.PlatformPath = path,
): boolean {
	const relative = pathModule.relative(parent.toLowerCase(), child.toLowerCase());
	if (relative === "") {
		return true;
	}
	return !pathModule.isAbsolute(relative) && relative.split(/[\\/]/)[0] !== "..";
}

export type GitWorkspaceStatus =
	/** .sln / .vbproj の上位に .git が無い */
	| { kind: "no-repository" }
	/** リポジトリルートがワークスペースフォルダー内にあり、ソース管理に表示される */
	| { kind: "covered"; repositoryRoot: string; workspaceFolder: string }
	/**
	 * ワークスペースがリポジトリの下位フォルダーだけを開いている。
	 * VS Code は親フォルダーのリポジトリを開くか通知で確認する
	 * (git.openRepositoryInParentFolders の既定値 "prompt")。
	 */
	| { kind: "parent-of-workspace"; repositoryRoot: string; workspaceFolder: string }
	/** リポジトリがワークスペースと無関係(空ウィンドウを含む) */
	| { kind: "outside"; repositoryRoot: string };

/** 選択した .sln / .vbproj のリポジトリが VS Code のワークスペースから見えるかを判定する */
export function evaluateGitWorkspace(
	targetPath: string,
	workspaceFolders: readonly string[],
	deps: GitWorkspaceDeps,
): GitWorkspaceStatus {
	const p = deps.pathModule ?? path;
	const repositoryRoot = findGitRoot(p.dirname(targetPath), deps);
	if (repositoryRoot === undefined) {
		return { kind: "no-repository" };
	}
	for (const folder of workspaceFolders) {
		if (isSameOrInside(repositoryRoot, folder, p)) {
			return { kind: "covered", repositoryRoot, workspaceFolder: folder };
		}
	}
	for (const folder of workspaceFolders) {
		if (isSameOrInside(folder, repositoryRoot, p)) {
			return { kind: "parent-of-workspace", repositoryRoot, workspaceFolder: folder };
		}
	}
	return { kind: "outside", repositoryRoot };
}

/**
 * BOM 無しで UTF-8 として往復できないバイト列か(= Shift_JIS 等の可能性が高い)。
 * VS2013 の日本語環境は .vb を Shift_JIS(CP932)で保存することが多く、
 * VS Code 既定の UTF-8 で開くと差分表示も含めて文字化けする。
 */
export function looksLikeNonUtf8(buffer: Buffer): boolean {
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return false;
	}
	if (
		buffer.length >= 2 &&
		((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
	) {
		return false;
	}
	return !Buffer.from(buffer.toString("utf8"), "utf8").equals(buffer);
}
