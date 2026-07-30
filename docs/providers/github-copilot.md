# GitHub Copilot CLI

T3 Code can use the GitHub Copilot CLI as a provider through its Agent Client Protocol (ACP)
server. The CLI runs on the T3 server machine, so web, desktop, and mobile clients use the GitHub
account and Copilot entitlement configured on that machine.

## Prerequisites

Install GitHub Copilot CLI using one of GitHub's supported methods:

```bash
brew install copilot-cli
# or
npm install -g @github/copilot
```

Authenticate once on the machine that runs the T3 server:

```bash
copilot login
```

The provider uses Copilot CLI's existing authentication. Organization policy and license checks
continue to be enforced by GitHub.

## Add the provider

Open **Settings → Providers**, add a provider instance, and choose **GitHub Copilot**. Usually the
default binary path (`copilot`) and empty ACP server arguments are correct.

Optional binary path, ACP arguments, and environment variables are applied on the T3 server host.

## Supported behavior

T3 Code uses `copilot --acp --stdio`, the integration mode published by GitHub for editors and
custom frontends. It supports:

- streamed assistant responses, plans, and tool activity
- file and image prompts supported by the selected model
- permission prompts, full-access mode, and interruption
- model discovery and switching
- session resume through ACP
- T3 Code's generated thread titles, branch names, commit messages, and pull request text

Terminal-only interactive commands remain available by running `copilot` directly. See GitHub's
[Copilot CLI installation guide][install] and [ACP server reference][acp] for current upstream
behavior.

[install]: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli
[acp]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
