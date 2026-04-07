import * as vscode from 'vscode';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { URL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { showCommitPreview } from './commitPreview';

const execFileAsync = promisify(execFile);

// --- OAuth token cache (persisted in globalState) -------------------------

interface TokenRecord {
	token: string;
	expiresAt: number; // ms since epoch
	scope?: string;
	authUrl?: string;
	authKeyFingerprint?: string;
}

const TOKEN_STORAGE_KEY = 'gigachat.tokenRecord';
const TOKEN_REFRESH_BUFFER = 30_000; // 30 s before hard expiry

function loadToken(state: vscode.Memento): TokenRecord | null {
	return state.get<TokenRecord | null>(TOKEN_STORAGE_KEY, null);
}

async function saveToken(state: vscode.Memento, record: TokenRecord) {
	await state.update(TOKEN_STORAGE_KEY, record);
}

async function clearToken(state: vscode.Memento) {
	await state.update(TOKEN_STORAGE_KEY, undefined);
}

function getAuthKeyFingerprint(authorizationKey: string): string {
	return createHash('sha256').update(authorizationKey).digest('hex');
}

// --- HTTP helpers ---------------------------------------------------------

interface HttpResult {
	status: number;
	body: string;
}

function httpRequest(url: URL, options: https.RequestOptions, body?: string): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = https.request({
			hostname: url.hostname,
			port: Number(url.port) || 443,
			path: url.pathname + url.search,
			method: options.method ?? 'GET',
			headers: options.headers,
			ca: options.ca,
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString() }));
		});
		req.on('error', reject);
		if (body) {
			req.write(body);
		}
		req.end();
	});
}

function loadCaBundle(caBundlePath: string | undefined): Buffer[] | undefined {
	if (!caBundlePath) {
		return undefined;
	}
	try {
		return [fs.readFileSync(caBundlePath)];
	} catch {
		return undefined;
	}
}

// --- API error handling ---------------------------------------------------

/**
 * Parsed details extracted from the API error response.
 */
interface ApiErrorInfo {
	/** Short user-facing reason, e.g. "Invalid model", "Rate limited" */
	shortReason: string;
	/** Full detail to show in the error message */
	detail: string;
	/** true if the error is a 401 that should trigger token refresh + retry */
	isRetryable401: boolean;
}

interface ExtractedApiErrorBody {
	errorMessage: string;
	errorCode?: number;
	raw?: object;
}

function parseApiError(status: number, rawBody: string, context: 'auth' | 'chat'): ApiErrorInfo {
	const body = extractErrorBody(rawBody);

	let detail = '';

	// --- Status-specific messages ---
	switch (status) {
		case 400:
			if (context === 'auth') {
				detail = body.errorCode === 7
					? 'Failed to obtain OAuth token — selected scope does not match the authorization key'
					: 'Failed to obtain OAuth token';
			} else {
				detail = 'Bad request';
			}
			break;
		case 401:
			detail = 'Unauthorized — token is invalid or expired';
			break;
		case 403:
			if (context === 'auth') {
				detail = 'Access denied — check your authorization key and scope';
			} else {
				detail = 'Forbidden — your token may lack access to this model';
			}
			break;
		case 404:
			if (context === 'chat') {
				detail = 'Model or endpoint not found — check the model name and API base URL';
			} else {
				detail = 'Not found';
			}
			break;
		case 422:
			detail = 'Unprocessable entity — check request parameters (model, messages format)';
			break;
		case 429:
			detail = 'Rate limited — too many requests, please wait and try again';
			break;
		case 500:
			detail = 'Internal server error — GigaChat service may be unavailable';
			break;
		case 502:
		case 503:
			detail = 'Service temporarily unavailable — GigaChat may be down or under maintenance';
			break;
		default:
			detail = `HTTP ${status}`;
	}

	// Append server-provided details
	if (body.errorMessage) {
		detail += ` — ${body.errorMessage}`;
	}

	if (context === 'auth' && body.errorCode === 7) {
		detail += ' — set `gigacommit.scope` to the same access type that is enabled for this key in the Sber GigaChat developer portal (PERS / B2B / CORP)';
	}

	return {
		shortReason: detail,
		detail,
		isRetryable401: status === 401,
	};
}

/**
 * Try to extract a user-friendly error message from the API response body.
 * Supports multiple error envelope formats that GigaChat may return.
 */
