import * as vscode from 'vscode';
import * as https from 'node:https';
import * as fs from 'node:fs';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';

// --- OAuth token cache (persisted in globalState) -------------------------

interface TokenRecord {
	token: string;
	expiresAt: number; // ms since epoch
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

function parseApiError(status: number, rawBody: string, context: 'auth' | 'chat'): ApiErrorInfo {
	const body = extractErrorBody(rawBody);

	let detail = '';

	// --- Status-specific messages ---
	switch (status) {
		case 400:
			if (context === 'auth') {
				detail = 'Failed to obtain OAuth token';
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
function extractErrorBody(raw: string): { errorMessage: string; raw?: object } {
	const result: { errorMessage: string; raw?: object } = { errorMessage: '' };
	try {
		const obj = JSON.parse(raw);
		result.raw = obj;

		// Format 1: { "description": "..." } — Sber token endpoint
		if (typeof obj.description === 'string' && obj.description) {
			result.errorMessage = obj.description;
			return result;
		}

		// Format 2: { "error": { "message": "..." } } — OpenAI-compatible
		if (obj.error && typeof obj.error.message === 'string') {
			result.errorMessage = obj.error.message;
			return result;
		}

		// Format 3: { "message": "..." } — flat error
		if (typeof obj.message === 'string' && obj.message) {
			result.errorMessage = obj.message;
			return result;
		}

		// Format 4: { "detail": "..." } — FastAPI-style
		if (typeof obj.detail === 'string' && obj.detail) {
			result.errorMessage = obj.detail;
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
	if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_BUFFER) {
		return cached.token;
	}
	const record = await fetchAccessToken(authUrl, authorizationKey, scope, ca);
	await saveToken(state, record);
	return record.token;
}

/** Clear cached token — used when server returns 401. */
async function invalidateToken(state: vscode.Memento) {
	await clearToken(state);
}

// --- Chat completions -----------------------------------------------------

const DETAIL_DIFF_THRESHOLD = 4_000;

type CommitLanguage = 'English' | 'Russian';

function buildCommitPrompt(diffText: string, commitLanguage: CommitLanguage): string {
	const isLargeDiff = diffText.length >= DETAIL_DIFF_THRESHOLD;
	if (commitLanguage === 'Russian') {
		const lines = [
			'Сгенерируй сообщение коммита git по staged diff.',
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

		if (isLargeDiff) {
			lines.push(
				'9. Так как diff большой, после первой строки добавь пустую строку и затем 2-6 коротких bullet points.',
				'10. Каждый bullet point должен начинаться с "- " и кратко описывать важный изменённый файл или область.',
				'11. Bullet points тоже пиши на русском в безличной или пассивной форме.'
			);
		} else {
			lines.push(
				'9. Для небольших diff возвращай только первую строку, без body и без bullet points.'
			);
		}

		lines.push(
			'',
			'Примеры:',
			'docs(readme): обновлён workflow Source Control',
			'feat(scm): добавлена кнопка GigaCommit',
			'',
			'Staged diff:',
			diffText
		);

		return lines.join('\n');
	}

	const lines = [
		'Generate a git commit message from the staged diff.',
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

	if (isLargeDiff) {
		lines.push(
			'8. Because the diff is large, add a blank line after the first line and then 2-6 short bullet points.',
			'9. Each bullet must start with "- " and briefly describe an important changed file or area.',
			'10. Keep bullets compact, for example: "- update README usage flow" or "- add SCM button icons".'
		);
	} else {
		lines.push(
			'8. For small diffs, return only the first line with no body and no bullet points.'
		);
	}

	lines.push(
		'',
		'Examples:',
		'docs(readme): update Source Control workflow',
		'feat(scm): add GigaCommit action button',
		'',
		'Staged diff:',
		diffText
	);

	return lines.join('\n');
}

function buildChatPayload(model: string, diffText: string, commitLanguage: CommitLanguage): object {
	return {
		model,
		messages: [
			{
				role: 'system',
				content: 'You write precise git commit messages. Follow the requested output format exactly and return only the commit message text.'
			},
			{
				role: 'user',
				content: buildCommitPrompt(diffText, commitLanguage)
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

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

// --- Commit ---------------------------------------------------------------

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

	// --- Get real staged diff (not full file contents) ---
	// repo.diff(true) calls `git diff --cached` under the hood.
	// Git already marks binary files as "Binary files a/.. and b/.. differ",
	// so the LLM only gets textual diff — never raw binary data.
	let diffText: string;
	try {
		diffText = await repo.diff(true);
	} catch {
		vscode.window.showWarningMessage('Could not retrieve staged diff from Git.');
		return;
	}

	if (!diffText.trim()) {
		vscode.window.showWarningMessage('No staged changes to commit.');
		return;
	}

	// --- Size guard ---
	if (diffText.length > MAX_DIFF_SIZE) {
		const message = `Staged diff is too large (${formatBytes(diffText.length)}) for one request. Proceed with a truncated diff?`;
		const choice = await vscode.window.showWarningMessage(message, 'Proceed (truncated)', 'Cancel');
		if (choice !== 'Proceed (truncated)') return;
		diffText = diffText.substring(0, MAX_DIFF_SIZE) + '\n\n[... diff truncated due to size limit]';
	}

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

	const payload = buildChatPayload(model, diffText, commitLanguage);
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

		const commitMessage = data.choices[0].message.content.trim();
		repo.inputBox.value = commitMessage;
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
