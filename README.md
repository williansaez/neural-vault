# Neural Vault

> **Beta** — watch your Obsidian vault light up like a brain while Claude Code reads it.

Neural Vault makes nodes in Obsidian's **native graph view** glow as [Claude Code](https://claude.com/claude-code) reads notes in your vault. Every file the agent touches flashes green on the graph — your knowledge base looks like neurons firing.

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

Add this hook to `<vault>/.claude/settings.json`:

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
      }
    ]
  }
}
```

Then run `claude` inside the vault, ask it to read some notes, and watch the graph.

> **Note:** the Claude desktop app (Cowork) does not fire hooks — use the Claude Code CLI.

## Settings

- **Keep graph always awake** — never let the graph render loop sleep, so highlights animate fully.
- **Advanced highlight** — off: green `#3BDB63`, 3× swell, ~2.5 s hold, medium fade. On: edit the style as JSON (`color`, `swell`, `hold`, `decay`, `pulse`).
- **Keep graph alive (physics)** + **Liveliness** — keep the force simulation running so the graph never freezes.

## Dev/debug endpoints (localhost only)

`POST /read` (the hook target) · `GET /status` · `POST /pulse` · `POST /pulse-all` · `POST /paint-all` · `POST /unpaint` · `POST /reset-view?scale=` · `GET /probe-green` · `POST /reload`

## Beta caveats

- Relies on **undocumented** internals of the core graph view — an Obsidian update may break it.
- Desktop only (`isDesktopOnly`), fixed port `8765`.
- Tested on Obsidian 1.12.x, macOS.