function extractErrorBody(raw: string): ExtractedApiErrorBody {
	const result: ExtractedApiErrorBody = { errorMessage: '' };
	try {
		const obj = JSON.parse(raw) as { [key: string]: unknown };
		result.raw = obj;
		if (typeof obj['code'] === 'number') {
			result.errorCode = obj['code'];
		}

		// Format 1: { "description": "..." } — Sber token endpoint
		if (typeof obj['description'] === 'string' && obj['description']) {
			result.errorMessage = obj['description'];
			return result;
		}

		// Format 2: { "error": { "message": "..." } } — OpenAI-compatible
		const nestedError = obj['error'];
		if (
			nestedError &&
			typeof nestedError === 'object' &&
			'message' in nestedError &&
			typeof nestedError.message === 'string'
		) {
			result.errorMessage = nestedError.message;
			return result;
		}

		// Format 3: { "message": "..." } — flat error
		if (typeof obj['message'] === 'string' && obj['message']) {
			result.errorMessage = obj['message'];
			return result;
		}

		// Format 4: { "detail": "..." } — FastAPI-style
		if (typeof obj['detail'] === 'string' && obj['detail']) {
			result.errorMessage = obj['detail'];
			return result;
		}

		// If JSON parsed but no known field, dump the whole thing as context
		result.errorMessage = `Response: ${truncateForLog(JSON.stringify(obj), 200)}`;
	} catch {
		// Not JSON — just show raw text (truncated)
		result.errorMessage = truncateForLog(raw, 200);
	}
	return result;
}

/**
 * Format a user-ready error message. For non-500 errors, shows the detail
 * and logs full body for debugging. For 500s, also suggests retry.
 */
function formatApiErrorMessage(errorInfo: ApiErrorInfo, status: number, rawBody: string, context: string): { message: string; logBody: boolean } {
	const { detail } = errorInfo;

	// Log full response for debugging (no secrets — we log status + detail only)
	console.error(
		`[${context} error] ${status}: ${detail}\n` +
		`Response: ${truncateForLog(rawBody, 500)}`
	);

	let userMsg = `${detail}`;

	if (status >= 500) {
		userMsg += ' — please try again later';
	}

	return { message: userMsg, logBody: true };
}

function truncateForLog(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	// Redact potential secrets before truncation — remove anything that looks like a base64 key
	let sanitized = text.replace(/"Authorization"[:\s]+"[^"]+"/g, '"Authorization": "[redacted]"');
	if (sanitized.length > maxLen) {
		sanitized = sanitized.substring(0, maxLen) + '...';
	}
	return sanitized;
}

// --- Diagnostic / network error handling ----------------------------------

/**
 * Detect whether a request error is likely caused by certificate / TLS issues.
 * Returns a user-friendly explanation, or null if the error is unrelated.
 */
function diagnoseNetworkError(err: Error): string | null {
	const msg = err.message || '';
	const code = (err as NodeJS.ErrnoException).code ?? '';

	// Known OpenSSL / TLS error codes (Node.js err codes)
	const TLS_ERROR_CODES = [
		'DEPTH_ZERO_SELF_SIGNED_CERT',
		'SELF_SIGNED_CERT_IN_CHAIN',
		'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		'CERT_HAS_EXPIRED',
		'CERT_NOT_YET_VALID',
		'CERT_UNTRUSTED',
		'CERT_CHAIN',
		'EPROTO',
		'ETIMEDOUT',
		'ECONNRESET',
	];

	// OpenSSL error message fragments that indicate certificate issues
	const TLS_ERROR_PATTERNS = [
		'SSLV3_ALERT_HANDSHAKE_FAILURE',
		'sslv3 alert handshake failure',
		'ssl handshake failure',
		'clock skew',
		'certificate verify failed',
		'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		'DEPTH_ZERO_SELF_SIGNED_CERT',
		'OPENSSL_internal',
	];

	if (TLS_ERROR_CODES.includes(code)) {
		return buildTlsHelpMessage(code);
	}

	for (const pattern of TLS_ERROR_PATTERNS) {
		if (msg.includes(pattern)) {
			return buildTlsHelpMessage(code || pattern);
		}
	}

	return null;
}

function buildTlsHelpMessage(detail: string): string {
	const tlsHelp = [
		'This looks like a TLS / certificate trust issue. GigaChat API (Sber) uses certificates issued by the Russian National CA (НУЦ Минцифры).',
		'',
		'Possible causes and solutions:',
		'  1. The НУЦ Минцифры root certificate is not installed on your system.',
		'     On macOS, macOS should trust it by default if "Russian Trusted Root CA" is in the Keychain.',
		'     On Linux, install it to your system certificate store (e.g., /usr/local/share/ca-certificates/).',
		'  2. Your corporate proxy or firewall is intercepting HTTPS traffic.',
		'     Configure the "GigaCommit: CA Bundle Path" setting to point to your proxy\'s root certificate PEM file.',
		'  3. The server certificate has expired or is revoked.',
		'     Check https://developers.sber.ru for any API maintenance notices.',
		'',
		'Technical detail: ' + detail,
	].join('\n');

	return tlsHelp;
}

// --- GigaChat OAuth -------------------------------------------------------

interface GigaTokenResponse {
	access_token: string;
	expires_at: number;
	scope: string;
}

/**
 * Prepare the Basic auth header value.
 * If the key looks like `ClientID:ClientSecret` (contains a literal colon
 * and is NOT already valid Base64), encode it. Otherwise pass through.
 */
function toBasicAuthHeader(key: string): string {
	// Already valid Base64 (ASCII chars, optionally trailing =, no colons)
	if (!key.includes(':') && /^[A-Za-z0-9+/=]+$/.test(key)) {
		return 'Basic ' + key;
	}
	// Looks like raw credential string — encode it
	return 'Basic ' + Buffer.from(key).toString('base64');
}

