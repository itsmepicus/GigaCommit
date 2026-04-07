import * as vscode from 'vscode';

export interface CommitPreview {
	short: string;
	detailed: string;
}

/**
 * Shows a QuickPick with commit options.
 * Returns the selected message, or null if cancelled.
 */
export async function showCommitPreview(preview: CommitPreview): Promise<string | null> {
	const items: vscode.QuickPickItem[] = [
		{
			label: "$(git-commit) Short Commit",
			description: preview.short,
		},
		{
			label: "$(list-unordered) Detailed Commit",
			description: preview.detailed.split('\n')[0],
			detail: "Full message with bullet points"
		},
	];

	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: "Select commit message option:",
		title: "GigaCommit Preview"
	});

	if (!pick) return null;

	if (pick.label.includes("Short")) {
		return preview.short;
	}

	return preview.detailed;
}
