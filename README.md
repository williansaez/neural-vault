# Neural Vault

**An Obsidian community plugin (beta) — desktop only — pairs with [Claude Code](https://claude.com/claude-code).**
It animates Obsidian's *native* graph view: nodes flash as Claude Code reads and edits the notes in your vault.

![Neural Vault demo](docs/demo.gif)

> Watch your vault light up like a brain. Every file the agent touches flashes on the graph — your knowledge base looks like neurons firing.

## What this is — and isn't

- ✅ A **visualizer**: it drives Obsidian's built-in graph view to glow on agent activity.
- ✅ An **observability toy**: see at a glance which notes Claude just read or changed.
- ❌ Not a vault, note store, or memory/RAG system — it stores nothing of its own.
- ❌ Not required by Claude Code — Claude works fine without it; this is eye-candy for your graph.

## How it works

```
Claude Code reads a note
        │  PostToolUse hook (.claude/settings.json in the vault)
        ▼
curl → http://127.0.0.1:8765/read
        │  plugin's localhost listener
        ▼
node matched on the native graph → glows green, swells, fades
```

The plugin drives Obsidian's built-in PIXI graph renderer directly — no separate view. It also keeps the graph "alive": the render cooldown is disabled and the force simulation stays warm, so nodes keep drifting under their real physics instead of freezing.

## Requirements

- Obsidian ≥ 1.4.0 (tested on 1.12.x, macOS) — desktop only (`isDesktopOnly`)
- Claude Code **CLI** — the Claude desktop app (Cowork) doesn't fire hooks
- Node (build only) — no prebuilt release yet, so you build `main.js` yourself

## Install (beta, manual)

1. Build:
   ```bash
   npm install
   npm run build
   ```
2. Copy (or symlink) `main.js` and `manifest.json` into your vault:
   ```
   <vault>/.obsidian/plugins/neural-vault/
   ```
3. Enable **Neural Vault** in Settings → Community plugins.

## Connect Claude Code

Add these hooks to `<vault>/.claude/settings.json` — reads glow green, edits/writes glow red:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:8765/read --data-binary @- >/dev/null 2>&1"
          }
        ]
      },
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s --max-time 1 -X POST http://127.0.0.1:8765/read --data-binary @- >/dev/null 2>&1"
          }
        ]
      }
    ]
  }
}
```

Then run `claude` inside the vault, ask it to read some notes, and watch the graph.

> **Note:** the Claude desktop app (Cowork) does not fire hooks — use the Claude Code CLI.

## Features

- **Read vs write colors** — files Claude reads flash green (#00ff00), files it edits/creates flash red (#ff0000).
- **Neural cascade** — an activated node spreads attenuated light to its linked neighbors, like a synapse firing.
- **Session trail** — faded nodes keep a faint tint, so you can see the path Claude walked through your vault. Clear it with the *Clear session trail* command (or `POST /clear-trail`).
- **Always alive** — render cooldown disabled and force simulation kept warm; the graph keeps drifting under its real physics.

## Settings

- **Keep graph always awake** — never let the graph render loop sleep, so highlights animate fully.
- **Advanced highlight** — off: sensible defaults. On: edit the style as JSON (`color`, `writeColor`, `swell`, `hold`, `decay`, `pulse`, `cascade`, `trace`).
- **Keep graph alive (physics)** + **Liveliness** — keep the force simulation running so the graph never freezes.
- **Listener port** — default `8765`; use one port per vault if you run several at once (update the hook too).
- **Debug endpoints** — exposes extra localhost endpoints for development.

## Endpoints (localhost only)

Always on: `POST /read` (hook target) · `GET /status` · `POST /pulse` · `POST /clear-trail`
With debug enabled: `POST /pulse-all` · `POST /paint-all` · `POST /unpaint` · `POST /reset-view?scale=` · `GET /probe-green` · `POST /reload`

## Troubleshooting

**Nothing lights up?** Almost always a **port mismatch**. The port in the hook URL
(`http://127.0.0.1:<port>/read`) must match the plugin's **Listener port**
(Settings → Neural Vault, default `8765`). The hook's `curl` is silenced
(`--max-time 1 … >/dev/null 2>&1`), so a wrong port fails with no error — it looks
broken, not misconfigured.

Quick checks:
- `curl http://127.0.0.1:8765/status` → should respond. No response = plugin off, Obsidian not reloaded, or wrong port.
- Reload Obsidian (Cmd+R) after enabling the plugin or changing the port.
- Running several vaults? One port each, and update each vault's hook URL to match.

## Beta caveats

- Relies on **undocumented** internals of the core graph view — an Obsidian update may break it.
- Desktop only (`isDesktopOnly`).
- Tested on Obsidian 1.12.x, macOS.
