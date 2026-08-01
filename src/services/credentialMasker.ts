/**
 * 認証情報の自動マスク(Repomix エクスポート用)。
 *
 * 実業務プロジェクトのソースにハードコードされた DB 認証情報が
 * エクスポートへそのまま含まれた事例を受けて導入。
 *
 * 方針:
 * - 「秘密の値そのもの(文字列リテラル)」だけを [MASKED] に置換する。
 *   値が変数・式の場合は秘密情報を含まないため触らない(コードを壊さない)
 * - マスクした箇所は行番号・種類付きで findings に記録し、
 *   出力側で明示する(黙って書き換えない)
 * - vscode 非依存の純粋ロジック(単体テスト対象)
 */

export interface MaskFinding {
	/** 1 始まりの行番号(置換前テキスト基準の近似値) */
	line: number;
	/** 種類(パスワード / ユーザーID / APIキー・トークン / 秘密鍵) */
	kind: string;
}

export interface MaskResult {
	content: string;
	findings: MaskFinding[];
}

export interface MaskOptions {
	/** VB ソース(.vb)として文字列リテラル単位で処理するか */
	vbSource: boolean;
}

const MASK = "[MASKED]";

const KIND_PASSWORD = "パスワード";
const KIND_USER = "ユーザーID";
const KIND_TOKEN = "APIキー/トークン";
const KIND_PRIVATE_KEY = "秘密鍵";

/** パスワード・秘密系とみなす変数名/キー名のヒント(日本語識別子対応) */
const SECRET_NAME_HINT =
	/pass(?:word)?|passwd|pswd|pwd|secret|credential|api[_-]?key|apikey|access[_-]?key|accesskey|secret[_-]?key|secretkey|token|パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証/i;

/** ユーザーID系とみなす変数名のヒント(VB の代入リテラル用) */
const USER_NAME_HINT = /user|uid|account|login|ユーザ|ﾕｰｻﾞ|アカウント/i;

/**
 * VB 識別子の文字クラス(日本語識別子対応)。
 * ひらがな・カタカナ・CJK 漢字・半角カナ・全角英数を含める。
 * `.` は Me.txtPassword.Text のようなメンバーアクセス用(先頭以外)
 */
const IDENT_HEAD =
	"A-Za-z_\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF66-\\uFF9F\\uFF21-\\uFF3A\\uFF41-\\uFF5A";
const IDENT_BODY = `${IDENT_HEAD}0-9.\\uFF10-\\uFF19`;

/**
 * 接続文字列・設定のキー=値(パスワード系)。
 * 値は ; " & < > 改行 まで(接続文字列のセパレータで停止)
 */
const CONNSTR_SECRET =
	/\b(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token)(\s*=\s*)([^;"&<>\r\n:][^;"&<>\r\n]*)/gi;

/** 接続文字列のユーザー系キー(User ID / UID など明確なもののみ)。
 *  値の先頭 : は SQL バインド変数(UID = :UID 等)のため対象外 */
const CONNSTR_USER =
	/\b(user\s*id|userid|username|uid)(\s*=\s*)([^;"&<>\r\n:][^;"&<>\r\n]*)/gi;

/**
 * 日本語キー=値(設定ファイル・接続文字列・リテラル内)。
 * `\b` は非 ASCII に効かないため ASCII キーとは別パターンにする。
 * `=` のほか全角 `=` も対象。`:` は UI ラベル文言("パスワード: 8文字以上"等)
 * との誤爆が多いため対象外
 */
const JP_KEY_SECRET =
	/(パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号)(\s*[==]\s*)([^;"&<>\r\n\s][^;"&<>\r\n]*)/g;
const JP_KEY_USER =
	/(ユーザー?(?:ID|ID|名)|ﾕｰｻﾞｰ?ID|アカウント(?:ID|ID|名)?)(\s*[==]\s*)([^;"&<>\r\n\s][^;"&<>\r\n]*)/g;

