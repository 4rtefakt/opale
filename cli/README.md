# opale CLI

Go binary for terminal-first Opale workflows — devices, tickets, scripts, apps, compliance and more, with Microsoft Entra PKCE auth and shell completion.

**Full documentation: [docs/CLI.md](../docs/CLI.md)**

## Quick start

```bash
# Build
cd cli/
go build -o opale .
sudo mv opale /usr/local/bin/

# Authenticate
opale auth login --server https://opale.example.com

# Shell completion (zsh / bash / fish)
opale completion install

# Use
opale devices ls
opale console <hostname>
opale tickets ls
```

## Commands

```
auth        login / status / logout
devices     ls / show
tickets     ls / show / create / comment / update / close
console     SYSTEM shell via agent WebSocket
ssh         SSH session via Netbird
scripts     ls / run / exec / history
alerts      ls / snooze
compliance  ls / show
apps        ls / search / deploy / deployments / cancel / retry
tokens      ls / revoke
audit       ls
completion  bash / zsh / fish / powershell / install
```