async function fetchAccessToken(
	authUrl: string,
	authorizationKey: string,
	scope: string,
	ca: Buffer[] | undefined
): Promise<TokenRecord> {
	const url = new URL(authUrl);
	const rqUid = randomUUID();

	const { status, body } = await httpRequest(url, {
		method: 'POST',
		headers: {
			'Authorization': toBasicAuthHeader(authorizationKey),
			'RqUID': rqUid,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		ca,
	}, `scope=${encodeURIComponent(scope)}`);

	if (status >= 400) {
		const info = parseApiError(status, body, 'auth');
		const formatted = formatApiErrorMessage(info, status, body, 'OAuth');
		throw new Error(`Token request failed: ${formatted.message}`);
	}

	try {
		const data: GigaTokenResponse = JSON.parse(body);
		if (!data.access_token) {
			throw new Error('Token response missing access_token');
		}
		return {
			token: data.access_token,
			expiresAt: (data.expires_at ?? Date.now() / 1000 + 1800) * 1000,
		};
	} catch (e: any) {
		if (e.message.startsWith('Token')) throw e;
		throw new Error(`Failed to parse token response: ${body}`);
	}
}

/** Return a valid access token, reusing cached if not expired. */
async function getValidAccessToken(
	state: vscode.Memento,
	authUrl: string,
	authorizationKey: string,
	scope: string,
	ca: Buffer[] | undefined
): Promise<string> {
	const cached = loadToken(state);
	const authKeyFingerprint = getAuthKeyFingerprint(authorizationKey);
	const isReusableToken = cached &&
		cached.scope === scope &&
		cached.authUrl === authUrl &&
		cached.authKeyFingerprint === authKeyFingerprint &&
		Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER;

	if (isReusableToken) {
		return cached.token;
	}
	const record = await fetchAccessToken(authUrl, authorizationKey, scope, ca);
	await saveToken(state, {
		...record,
		scope,
		authUrl,
		authKeyFingerprint,
	});
	return record.token;
}

/** Clear cached token — used when server returns 401. */
async function invalidateToken(state: vscode.Memento) {
	await clearToken(state);
}

// --- Chat completions -----------------------------------------------------

type CommitLanguage = 'English' | 'Russian';

interface GitLikeResourceState {
	uri?: vscode.Uri;
	resourceUri?: vscode.Uri;
	renameUri?: vscode.Uri;
}

interface GitRepositoryLike {
	rootUri?: vscode.Uri;
}

interface StagedFileAnalysis {
	filePath: string;
	status: string;
	category: 'source' | 'package' | 'lockfile' | 'docs' | 'test' | 'ci' | 'other';
	block: string;
}

function getResourcePath(resource: GitLikeResourceState): string {
	const primaryUri = resource.uri ?? resource.resourceUri;
	return primaryUri ? vscode.workspace.asRelativePath(primaryUri, false) : '(unknown file)';
}

function describeStagedFiles(stagedFiles: readonly GitLikeResourceState[]): string {
	return stagedFiles
		.map((file) => {
			const fromPath = getResourcePath(file);
			const toPath = file.renameUri ? vscode.workspace.asRelativePath(file.renameUri, false) : undefined;
			return toPath ? `- ${fromPath} -> ${toPath}` : `- ${fromPath}`;
		})
		.join('\n');
}

function trimBlocksPreservingCoverage(
	blocks: string[],
	maxSize: number,
	truncationNotice: string,
	itemTruncationNotice: string,
): string {
	const normalizedBlocks = blocks
		.map((block) => block.trim())
		.filter((block) => block.length > 0);

	if (normalizedBlocks.length === 0) {
		return '';
	}

	const fullText = normalizedBlocks.join('\n\n');
	if (fullText.length <= maxSize) {
		return fullText;
	}

	if (normalizedBlocks.length === 1) {
		const sliceSize = Math.max(0, maxSize - truncationNotice.length);
		return `${normalizedBlocks[0].slice(0, sliceSize).trimEnd()}${truncationNotice}`;
	}

	const budget = Math.max(0, maxSize - truncationNotice.length);
	const initialSliceSize = Math.max(250, Math.min(1200, Math.floor(budget / normalizedBlocks.length)));
	const growthChunkSize = 300;
	const slices = new Array<number>(normalizedBlocks.length).fill(0);

	let remainingBudget = budget;
	for (let index = 0; index < normalizedBlocks.length && remainingBudget > 0; index += 1) {
		const sliceSize = Math.min(normalizedBlocks[index].length, initialSliceSize, remainingBudget);
		slices[index] = sliceSize;
		remainingBudget -= sliceSize;
	}

	while (remainingBudget > 0) {
		let addedInRound = false;

		for (let index = 0; index < normalizedBlocks.length && remainingBudget > 0; index += 1) {
			const remainingBlockLength = normalizedBlocks[index].length - slices[index];
			if (remainingBlockLength <= 0) {
				continue;
			}

			const extraSlice = Math.min(growthChunkSize, remainingBlockLength, remainingBudget);
			slices[index] += extraSlice;
			remainingBudget -= extraSlice;
			addedInRound = true;
		}

		if (!addedInRound) {
			break;
		}
	}

	const truncatedText = normalizedBlocks
		.map((block, index) => {
			const visiblePart = block.slice(0, slices[index]).trimEnd();
			if (slices[index] >= block.length) {
				return visiblePart;
			}
			return `${visiblePart}${itemTruncationNotice}`;
		})
		.join('\n\n');

	return `${truncatedText}${truncationNotice}`;
}

function toGitRelativePath(repoRoot: string, resource: GitLikeResourceState): string | null {
	const primaryUri = resource.uri ?? resource.resourceUri;
	if (!primaryUri) {
		return null;
	}

	return path.relative(repoRoot, primaryUri.fsPath).split(path.sep).join('/');
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
	const result = await execFileAsync('git', args, {
		cwd: repoRoot,
		maxBuffer: 8 * 1024 * 1024,
	});
	return result.stdout;
}

async function getGitText(repoRoot: string, spec: string): Promise<string | null> {
	try {
		return await runGit(repoRoot, ['show', spec]);
	} catch {
		return null;
	}
}

function isProbablyText(content: string | null): content is string {
	return typeof content === 'string' && !content.includes('\u0000');
}

function limitItems(items: string[], maxItems: number): string {
	if (items.length === 0) {
		return 'none';
	}

	if (items.length <= maxItems) {
		return items.join(', ');
	}

	return `${items.slice(0, maxItems).join(', ')}, ...`;
}

function excerptText(content: string, maxChars: number): string {
	if (content.length <= maxChars) {
		return content.trim();
	}

	const headSize = Math.floor(maxChars * 0.65);
	const tailSize = Math.floor(maxChars * 0.25);
	const head = content.slice(0, headSize).trimEnd();
	const tail = content.slice(-tailSize).trimStart();
	return `${head}\n\n[... content omitted ...]\n\n${tail}`.trim();
}

function extractCodeSymbols(content: string): string[] {
	const patterns = [
		/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
		/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/g,
		/(?:^|\n)\s*(?:export\s+)?interface\s+([A-Za-z0-9_]+)/g,
		/(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z0-9_]+)/g,
		/(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/g,
	];

	const symbols = new Set<string>();
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern)) {
			if (match[1]) {
				symbols.add(match[1]);
			}
		}
	}

	return [...symbols];
}

