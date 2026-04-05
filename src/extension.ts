import * as vscode from 'vscode';
import fetch from 'node-fetch';

export async function activate(context: vscode.ExtensionContext) {
	console.log('GigaCommit extension is now active!');

	let disposable = vscode.commands.registerCommand('gigacommit.makeCommit', async () => {
		await makeAiCommit();
	});

	context.subscriptions.push(disposable);
}

async function makeAiCommit() {
	const config = vscode.workspace.getConfiguration('gigacommit');
	const apiKey = config.get<string>('apiKey');
	const apiUrl = config.get<string>('apiUrl');

	if (!apiKey) {
		vscode.window.showErrorMessage('GigaChat API key is not set. Please configure it in settings.');
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

	// Get staged changes
	const diff = repo.state.indexChanges;
	if (diff.length === 0) {
		vscode.window.showWarningMessage('No staged changes to commit.');
		return;
	}

	// Get diff text
	let diffText = '';
	for (const file of diff) {
		const document = await vscode.workspace.openTextDocument(file.uri);
		diffText += `File: ${file.uri.fsPath}\n`;
		diffText += `---\n${document.getText()}\n---\n\n`;
	}

	// Generate commit message with GigaChat
	vscode.window.showInformationMessage('Generating AI commit message...');

	try {
		const response = await fetch(apiUrl!, {
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			method: 'POST',
			body: JSON.stringify({
				model: 'GigaChat',
				messages: [
					{
						role: 'system',
						content: 'You are a helpful assistant that generates git commit messages in Conventional Commits format. Your responses should be ONLY the commit message, nothing else.'
					},
					{
						role: 'user',
						content: `Generate a conventional commit message based on these changes:\n\n${diffText}`
					}
				]
			})
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		const commitMessage = data.choices[0].message.content.trim();

		// Confirm and commit
		const confirmation = await vscode.window.showQuickPick(['Yes', 'No'], {
			placeHolder: `Commit with message: ${commitMessage}`
		});

		if (confirmation === 'Yes') {
			await repo.commit(commitMessage);
			vscode.window.showInformationMessage(`Committed: ${commitMessage}`);
		}
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to generate commit message: ${(error as Error).message}`);
		console.error(error);
	}
}

export function deactivate() {}