/** XML 属性形式: password="..." など(非 VB ファイル用) */
const ATTR_SECRET =
	/\b(password|passwd|pswd|pwd|pass|secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token|user\s*id|userid|username|uid)(\s*=\s*")([^"]+)(")/gi;

/** XML 属性形式の日本語キー: パスワード="..." など(非 VB ファイル用) */
const JP_ATTR_SECRET =
	/(パスワード|ﾊﾟｽﾜｰﾄﾞ|暗証番号|ユーザー?(?:ID|ID|名)|ﾕｰｻﾞｰ?ID)(\s*[==]\s*")([^"]+)(")/g;

/**
 * 直前のコードが「変数 = 」で終わっているか(行継続 `_` 対応)。
 * 文字列リテラルの直前コンテキスト判定に使う
 */
const ASSIGNMENT_TAIL = new RegExp(
	`([${IDENT_HEAD}][${IDENT_BODY}]*)\\s*(?:As\\s+String\\s*)?=\\s*(?:_\\s*)?$`,
);

/** コメント内のコメントアウトされた代入('wk_Pswd = "x" など) */
const COMMENT_ASSIGN = new RegExp(
	`([${IDENT_HEAD}][${IDENT_BODY}]*)(\\s*=\\s*")([^"\\r\\n]+)(")`,
	"g",
);

/** 汎用シークレット形式(ファイル種別によらず適用) */
const TOKEN_PATTERNS: ReadonlyArray<{ kind: string; regex: RegExp }> = [
	{ kind: KIND_TOKEN, regex: /\bAKIA[0-9A-Z]{16}\b/g },
	{ kind: KIND_TOKEN, regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
	{ kind: KIND_TOKEN, regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{
		kind: KIND_TOKEN,
		regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	},
];

/** Bearer トークン(bearer という語は残しトークン部のみマスク) */
const BEARER_TOKEN = /\b(bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi;

/** PRIVATE KEY ブロック(BEGIN/END 行は残し中身をマスク) */
const PRIVATE_KEY_BLOCK =
	/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]+?(-----END [A-Z ]*PRIVATE KEY-----)/g;

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) {
		if (text.charCodeAt(i) === 0x0a) {
			line += 1;
		}
	}
	return line;
}

/** 接続文字列キー=値のマスク(テキスト断片に適用)。offsetBase は行番号計算用 */
function maskConnstrText(
	text: string,
	findings: MaskFinding[],
	toLine: (indexInText: number) => number,
): string {
	let result = text.replace(
		CONNSTR_SECRET,
		(whole, key: string, eq: string, _value: string, offset: number) => {
			findings.push({ line: toLine(offset), kind: KIND_PASSWORD });
			return `${key}${eq}${MASK}`;
		},
	);
	result = result.replace(
		CONNSTR_USER,
		(whole, key: string, eq: string, _value: string, offset: number) => {
			findings.push({ line: toLine(offset), kind: KIND_USER });
			return `${key}${eq}${MASK}`;
		},
	);
	result = result.replace(
		JP_KEY_SECRET,
		(whole, key: string, eq: string, _value: string, offset: number) => {
			findings.push({ line: toLine(offset), kind: KIND_PASSWORD });
			return `${key}${eq}${MASK}`;
		},
	);
	result = result.replace(
		JP_KEY_USER,
		(whole, key: string, eq: string, _value: string, offset: number) => {
			findings.push({ line: toLine(offset), kind: KIND_USER });
			return `${key}${eq}${MASK}`;
		},
	);
	return result;
}

/** 変数名のヒントからマスク種別を決める(該当なしは undefined) */
function kindForIdentifier(identifier: string): string | undefined {
	if (SECRET_NAME_HINT.test(identifier)) {
		return KIND_PASSWORD;
	}
	if (USER_NAME_HINT.test(identifier)) {
		return KIND_USER;
	}
	return undefined;
}

/** コメント内のマスク(コメントアウトされた認証情報コードも対象にする) */
function maskCommentText(
	comment: string,
	findings: MaskFinding[],
	line: number,
): string {
	let result = comment.replace(
		COMMENT_ASSIGN,
		(whole, identifier: string, assign: string, _value: string, close: string) => {
			const kind = kindForIdentifier(identifier);
			if (kind === undefined) {
				return whole;
			}
			findings.push({ line, kind });
			return `${identifier}${assign}${MASK}${close}`;
		},
	);
	result = maskConnstrText(result, findings, () => line);
	return result;
}

/**
 * VB ソースのマスク。
 * 正規表現の一発置換だとリテラル連結("Password=" & 変数 など)をまたいで
 * 誤マスクするため、コード/文字列リテラル/コメントを区別して走査する。
 * - 「秘密系変数 = "リテラル"」→ リテラル全体をマスク
 * - それ以外のリテラル → 内部の接続文字列キー(PWD=xxx 等)のみマスク
 * - コメント → コメントアウトされた代入・接続文字列もマスク
 */
function maskVbSource(content: string, findings: MaskFinding[]): string {
	let out = "";
	let i = 0;
	const n = content.length;

	while (i < n) {
		const ch = content[i];

		if (ch === '"') {
			// 文字列リテラルを読み取る("" は " のエスケープ。行内で閉じる前提)
			let j = i + 1;
			let inner = "";
			while (j < n) {
				if (content[j] === '"') {
					if (content[j + 1] === '"') {
						inner += '""';
						j += 2;
						continue;
					}
					break;
				}
				if (content[j] === "\n" || content[j] === "\r") {
					break;
				}
				inner += content[j];
				j += 1;
			}
			const closed = j < n && content[j] === '"';

			// 直前のコードが「秘密系変数 = 」ならリテラル全体をマスク
			const assignMatch = ASSIGNMENT_TAIL.exec(out.slice(-200));
			const kind =
				closed && inner.trim() !== "" && assignMatch !== null
					? kindForIdentifier(assignMatch[1])
					: undefined;
			if (kind !== undefined) {
				findings.push({ line: lineOf(content, i), kind });
				out += `"${MASK}"`;
				i = j + 1;
				continue;
			}

			// それ以外は接続文字列キーのみマスク
			const maskedInner = maskConnstrText(inner, findings, () =>
				lineOf(content, i),
			);
			out += `"${maskedInner}${closed ? '"' : ""}`;
			i = closed ? j + 1 : j;
			continue;
		}

		if (ch === "'") {
			// コメント: 行末まで
			let j = i;
			while (j < n && content[j] !== "\n") {
				j += 1;
			}
			out += maskCommentText(content.slice(i, j), findings, lineOf(content, i));
			i = j;
			continue;
		}

		out += ch;
		i += 1;
	}
	return out;
}

/** 非 VB ファイル(config / XML / テキスト等)のマスク */
function maskGenericText(content: string, findings: MaskFinding[]): string {
	// XML 属性形式(値が引用符で囲まれるため接続文字列パターンでは拾えない)
	let result = content.replace(
		ATTR_SECRET,
		(whole, key: string, eq: string, _value: string, closeQuote: string, offset: number) => {
			const kind = /user|uid/i.test(key) ? KIND_USER : KIND_PASSWORD;
			findings.push({ line: lineOf(content, offset), kind });
			return `${key}${eq}${MASK}${closeQuote}`;
		},
	);
	result = result.replace(
		JP_ATTR_SECRET,
		(whole, key: string, eq: string, _value: string, closeQuote: string, offset: number) => {
			const kind = /ユーザ|ﾕｰｻﾞ/.test(key) ? KIND_USER : KIND_PASSWORD;
			findings.push({ line: lineOf(result, offset), kind });
			return `${key}${eq}${MASK}${closeQuote}`;
		},
	);
	result = maskConnstrText(result, findings, (index) => lineOf(result, index));
	return result;
}

/**
 * 認証情報らしき値を [MASKED] に置換し、置換箇所の一覧を返す。
 */
export function maskCredentials(content: string, options: MaskOptions): MaskResult {
	const findings: MaskFinding[] = [];
	let result = options.vbSource
		? maskVbSource(content, findings)
		: maskGenericText(content, findings);

	// ファイル種別によらない汎用シークレット形式
	result = result.replace(
		PRIVATE_KEY_BLOCK,
		(whole, begin: string, end: string, offset: number) => {
			findings.push({ line: lineOf(result, offset), kind: KIND_PRIVATE_KEY });
			return `${begin}\n${MASK}\n${end}`;
		},
	);
	for (const pattern of TOKEN_PATTERNS) {
		result = result.replace(pattern.regex, (whole, ...args: unknown[]) => {
			const offset = args[args.length - 2];
			findings.push({
				line: typeof offset === "number" ? lineOf(result, offset) : 1,
				kind: pattern.kind,
			});
			return MASK;
		});
	}
	result = result.replace(
		BEARER_TOKEN,
		(whole, prefix: string, _token: string, offset: number) => {
			findings.push({ line: lineOf(result, offset), kind: KIND_TOKEN });
			return `${prefix}${MASK}`;
		},
	);

	return { content: result, findings };
}
