#!/usr/bin/env node
/**
 * tools/probe-fs.mjs —— 硬链接能力探测（自包含 ESM，零第三方依赖，Node >= 18）
 *
 * 背景：
 *   DSH 的 @deepseek-ai/dsh-fs-local 在「新建文件」路径上使用 fs.link 做 no-replace
 *   发布（writeFileAtomic + createIfAbsent）。exFAT/FAT 卷不支持硬链接，会导致
 *   「新建文件」直接失败。本脚本在 <root>\\tmp 下真实跑一次 link，给出本卷结论，
 *   并把结论缓存到 <root>\\tmp\\fs-capability.json，供 .cmd / 预检复用。
 *
 * 用法：
 *   node tools/probe-fs.mjs [--root <path>] [--quiet] [--json] [--help]
 *
 * 输出（stdout，单行 JSON，可被 .cmd 解析）：
 *   {"link":"ok"}
 *   {"link":"fail","code":"EISDIR","message":"..."}
 *
 * 退出码：任何情况下都是 0（探测失败是环境事实，不是命令失败）。
 *         结论看 stdout 的 JSON 或缓存文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
/** 默认 repo 根：tools/probe-fs.mjs 的上一级目录 */
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const CACHE_FILE_NAME = "fs-capability.json";

function printHelp() {
	console.log(`用法: node tools/probe-fs.mjs [选项]

硬链接能力探测：在 <root>\\\\tmp\\\\fs-probe-<随机> 下创建 a.txt，尝试
fs.linkSync(a.txt, b.txt)，随后清理临时文件，并把结论写入
<root>\\\\tmp\\\\fs-capability.json。

选项:
  --root <path>   指定 repo 根目录（默认：由脚本位置推导，即 tools 的上一级）
  --quiet         只写缓存文件，不打印探测结果
  --json          显式声明单行 JSON 输出（默认即输出单行 JSON，等效）
  -h, --help      显示本帮助

输出:
  成功: {"link":"ok"}
  失败: {"link":"fail","code":"<错误码>","message":"<错误信息>"}

退出码:
  永远为 0（探测失败不是命令失败）。失败时以 code 字段区分原因，
  例如 EISDIR（Windows 下 exFAT 不支持硬链接时 libuv 的实际返回）、
  ENOTSUP、EPERM、EACCES、EXDEV、ENOENT（--root 不存在）等。
`);
}

function parseArgs(argv) {
	const options = { rootRaw: undefined, quiet: false, json: false, help: false, unknown: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			options.help = true;
		} else if (arg === "--quiet") {
			options.quiet = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--root") {
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				options.unknown.push("--root 缺少路径参数");
			} else {
				options.rootRaw = next;
				i += 1;
			}
		} else if (arg.startsWith("--root=")) {
			options.rootRaw = arg.slice("--root=".length);
		} else {
			options.unknown.push(arg);
		}
	}
	return options;
}

function normalizeCode(error) {
	if (error && typeof error.code === "string" && error.code.length > 0) return error.code;
	return "UNKNOWN";
}

function errorMessage(error) {
	if (error && typeof error.message === "string") return error.message;
	return String(error);
}

/** <root> 的卷信息：Windows 盘符（如 "G:"）或 POSIX 根（如 "/"） */
function detectVolume(rootPath) {
	const parsed = path.parse(path.resolve(rootPath));
	const root = parsed.root || path.parse(path.resolve(".")).root;
	if (root.length > 1) return root.replace(/[\\\\/]+$/, "");
	return root;
}

/**
 * 真实探测一次 fs.linkSync。
 * @returns {{link:"ok"|"fail", code?:string, message?:string, probeDir:string}}
 */
function probeHardLink(rootPath) {
	const probeDir = path.join(rootPath, "tmp", `fs-probe-${randomBytes(4).toString("hex")}`);
	const result = { link: "ok", probeDir };
	try {
		fs.mkdirSync(probeDir, { recursive: true });
		const sourcePath = path.join(probeDir, "a.txt");
		const linkPath = path.join(probeDir, "b.txt");
		fs.writeFileSync(sourcePath, "h3rx hard-link probe\n", "utf8");
		try {
			fs.linkSync(sourcePath, linkPath);
		} catch (error) {
			result.link = "fail";
			result.code = normalizeCode(error);
			result.message = errorMessage(error);
		}
	} catch (error) {
		result.link = "fail";
		result.code = normalizeCode(error);
		result.message = errorMessage(error);
	} finally {
		// 清理：b.txt / a.txt / 探测目录（失败也无所谓，force + recursive）
		try {
			fs.rmSync(probeDir, { recursive: true, force: true });
		} catch {
			/* 清理失败不影响探测结论 */
		}
	}
	return result;
}

function buildCacheRecord(rootPath, volume, result, probeDir) {
	const record = {
		at: new Date().toISOString(),
		volume,
		link: result.link,
	};
	if (result.link !== "ok") {
		record.code = result.code;
		record.message = result.message;
	}
	record.root = rootPath;
	record.probeDir = probeDir;
	record.platform = process.platform;
	record.node = process.version;
	return record;
}

function writeCache(rootPath, record) {
	const cachePath = path.join(rootPath, "tmp", CACHE_FILE_NAME);
	try {
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		return { ok: true, cachePath };
	} catch (error) {
		return { ok: false, cachePath, code: normalizeCode(error), message: errorMessage(error) };
	}
}

function minimalOutput(result) {
	if (result.link === "ok") return { link: "ok" };
	return { link: "fail", code: result.code, message: result.message };
}

function main() {
	const options = parseArgs(process.argv.slice(2));

	if (options.help) {
		printHelp();
		return 0;
	}

	const warnings = [];
	if (options.unknown.length > 0) {
		warnings.push(`忽略未知参数: ${options.unknown.join(", ")}`);
	}

	const rootPath = path.resolve(process.cwd(), options.rootRaw ?? DEFAULT_ROOT);
	let rootStat = null;
	try {
		rootStat = fs.statSync(rootPath);
	} catch (error) {
		warnings.push(`根目录不可用 (${rootPath}): ${normalizeCode(error)} ${errorMessage(error)}`);
	}

	let result;
	const volume = detectVolume(rootPath);
	let probeDir = path.join(rootPath, "tmp", "fs-probe-unavailable");
	if (rootStat && rootStat.isDirectory()) {
		result = probeHardLink(rootPath);
		probeDir = result.probeDir;
	} else {
		result = { link: "fail", code: "ENOENT", message: `root is not a directory: ${rootPath}` };
	}

	const cache = writeCache(rootPath, buildCacheRecord(rootPath, volume, result, probeDir));
	if (!cache.ok && options.quiet === false) {
		warnings.push(`缓存写入失败 (${cache.cachePath}): ${cache.code} ${cache.message}`);
	}

	if (!options.quiet) {
		for (const warning of warnings) process.stderr.write(`probe-fs: ${warning}\n`);
		process.stdout.write(`${JSON.stringify(minimalOutput(result))}\n`);
	}
	return 0;
}

// 铁律：探测脚本任何情况下 exit 0。
try {
	process.exitCode = main();
} catch (error) {
	try {
		process.stdout.write(`${JSON.stringify({ link: "fail", code: normalizeCode(error), message: errorMessage(error) })}\n`);
	} catch {
		/* stdout 都写不出去时也无计可施，仍然 0 退出 */
	}
	process.exitCode = 0;
}
