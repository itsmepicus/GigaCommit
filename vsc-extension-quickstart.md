# GigaCommit

Welcome to GigaCommit, a VSCode extension that helps you create AI-powered git commits using GigaChat and Conventional Commits.

## Features

- Generate commit messages using GigaChat AI
- Follows Conventional Commits specification
- Simple integration with VSCode Git
- Configurable API settings

## Getting Started

1. Install the extension from VSCode Marketplace
2. Get your GigaChat API key
3. Configure the extension in VSCode Settings:
   - `gigacommit.apiKey`: Your GigaChat API key
   - `gigacommit.apiUrl`: GigaChat API endpoint (default is `https://api.gigachat.ru/v1/chat/completions`)

## How to Use

1. Stage your changes in Git
2. Run the command "Make AI Commit with GigaChat" from Command Palette (Ctrl+Shift+P)
3. Wait for GigaChat to generate a commit message
4. Confirm or reject the generated message

## Requirements

- VSCode 1.80+
- Git
- GigaChat API access

## Extension Settings

This extension contributes the following settings:

- `gigacommit.apiKey`: Your GigaChat API key
- `gigacommit.apiUrl`: GigaChat API endpoint

## Known Issues

None at the moment.

## Release Notes

### 1.0.0

- Initial release
- Support for AI commit message generation
- Conventional Commits format
- GigaChat integration

---

GigaCommit - AI-powered commits made simple.