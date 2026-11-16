# How to add a tool to the hopp catalog

hopp keeps a catalog of tools so every agent knows what it can use. hopp only
describes tools: it never runs them, keeps no secrets and blocks nothing. You
add a tool by creating one folder with two files.

## 1. Find the folder

    hopp tools path NAME

prints the folder the tool gets. NAME is lowercase letters, digits and dashes,
starting with a letter, and must equal the `name` in `tool.yaml`. Create the
folder; anything the tool needs (a binary, scripts, references) goes inside it.

## 2. Install a pinned version

Install a concrete version inside the tool's folder (for example
`bin/` or `node_modules/`), never an unpinned "latest", so the tool behaves the
same tomorrow. Write the version you installed into `USAGE.md`.

## 3. Write tool.yaml

Fields: `name`, `description` (one line: what the tool is for; it appears in
every session's start text), `via`, `command`, `mcp_server`, `harnesses`,
`environment`, `paid`, `enabled`. Unknown fields are an error.

A command the agent runs (`via: command`; `command` is the argument list, its
first word an absolute path or a name on PATH):

    name: obscura
    description: Headless browser in one binary for fetching and scraping pages
    via: command
    command: [/Users/me/.hopp/tools/obscura/bin/obscura]
    environment: [OBSCURA_TOKEN]

An MCP server the human connected by hand (`via: mcp`; hopp does not connect
it, so name the harnesses where it is connected):

    name: elevenlabs
    description: Speech, voices and music
    via: mcp
    mcp_server: elevenlabs
    harnesses: [claude-code]
    paid: true

Instructions only, such as a library of references (`via: guide`; no command,
no server):

    name: landing-refs
    description: Reference landing pages and how to browse them
    via: guide

`harnesses` empty means every harness (claude-code, codex, deepseek,
kimi-code, pi). `environment` lists only the NAMES of variables the tool
needs.

## 4. Write USAGE.md

What the tool is for; the three most common calls, copy-pasteable; where its
output goes (stdout, a file, a folder); its limits (rate limits, sizes,
what it cannot do); and, if it is paid, what a call costs. If the tool has a
background service (a server, a browser endpoint), say how to start it on a
free port and that the agent that needs it starts it and stops it when done.

## 5. No secrets

Never write a key, token or password into any file of the catalog. Name the
environment variable in `environment` and in `USAGE.md`; the human sets it.

## 6. Check and try

    hopp tools check NAME

must report no problems. Then make one real call as `USAGE.md` describes and
confirm it works.

## 7. Leave paid and enabled to the human

Do not decide `paid` or `enabled` yourself. Write what you believe in
`tool.yaml`, then ask the human with `hopp ask` to confirm whether the tool is
paid and whether it should be switched on.
