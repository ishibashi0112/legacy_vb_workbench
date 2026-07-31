/**
 * Visual Studio(devenv.exe)の起動(handoff §20)。
 * デザイナーや複雑なデバッグへすぐ戻るための導線。
 * 検出は msbuildLocator の locateDevenv を使う。
 */

import { spawn } from "child_process";

/** devenv.exe を .sln / .vbproj を引数に非同期で起動する(終了は待たない) */
export function launchVisualStudio(devenvPath: string, targetPath: string): void {
	const child = spawn(devenvPath, [targetPath], {
		detached: true,
		stdio: "ignore",
		windowsHide: false,
	});
	child.unref();
}
