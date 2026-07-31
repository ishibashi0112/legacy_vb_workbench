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

/** ビルド出力エンコーディングの設定値 */
export type BuildOutputEncoding = "auto" | "cp932" | "utf8";

/**
 * ビルド出力のデコーダー。
 * "auto" は最初に非 ASCII を含む行で UTF-8 / CP932 を自動判定する
 * (MSBuild 12.0(VS2013)は CP932、MSBuild 17/18(VS2022/2026)は UTF-8 で
 * 出力するため、固定値ではどちらかの環境で文字化けする)。
 * マルチバイト文字がチャンク境界で壊れないよう、改行までバッファして
 * 行単位でデコードする。
 */
export class BuildOutputDecoder {
	private pending: Buffer = Buffer.alloc(0);
	private detected: "cp932" | "utf8" | undefined;

	constructor(encoding: BuildOutputEncoding) {
		if (encoding !== "auto") {
			this.detected = encoding;
		}
	}

	/** チャンクを取り込み、完成した行までをデコードして返す */
	push(chunk: Buffer): string {
		this.pending = Buffer.concat([this.pending, chunk]);
		const lastNewline = this.pending.lastIndexOf(0x0a);
		if (lastNewline < 0) {
			return "";
		}
		const complete = this.pending.subarray(0, lastNewline + 1);
		this.pending = Buffer.from(this.pending.subarray(lastNewline + 1));
		return this.decode(complete);
	}

	/** 残りのバッファをデコードして返す(プロセス終了時に呼ぶ) */
	flush(): string {
		if (this.pending.length === 0) {
			return "";
		}
		const rest = this.pending;
		this.pending = Buffer.alloc(0);
		return this.decode(rest);
	}

	private decode(bytes: Buffer): string {
		if (this.detected === undefined) {
			if (!bytes.some((byte) => byte >= 0x80)) {
				// ASCII のみの間はどちらのエンコーディングでも同じなので判定を保留する
				return bytes.toString("utf8");
			}
			// UTF-8 として往復可能なら UTF-8、壊れるなら CP932 と判定する
			const asUtf8 = bytes.toString("utf8");
			this.detected = Buffer.from(asUtf8, "utf8").equals(bytes) ? "utf8" : "cp932";
		}
		return iconv.decode(bytes, this.detected);
	}
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
		encoding: BuildOutputEncoding,
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

			const decoders = [child.stdout, child.stderr].map((stream) => {
				const decoder = new BuildOutputDecoder(encoding);
				stream.on("data", (chunk: Buffer) => {
					this.channel.append(decoder.push(chunk));
				});
				return decoder;
			});

			child.on("error", (error) => {
				this.current = undefined;
				reject(error);
			});
			child.on("close", (code, signal) => {
				this.current = undefined;
				for (const decoder of decoders) {
					this.channel.append(decoder.flush());
				}
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