function extractImportedModules(content: string): string[] {
	const modules = new Set<string>();
	for (const match of content.matchAll(/(?:^|\n)\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
		if (match[1]) {
			modules.add(match[1]);
		}
	}
	return [...modules];
}

function getAddedItems(before: string[], after: string[]): string[] {
	const beforeSet = new Set(before);
	return after.filter((item) => !beforeSet.has(item));
}

function getRemovedItems(before: string[], after: string[]): string[] {
	const afterSet = new Set(after);
	return before.filter((item) => !afterSet.has(item));
}

function summarizePackageSectionChanges(
	sectionName: string,
	before: Record<string, string> | undefined,
	after: Record<string, string> | undefined,
): string[] {
	const previous = before ?? {};
	const next = after ?? {};
	const packageNames = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
	const changes: string[] = [];

	for (const packageName of packageNames) {
		if (!(packageName in previous)) {
			changes.push(`${sectionName}: add ${packageName}@${next[packageName]}`);
			continue;
		}
		if (!(packageName in next)) {
			changes.push(`${sectionName}: remove ${packageName}`);
			continue;
		}
		if (previous[packageName] !== next[packageName]) {
			changes.push(`${sectionName}: update ${packageName} ${previous[packageName]} -> ${next[packageName]}`);
		}
	}

	return changes;
}

function summarizePackageJsonChange(headContent: string | null, stagedContent: string): string[] {
	try {
		const before = headContent ? JSON.parse(headContent) as Record<string, unknown> : {};
		const after = JSON.parse(stagedContent) as Record<string, unknown>;
		const summary: string[] = [];

		const previousVersion = typeof before['version'] === 'string' ? before['version'] : undefined;
		const nextVersion = typeof after['version'] === 'string' ? after['version'] : undefined;
		if (previousVersion !== nextVersion && nextVersion) {
			summary.push(`package version: ${previousVersion ?? '(new)'} -> ${nextVersion}`);
		}

		for (const sectionName of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
			summary.push(...summarizePackageSectionChanges(
				sectionName,
				before[sectionName] as Record<string, string> | undefined,
				after[sectionName] as Record<string, string> | undefined,
			));
		}

		const beforeScripts = before['scripts'] as Record<string, string> | undefined;
		const afterScripts = after['scripts'] as Record<string, string> | undefined;
		if (JSON.stringify(beforeScripts ?? {}) !== JSON.stringify(afterScripts ?? {})) {
			summary.push('scripts section updated');
		}

		return summary.length > 0 ? summary : ['package metadata updated'];
	} catch {
		return ['package.json updated'];
	}
}

function summarizeCodeFileChange(headContent: string | null, stagedContent: string): string[] {
	const previousContent = headContent ?? '';
	const beforeSymbols = extractCodeSymbols(previousContent);
	const afterSymbols = extractCodeSymbols(stagedContent);
	const addedSymbols = getAddedItems(beforeSymbols, afterSymbols);
	const removedSymbols = getRemovedItems(beforeSymbols, afterSymbols);

	const beforeImports = extractImportedModules(previousContent);
	const afterImports = extractImportedModules(stagedContent);
	const addedImports = getAddedItems(beforeImports, afterImports);
	const removedImports = getRemovedItems(beforeImports, afterImports);

	const summary: string[] = [];
	if (!headContent) {
		summary.push('new source file');
	}
	if (addedSymbols.length > 0) {
		summary.push(`added symbols: ${limitItems(addedSymbols, 8)}`);
	}
	if (removedSymbols.length > 0) {
		summary.push(`removed symbols: ${limitItems(removedSymbols, 8)}`);
	}
	if (addedImports.length > 0) {
		summary.push(`new imports: ${limitItems(addedImports, 8)}`);
	}
	if (removedImports.length > 0) {
		summary.push(`removed imports: ${limitItems(removedImports, 8)}`);
	}
	if (summary.length === 0) {
		summary.push('source file implementation updated');
	}

	return summary;
}

function detectFileStatus(resource: GitLikeResourceState, headContent: string | null): string {
	if (resource.renameUri) {
		return 'renamed';
	}
	if (!headContent) {
		return 'added';
	}
	return 'modified';
}

function categorizeFile(filePath: string): StagedFileAnalysis['category'] {
	const normalizedPath = filePath.toLowerCase();
	const extension = path.extname(normalizedPath);

	if (normalizedPath.endsWith('package.json')) return 'package';
	if (normalizedPath.endsWith('package-lock.json') || normalizedPath.endsWith('yarn.lock') || normalizedPath.endsWith('pnpm-lock.yaml')) return 'lockfile';
	if (normalizedPath.includes('/test/') || normalizedPath.includes('/tests/') || normalizedPath.endsWith('.spec.ts') || normalizedPath.endsWith('.test.ts')) return 'test';
	if (normalizedPath.startsWith('.github/') || normalizedPath.includes('/workflow') || normalizedPath.includes('/workflows/')) return 'ci';
	if (normalizedPath.endsWith('.md')) return 'docs';
	if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'source';
	return 'other';
}

function buildFileAnalysis(
	filePath: string,
	status: string,
	stagedContent: string,
	headContent: string | null,
): StagedFileAnalysis {
	const category = categorizeFile(filePath);
	const extension = path.extname(filePath).toLowerCase();
	const lines: string[] = [
		`File: ${filePath}`,
		`Status: ${status}`,
	];

	if (filePath.endsWith('package.json')) {
		lines.push('Highlights:');
		for (const item of summarizePackageJsonChange(headContent, stagedContent)) {
			lines.push(`- ${item}`);
		}
	} else if (filePath.endsWith('package-lock.json') || filePath.endsWith('yarn.lock') || filePath.endsWith('pnpm-lock.yaml')) {
		lines.push('Highlights:');
		lines.push('- lockfile updated to reflect staged dependency changes');
	} else if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
		lines.push('Highlights:');
		for (const item of summarizeCodeFileChange(headContent, stagedContent)) {
			lines.push(`- ${item}`);
		}
		lines.push('Staged content excerpt:');
		lines.push('```');
		lines.push(excerptText(stagedContent, 2200));
		lines.push('```');
	} else {
		lines.push('Highlights:');
		lines.push(`- text file updated (${stagedContent.split('\n').length} lines in staged version)`);
		lines.push('Staged content excerpt:');
		lines.push('```');
		lines.push(excerptText(stagedContent, 1800));
		lines.push('```');
	}

	return {
		filePath,
		status,
		category,
		block: lines.join('\n'),
	};
}

