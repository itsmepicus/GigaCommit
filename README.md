# GigaCommit - AI-Powered Git Commits for VSCode

GigaCommit is a Visual Studio Code extension that leverages artificial intelligence to generate meaningful, conventional-style commit messages based on your code changes. By integrating with GigaChat, it analyzes your staged changes and suggests appropriate commit messages following the Conventional Commits specification.

## Features

✨ **AI-Powered Commit Messages** - Let GigaChat analyze your code changes and generate descriptive commit messages

🎯 **Conventional Commits** - All generated messages follow the Conventional Commits format for better project history

⚡ **Seamless Integration** - Works directly within VSCode's Git interface

🔐 **Secure** - Your code stays private; only diff information is sent to GigaChat API

⚙️ **Configurable** - Easy to configure API keys and endpoints

## Installation

1. Open VSCode
2. Go to Extensions view (Ctrl+Shift+X)
3. Search for "GigaCommit"
4. Click Install

## Configuration

Before using GigaCommit, you'll need to configure your GigaChat API credentials:

1. Open VSCode Settings (Ctrl+,)
2. Search for "GigaCommit"
3. Enter your GigaChat API key in the `GigaCommit: Api Key` field
4. Optionally change the API URL if needed

```json
{
  "gigacommit.apiKey": "your-api-key-here",
  "gigacommit.apiUrl": "https://api.gigachat.ru/v1/chat/completions"
}
```

## Usage

1. Make your code changes
2. Stage the files you want to commit in the Git view
3. Open Command Palette (Ctrl+Shift+P)
4. Run "Make AI Commit with GigaChat"
5. Wait for GigaChat to generate a commit message
6. Confirm the suggested message or cancel

## How It Works

1. The extension collects information about your staged changes
2. It sends this information to GigaChat API with instructions to generate a conventional commit message
3. GigaChat analyzes the changes and returns an appropriate commit message
4. You review and confirm the message before committing

## Conventional Commits Format

GigaCommit ensures all generated messages follow the Conventional Commits specification:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Common types include:
- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation only changes
- `style`: Changes that do not affect the meaning of the code
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `perf`: A code change that improves performance
- `test`: Adding missing tests or correcting existing tests
- `build`: Changes that affect the build system or external dependencies
- `ci`: Changes to CI configuration files and scripts
- `chore`: Other changes that don't modify src or test files

## Security

GigaCommit respects your code privacy:

- Only the diff of your staged changes is sent to the API
- Your full codebase remains on your machine
- API keys are stored in VSCode's settings
- All communication with GigaChat uses HTTPS

## Troubleshooting

**Q: I get an error about missing API key**
A: Make sure you've configured your GigaChat API key in VSCode settings

**Q: The AI takes too long to respond**
A: Check your internet connection and GigaChat API status

**Q: Generated messages are not relevant**
A: Try staging fewer files at once for more focused commit messages

## Contributing

Contributions are welcome! Please feel free to submit issues, feature requests, or pull requests.

## License

MIT License

## Acknowledgements

Powered by GigaChat AI and built on VSCode Extension APIs.