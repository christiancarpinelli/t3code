# GitHub Copilot CLI

T3 Code can use the GitHub Copilot CLI as a provider through its Agent Client Protocol (ACP)
server. The CLI runs on the T3 server machine, so web, desktop, and mobile clients all use the same
GitHub account, organization policy, configuration, skills, agents, MCP servers, and license
entitlements available to `copilot` there.

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

Copilot CLI can also authenticate non-interactively with `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or
`GITHUB_TOKEN`. Add an instance-specific token in the provider's Environment variables section if
different T3 Code provider instances should use different accounts.

An organization or enterprise administrator can disable Copilot CLI access. T3 Code cannot bypass
that policy; the provider health message reports an ACP startup failure when the authenticated
account is not entitled to use the CLI.

## Add the provider

Open **Settings → Providers**, add a provider instance, and choose **GitHub Copilot**. Usually the
default binary path (`copilot`) and empty ACP server arguments are correct.

Use **ACP server arguments** for Copilot options that apply to every session started by that
provider instance. For example:

```text
--experimental --reasoning-effort=high
```

Provider environment variables and arguments are applied on the T3 server host. They work the same
way for a local client, a relay/tunnel connection, or a mobile client.

## Supported behavior

T3 Code uses `copilot --acp --stdio`, the integration mode published by GitHub for editors and
custom frontends. It supports:

- streamed assistant responses, reasoning, plans, and tool activity
- file and image attachments supported by the selected model and organization policy
- permission prompts, per-session approval, full-access mode, interruption, and steering
- model discovery and switching
- durable Copilot sessions and resume
- Copilot custom instructions, custom agents, skills, MCP servers, plugins, hooks, and built-in
  GitHub tools discovered by the CLI
- Copilot slash commands that the ACP server advertises; send them as normal prompts, such as
  `/review`, `/research`, `/context`, or `/session info`
- T3 Code's generated thread titles, branch names, commit messages, and pull request text

Terminal-only Copilot commands that open a full-screen picker or dialog are intentionally not
available through GitHub's ACP server. GitHub currently lists commands such as `/login`, `/resume`,
`/settings`, `/theme`, and `/undo` in this category. Run those in an interactive `copilot` terminal
when needed; their resulting account and configuration state is then reused by T3 Code.

GitHub currently marks Copilot CLI ACP support as public preview, so keeping the CLI updated is
recommended.

See GitHub's [Copilot CLI installation guide][install], [command reference][reference], and
[ACP server reference][acp] for the current upstream behavior.

## Multiple accounts

Create multiple GitHub Copilot provider instances and give each one a distinct display name and
environment. For token-based authentication, set `COPILOT_GITHUB_TOKEN` as a sensitive environment
variable on each instance. Each instance gets its own process and routing identity while retaining
the standard Copilot CLI configuration behavior.

[install]: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli
[reference]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
[acp]: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server
