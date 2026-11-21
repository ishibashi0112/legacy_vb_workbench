/**
 * ビルド済み EXE の起動と監視(Visual Studio の「デバッグなしで開始」相当)。
 *
 * - デバッガーは接続しない。代わりに標準出力・標準エラー・終了コードを
 *   Output「Legacy VB Run」へ記録する
 * - 異常終了時は Windows イベントログから .NET の未処理例外
 *   (例外の型とスタックトレース)を取得して表示する
 * - 起動中のプロセスを覚えておき、再ビルド前に終了できるようにする
 *   (起動中の EXE はロックされ、ビルドの上書きコピーが失敗するため)
 */

import { type ChildProcess, execFile, spawn } from "child_process";
import * as path from "path";
import type * as vscode from "vscode";
import { BuildOutputDecoder } from "./buildService";
import {
	buildCrashEventQueryScript,
	buildSpawnInvocation,
	describeExitCode,
	encodePowerShellCommand,
	type ExitCodeDescription,
	type LaunchPlan,
} from "./runSettings";

export interface RunExit {
	/** シグナル終了(強制終了)時は null */
	exitCode: number | null;
	description?: ExitCodeDescription;
	/** 異常終了時にイベントログから取れたクラッシュ情報 */
	crashEvents?: string;
}

export interface LaunchedApp {
	pid: number | undefined;
	exited: Promise<RunExit>;
}

export class RunService {
	private readonly running = new Set<ChildProcess>();

	constructor(private readonly channel: vscode.OutputChannel) {}

	get runningCount(): number {
		return this.running.size;
	}

	/** EXE を起動する。起動失敗(ENOENT 等)は exited が reject される */
	launch(plan: LaunchPlan): LaunchedApp {
		const invocation = buildSpawnInvocation(plan);
		const startedAt = Date.now();
		this.channel.appendLine("========================================");
		this.channel.appendLine(`[${new Date().toLocaleString()}] 起動: ${plan.exePath}`);
		this.channel.appendLine(`  引数: ${plan.argumentsLine === "" ? "(なし)" : plan.argumentsLine}`);
		this.channel.appendLine(
			`  コマンドライン: ${[invocation.argv0, ...invocation.args].join(" ")}`,
		);
		this.channel.appendLine(`  作業ディレクトリ: ${plan.workingDirectory}`);
		for (const note of plan.notes) {
			this.channel.appendLine(`  ※ ${note}`);
		}

		const child = spawn(invocation.command, invocation.args, {
			cwd: plan.workingDirectory,
			argv0: invocation.argv0,
			windowsVerbatimArguments: true,
			windowsHide: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.running.add(child);
		const label = path.basename(plan.exePath);
		if (child.pid !== undefined) {
			this.channel.appendLine(`  PID: ${child.pid}`);
		}

		const streams: Array<{ stream: NodeJS.ReadableStream; prefix: string }> = [
			{ stream: child.stdout, prefix: "" },
			{ stream: child.stderr, prefix: "[stderr] " },
		];
		const decoders = streams.map(({ stream, prefix }) => {
			// WinForms アプリの Console 出力は既定で ANSI(日本語環境は CP932)
			const decoder = new BuildOutputDecoder("auto");
			stream.on("data", (chunk: Buffer) => {
				this.appendPrefixed(decoder.push(chunk), prefix);
			});
			return { decoder, prefix };
		});

		const exited = new Promise<RunExit>((resolve, reject) => {
			child.on("error", (error) => {
				this.running.delete(child);
				this.channel.appendLine(`起動に失敗しました: ${error.message}`);
				reject(error);
			});
			child.on("close", (code, signal) => {
				this.running.delete(child);
				for (const { decoder, prefix } of decoders) {
					this.appendPrefixed(decoder.flush(), prefix);
				}
				const elapsedSeconds = (Date.now() - startedAt) / 1000;
				if (code === null) {
					this.channel.appendLine(
						`[${new Date().toLocaleString()}] ${label} を終了させました(${signal ?? "強制終了"}、実行時間 ${elapsedSeconds.toFixed(1)} 秒)`,
					);
					resolve({ exitCode: null });
					return;
				}
				const description = describeExitCode(code);
				this.channel.appendLine(
					`[${new Date().toLocaleString()}] ${label} が終了しました(exit code: ${code >>> 0} / ${description.hex}` +
						`${description.meaning === undefined ? "" : `: ${description.meaning}`}、実行時間 ${elapsedSeconds.toFixed(1)} 秒)`,
				);
				if (!description.abnormal) {
					resolve({ exitCode: code, description });
					return;
				}
				void this.queryCrashEvents(label, elapsedSeconds + 30).then((crashEvents) => {
					if (crashEvents !== undefined) {
						this.channel.appendLine("--- Windows イベントログ(Application)のクラッシュ情報 ---");
						this.channel.appendLine(crashEvents.trimEnd());
					} else {
						this.channel.appendLine(
							"(イベントログにこのアプリのクラッシュ記録は見つかりませんでした)",
						);
					}
					this.channel.appendLine("");
					resolve({ exitCode: code, description, crashEvents });
				});
			});
		});
		// close 前に誰も待っていなくても未処理 reject にしない
		exited.catch(() => undefined);
		return { pid: child.pid, exited };
	}

	/** 起動中のアプリをすべて強制終了し、終了を待つ */
	async killAll(): Promise<void> {
		const children = [...this.running];
		await Promise.all(
			children.map(
				(child) =>
					new Promise<void>((resolve) => {
						if (child.exitCode !== null || child.pid === undefined) {
							resolve();
							return;
						}
						child.once("close", () => resolve());
						if (process.platform === "win32") {
							spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
								windowsHide: true,
							});
						} else {
							child.kill();
						}
					}),
			),
		);
	}

	private appendPrefixed(text: string, prefix: string): void {
		if (text === "") {
			return;
		}
		if (prefix === "") {
			this.channel.append(text);
			return;
		}
		const lines = text.split(/(?<=\n)/);
		this.channel.append(lines.map((line) => `${prefix}${line}`).join(""));
	}

	/** イベントログから直近のクラッシュ情報を取る(取れなければ undefined) */
	private queryCrashEvents(
		exeFileName: string,
		secondsAgo: number,
	): Promise<string | undefined> {
		if (process.platform !== "win32") {
			return Promise.resolve(undefined);
		}
		const script = buildCrashEventQueryScript(exeFileName, secondsAgo);
		return new Promise((resolve) => {
			// WER の Application Error は終了直後に書かれることがあるため少し待つ
			setTimeout(() => {
				execFile(
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-EncodedCommand",
						encodePowerShellCommand(script),
					],
					{ windowsHide: true, encoding: "utf8", timeout: 20000 },
					(_error, stdout) => {
						const text = typeof stdout === "string" ? stdout.replace(/^﻿/, "") : "";
						resolve(text.trim() === "" ? undefined : text);
					},
				);
			}, 1500);
		});
	}
}