async function buildStagedChangeContext(
	repo: GitRepositoryLike,
	stagedFiles: readonly GitLikeResourceState[],
): Promise<{ context: string; analyzedFiles: StagedFileAnalysis[] }> {
	const repoRoot = repo.rootUri?.fsPath;
	if (!repoRoot) {
		return {
			context: describeStagedFiles(stagedFiles),
			analyzedFiles: [],
		};
	}

	const analyses: StagedFileAnalysis[] = [];
	for (const file of stagedFiles) {
		const gitPath = toGitRelativePath(repoRoot, file);
		if (!gitPath) {
			continue;
		}

		const stagedContent = await getGitText(repoRoot, `:${gitPath}`);
		if (!isProbablyText(stagedContent)) {
			analyses.push({
				filePath: gitPath,
				status: 'binary or non-text',
				category: 'other',
				block: [
					`File: ${gitPath}`,
					'Status: binary or non-text staged file',
					'Highlights:',
					'- content omitted from AI context',
				].join('\n'),
			});
			continue;
		}

		const headContent = await getGitText(repoRoot, `HEAD:${gitPath}`);
		const status = detectFileStatus(file, headContent);
		analyses.push(buildFileAnalysis(gitPath, status, stagedContent, isProbablyText(headContent) ? headContent : null));
	}

	return {
		context: trimBlocksPreservingCoverage(
			analyses.map((analysis) => analysis.block),
			MAX_DIFF_SIZE,
			'\n\n[... staged file analysis truncated to fit the request size limit]',
			'\n[... file analysis truncated ...]',
		),
		analyzedFiles: analyses,
	};
}

