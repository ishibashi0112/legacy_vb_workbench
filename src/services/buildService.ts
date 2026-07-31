/**
 * MSBuild の実行(handoff §19)。
 *
 * - exec ではなく spawn(引数配列で渡すためパスの空白・日本語も安全)
 * - Visual Studio と同条件を優先し /m は付けない
 * - 出力は日本語 Windows の既定 CP932 を iconv-lite でデコードして
 *   Output Channel へストリームする
 * - 同時実行は 1 件。キャンセルは taskkill /t で子プロセスごと停止する
 */

import { type ChildProcess, spawn } from "child_process";
import * as path from "path";
import * as iconv from "iconv-lite";
import type * as vscode from "vscode";

/** MSBuild の引数を組み立てる(handoff §19 の初期コマンド例のとおり) */
export function buildMsbuildArgs(
	targetPath: string,
	configuration: string,
): string[] {
	return [targetPath, "/t:Build", `/p:Configuration=${configuration}`, "/nologo"];
}

export class BuildService {
	private current: ChildProcess | undefined;

	constructor(private readonly channel: vscode.OutputChannel) {}

	get isRunning(): boolean {
		return this.current !== undefined;
	}

	/**
	 * ビルドを実行し、終了コードを返す(シグナル終了・キャンセル時は null)。
	 * 実行中に再度呼んではならない(呼び出し側で isRunning を確認する)。
	 */
	run(
		msbuildPath: string,
		targetPath: string,
		configuration: string,
		encoding: string,
	): Promise<number | null> {
		const args = buildMsbuildArgs(targetPath, configuration);
		this.channel.appendLine("========================================");
		this.channel.appendLine(
			`[${new Date().toLocaleString()}] ビルド開始: "${msbuildPath}" ${args.join(" ")}`,
		);

		return new Promise<number | null>((resolve, reject) => {
			const child = spawn(msbuildPath, args, {
				cwd: path.dirname(targetPath),
				windowsHide: true,
			});
			this.current = child;

			// マルチバイト文字がチャンク境界で壊れないようストリームでデコードする
			for (const stream of [child.stdout, child.stderr]) {
				const decoder = iconv.decodeStream(encoding);
				stream.pipe(decoder);
				decoder.on("data", (text: string) => {
					this.channel.append(text);
				});
			}

			child.on("error", (error) => {
				this.current = undefined;
				reject(error);
			});
			child.on("close", (code, signal) => {
				this.current = undefined;
				this.channel.appendLine("");
				this.channel.appendLine(
					signal !== null
						? `ビルドを中断しました(${signal})`
						: `ビルド終了(exit code: ${code ?? "不明"})`,
				);
				resolve(code);
			});
		});
	}

	/** 実行中のビルドを子プロセスごと停止する */
	cancel(): void {
		const child = this.current;
		if (child === undefined || child.pid === undefined) {
			return;
		}
		if (process.platform === "win32") {
			// MSBuild は vbc 等の子プロセスを持つため taskkill /t でツリーごと止める
			spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
				windowsHide: true,
			});
		} else {
			child.kill();
		}
	}
}