function buildCommitTypeGuidance(analyzedFiles: readonly StagedFileAnalysis[]): string {
	if (analyzedFiles.length === 0) {
		return '';
	}

	const sourceFiles = analyzedFiles.filter((file) => file.category === 'source');
	const addedSourceFiles = sourceFiles.filter((file) => file.status === 'added');
	const packageFiles = analyzedFiles.filter((file) => file.category === 'package' || file.category === 'lockfile');
	const nonPackageFiles = analyzedFiles.filter((file) => file.category !== 'package' && file.category !== 'lockfile');

	if (sourceFiles.length > 0 && addedSourceFiles.length > 0) {
		return [
			'Important type guidance:',
			'- Source code files were added under the staged changes.',
			'- Prefer feat as the Conventional Commit type.',
			'- Do not use chore or chore(deps) as the main type when new source files were added.',
			'- Mention dependency updates only as secondary bullet points if package files also changed.',
		].join('\n');
	}

	if (sourceFiles.length > 0 && packageFiles.length > 0) {
		return [
			'Important type guidance:',
			'- Source code files changed together with package files.',
			'- Do not classify the commit as dependency-only chore(deps).',
			'- Prefer feat, fix, or refactor based on the source code changes; dependency updates are secondary.',
		].join('\n');
	}

	if (sourceFiles.length > 0) {
		return [
			'Important type guidance:',
			'- Source code files changed.',
			'- Prefer feat, fix, or refactor instead of chore unless the changes are purely tooling.',
		].join('\n');
	}

	if (packageFiles.length > 0 && nonPackageFiles.length === 0) {
		return [
			'Important type guidance:',
			'- Only package manifest or lock files changed.',
			'- Prefer chore(deps) if the changes are mainly dependency or package metadata updates.',
		].join('\n');
	}

	return '';
}

function buildCommitPrompt(
	changeContext: string,
	stagedFilesSummary: string,
	typeGuidance: string,
	commitLanguage: CommitLanguage,
): string {
	if (commitLanguage === 'Russian') {
		const lines = [
			'Сгенерируй сообщение коммита git по структурированному анализу staged файлов.',
			'Пиши summary и bullet points на русском языке в безличной или пассивной форме.',
			'Тип и scope Conventional Commit оставляй стандартными, на английском и в нижнем регистре (например: feat, fix, docs, refactor, chore).',
			'',
			'Строгие правила вывода:',
			'1. Первая строка должна быть корректным Conventional Commit в нижнем регистре.',
			'2. Формат первой строки должен быть строго таким: type(scope): краткое описание ИЛИ type: краткое описание.',
			'3. Первая строка должна быть короткой и желательно не длиннее 72 символов.',
			'4. Не оборачивай ответ в кавычки или markdown.',
			'5. Не используй формулировки вроде "это изменение", "этот коммит" или "файл README.md", если это не требуется по смыслу.',
			'6. Не пиши от первого лица и не используй формы вроде "добавил", "обновил", "исправил".',
			'7. Используй краткие безличные или пассивные формулировки: добавлено, обновлены, исправлены, удалены, переработаны, улучшены.',
			'8. Используй подходящие типы: feat, fix, docs, refactor, chore, test, ci, build, perf, style.',
		];

		lines.push(
			'9. После первой строки добавь пустую строку и затем 2-6 коротких bullet points.',
			'10. Каждый bullet point должен начинаться с "- " и описывать конкретное изменение (новую функцию, отрефакторенную логику, обновлённые зависимости и т.д.).',
			'11. Описывай все значимые изменения по типам: новые функции/файлы, изменения в логике, обновления зависимостей. Не ограничивайся только описанием версий.',
			'12. Bullet points пиши в безличной или пассивной форме.'
		);

		lines.push(
			'',
			'Примеры правильного и неправильного выбора type:',
			'✅ feat(parser): добавлен парсер конфигурации',
			'❌ fix(parser): добавлен парсер конфигурации (использовал fix, хотя это новая функция)',
			'',
			'✅ fix(auth): исправлена проверка токена при истечении срока',
			'❌ feat(auth): исправлена проверка токена при истечении срока (использовал feat, хотя это исправление)',
			'',
			'✅ refactor(db): перемещена логика подключения в отдельный модуль',
			'✅ docs(api): обновлены описания эндпоинтов',
			'✅ chore(deps): обновлены версии зависимостей',
			'✅ test(utils): добавлены тесты для вспомогательных функций',
			'✅ ci(workflow): добавлен шаг сборки в GitHub Actions',
			'✅ style(components): отформатирован код по ESLint',
			'',
			'Список staged файлов:',
			stagedFilesSummary,
			'',
			typeGuidance,
			typeGuidance ? '' : '',
			'Структурированный анализ staged файлов:',
			changeContext
		);

		return lines.join('\n');
	}

	const lines = [
		'Generate a git commit message from the structured analysis of staged files.',
		'Write the commit summary and bullet points in English. Keep the Conventional Commit type/scope in standard lowercase English.',
		'',
		'Strict output rules:',
		'1. The first line must be a valid Conventional Commit in lowercase.',
		'2. Format the first line exactly as: type(scope): short summary OR type: short summary.',
		'3. The first line must be concise and ideally under 72 characters.',
		'4. Do not wrap the first line in quotes or markdown.',
		'5. Do not mention "this change", "this commit", or "README.md file" unless necessary.',
		'6. Prefer specific verbs like add, update, fix, remove, refactor, improve.',
		'7. Use these types when appropriate: feat, fix, docs, refactor, chore, test, ci, build, perf, style.',
	];

	lines.push(
		'8. After the first line add a blank line and then 2-6 short bullet points.',
		'9. Each bullet must start with "- " and describe specific changes: new functions/files, refactored logic, updated dependencies, etc.',
		'10. Cover all meaningful changes, not just version bumps.',
		'11. Keep bullets compact, for example: "- add commit preview QuickPick" or "- update package dependencies".'
	);

	lines.push(
		'',
		'Examples of correct type selection:',
		'✅ feat(parser): add configuration file parser',
		'❌ fix(parser): add configuration file parser (used fix for a new feature)',
		'',
		'✅ fix(auth): correct token expiry check',
		'❌ feat(auth): correct token expiry check (used feat for a bug fix)',
		'',
		'✅ refactor(db): extract connection logic into separate module',
		'✅ docs(api): update endpoint descriptions',
		'✅ chore(deps): update dependency versions',
		'✅ test(utils): add helper function tests',
		'✅ ci(workflow): add build step to GitHub Actions',
		'✅ style(components): format code per ESLint',
		'',
		'Staged files overview:',
		stagedFilesSummary,
		'',
		typeGuidance,
		typeGuidance ? '' : '',
		'Structured staged file analysis:',
		changeContext
	);

	return lines.join('\n');
}

function buildChatPayload(
	model: string,
	changeContext: string,
	stagedFilesSummary: string,
	typeGuidance: string,
	commitLanguage: CommitLanguage,
): object {
	return {
		model,
		messages: [
			{
				role: 'system',
				content: 'You write precise git commit messages. Follow the requested output format exactly and return only the commit message text.'
			},
			{
				role: 'user',
				content: buildCommitPrompt(changeContext, stagedFilesSummary, typeGuidance, commitLanguage)
			}
		]
	};
}

async function sendChatCompletion(
	apiBaseUrl: string,
	accessToken: string,
	payload: object,
	ca: Buffer[] | undefined
): Promise<HttpResult> {
	const url = new URL(`${apiBaseUrl.replace(/\/+$/, '')}/chat/completions`);
	return httpRequest(url, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		ca,
	}, JSON.stringify(payload));
}

// --- Helpers --------------------------------------------------------------

const MAX_DIFF_SIZE = 20_000; // bytes sent to the model
const VALID_SCOPES = ['GIGACHAT_API_PERS', 'GIGACHAT_API_B2B', 'GIGACHAT_API_CORP'] as const;
type GigaChatScope = typeof VALID_SCOPES[number];
const GIGACHAT_AUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';

function isValidScope(scope: string): scope is GigaChatScope {
	return (VALID_SCOPES as readonly string[]).includes(scope);
}

function getApiBaseUrlForScope(scope: GigaChatScope): string {
	switch (scope) {
		case 'GIGACHAT_API_PERS':
			return 'https://gigachat.devices.sberbank.ru/api/v1';
		case 'GIGACHAT_API_B2B':
		case 'GIGACHAT_API_CORP':
			return 'https://api.giga.chat/v1';
		default:
			throw new Error(`Invalid scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}`);
	}
}

// --- Commit ---------------------------------------------------------------

/**
 * Extract the short (first line) version from commit message content.
 */
function extractShortMessage(fullMessage: string): string {
	const firstLine = fullMessage.trim().split('\n')[0].trim();
	// Remove markdown code fences if present
	return firstLine.replace(/^```+/g, '').replace(/```+$/g, '').trim();
}

/**
 * Clean the commit message from markdown code fences that LLM might add.
 */
function cleanCommitMessage(message: string): string {
	return message
		.replace(/^```[a-z]*\s*/m, '') // opening fence
		.replace(/\s*```\s*$/, '')    // closing fence
		.trim();
}

async function makeAiCommit(state: vscode.Memento) {
	const config = vscode.workspace.getConfiguration('gigacommit');
	const authorizationKey = config.get<string>('authorizationKey');
	const scope = config.get<string>('scope') || 'GIGACHAT_API_PERS';
	const model = config.get<string>('model') || 'GigaChat-2-Pro';
	const commitLanguage = (config.get<string>('commitLanguage') || 'English') as CommitLanguage;
	const caBundlePath = config.get<string>('caBundlePath');

	const ca = loadCaBundle(caBundlePath);
	if (!isValidScope(scope)) {
		vscode.window.showErrorMessage(`Invalid scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}`);
		return;
	}
	const apiBaseUrl = getApiBaseUrlForScope(scope);

	if (!model.trim()) {
		vscode.window.showErrorMessage('Model name cannot be empty. Please configure a valid model in settings.');
		return;
	}

	if (!authorizationKey) {
		vscode.window.showErrorMessage('GigaChat authorization key is not set. Please configure it in settings.');
		return;
	}

	const gitExtension = vscode.extensions.getExtension('vscode.git');
	if (!gitExtension) {
		vscode.window.showErrorMessage('Git extension not found.');
		return;
	}

	const git = gitExtension.exports.getAPI(1);
	const repo = git.repositories[0];

	if (!repo) {
		vscode.window.showErrorMessage('No git repository found.');
		return;
	}

	const stagedFiles = repo.state.indexChanges;
	if (stagedFiles.length === 0) {
		vscode.window.showWarningMessage('No staged changes to commit.');
		return;
	}
	const stagedFilesSummary = describeStagedFiles(stagedFiles as readonly GitLikeResourceState[]);
	const { context: changeContext, analyzedFiles } = await buildStagedChangeContext(
		repo as GitRepositoryLike,
		stagedFiles as readonly GitLikeResourceState[],
	);
	if (!changeContext.trim()) {
		vscode.window.showWarningMessage('Could not build staged file analysis for the commit message.');
		return;
	}
	const typeGuidance = buildCommitTypeGuidance(analyzedFiles);

	// --- Get token (cached, persists across VS Code sessions) ---
	vscode.window.showInformationMessage('Preparing GigaChat request...');

	let accessToken: string;
	try {
		accessToken = await getValidAccessToken(state, GIGACHAT_AUTH_URL, authorizationKey, scope, ca);
	} catch (error) {
		const tlsInfo = diagnoseNetworkError(error as Error);
		if (tlsInfo) {
			vscode.window.showErrorMessage(`GigaChat connection error — possible certificate issue:\n\n${tlsInfo}`, { modal: false });
		} else {
			vscode.window.showErrorMessage(`GigaChat auth error: ${(error as Error).message}`);
		}
		console.error(error);
		return;
	}

	// --- Send chat completion ---
	vscode.window.showInformationMessage('Generating AI commit message...');

	const payload = buildChatPayload(model, changeContext, stagedFilesSummary, typeGuidance, commitLanguage);
	let response: HttpResult;
	try {
		response = await sendChatCompletion(apiBaseUrl, accessToken, payload, ca);
	} catch (error) {
		const tlsInfo = diagnoseNetworkError(error as Error);
		if (tlsInfo) {
			vscode.window.showErrorMessage(`GigaChat connection error — possible certificate issue:\n\n${tlsInfo}`, { modal: false });
		} else {
			vscode.window.showErrorMessage(`GigaChat API connection error: ${(error as Error).message}`);
		}
		console.error(error);
		return;
	}

	// --- Retry once on 401 (token may have been revoked server-side) ---
	if (response.status === 401) {
		await invalidateToken(state);
		accessToken = await getValidAccessToken(state, GIGACHAT_AUTH_URL, authorizationKey, scope, ca);
		response = await sendChatCompletion(apiBaseUrl, accessToken, payload, ca);
	}

	if (response.status >= 400) {
		const info = parseApiError(response.status, response.body, 'chat');
		const formatted = formatApiErrorMessage(info, response.status, response.body, 'GigaChat API');
		vscode.window.showErrorMessage(`GigaChat API error: ${formatted.message}`);
		return;
	}

	try {
		const data = JSON.parse(response.body);

		// Check for error in the response body (some APIs return 200 with error field)
		if (data.error) {
			const errMsg = typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error);
			vscode.window.showErrorMessage(`GigaChat API error: ${errMsg}`);
			return;
		}

		if (!data.choices?.[0]?.message?.content) {
			vscode.window.showErrorMessage('GigaChat returned an empty response. Check logs for details.');
			console.error('Unexpected GigaChat response body:', truncateForLog(JSON.stringify(data), 500));
			return;
		}

		const rawMessage = cleanCommitMessage(data.choices[0].message.content.trim());
		const shortMessage = extractShortMessage(rawMessage);

		const selected = await showCommitPreview({
			short: shortMessage,
			detailed: rawMessage,
		});

		if (selected === null) return;

		repo.inputBox.value = selected;
		vscode.window.showInformationMessage('Commit message inserted into Source Control input.');
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to process response: ${(error as Error).message}`);
		console.error(error);
	}
}

export function activate(context: vscode.ExtensionContext) {
	console.log('GigaCommit extension is now active!');

	let disposable = vscode.commands.registerCommand('gigacommit.makeCommit', async () => {
		await makeAiCommit(context.globalState);
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
