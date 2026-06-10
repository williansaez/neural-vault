import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import * as http from "http";

const PORT = 8765;
const IDLE_RENDER_EVERY = 6; // when awake but no glow, repaint every Nth frame (~10fps)
const REHEAT_EVERY_MS = 450; // how often to top up the physics sim

interface NeuralSettings {
  keepAwake: boolean;
  animateNodes: boolean;
  liveliness: number; // physics alpha topped up each cycle (0 = still, ~0.3 = very lively)
  advanced: boolean; // when off, use the fixed defaults below; when on, use glowConfig
  glowConfig: string; // JSON: { color, swell, decay, pulse }
}
// Simple-mode defaults (also the starting point for the advanced JSON box)
const GLOW_DEFAULTS = { color: "#3BDB63", swell: 2.0, hold: 2.5, decay: 0.5, pulse: 0 };
const DEFAULT_GLOW = JSON.stringify(GLOW_DEFAULTS, null, 2);
const DEFAULT_SETTINGS: NeuralSettings = {
  keepAwake: true,
  animateNodes: true,
  liveliness: 0.1,
  advanced: false,
  glowConfig: DEFAULT_GLOW,
};

interface GlowCfg {
  color: number;
  swell: number;
  holdSecs: number; // time at full brightness before fading starts
  decaySecs: number; // wall-clock fade time — frame-rate independent
  pulseAmp: number;
}
// decay knob 0..1 -> visible fade time in real seconds (0.5 ~= 7s)
function decayKnobToSecs(knob: number): number {
  return Math.max(0.15, Math.min(1, Math.max(0, knob)) * 14);
}
function parseGlowConfig(raw: string, useDefaults: boolean): GlowCfg {
  let color = hexToInt(GLOW_DEFAULTS.color),
    swell = GLOW_DEFAULTS.swell,
    holdSecs = GLOW_DEFAULTS.hold,
    knob = GLOW_DEFAULTS.decay,
    pulseAmp = GLOW_DEFAULTS.pulse;
  if (!useDefaults) {
    try {
      const c = JSON.parse(raw);
      if (typeof c.color === "string") color = hexToInt(c.color);
      if (typeof c.swell === "number") swell = Math.max(0, c.swell);
      if (typeof c.hold === "number") holdSecs = Math.max(0, Math.min(30, c.hold));
      if (typeof c.decay === "number") knob = c.decay;
      if (typeof c.pulse === "number") pulseAmp = Math.max(0, Math.min(0.9, c.pulse));
    } catch {
      /* invalid JSON -> defaults */
    }
  }
  return { color, swell, holdSecs, decaySecs: decayKnobToSecs(knob), pulseAmp };
}

export default class NeuralVaultPlugin extends Plugin {
  server: http.Server | null = null;
  glow = new GlowController(this);
  settings: NeuralSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new NeuralSettingTab(this.app, this));

    this.addCommand({
      id: "neural-vault-dump",
      name: "Dump native graph internals (debug)",
      callback: () => this.glow.dumpInternals(),
    });
    this.addCommand({
      id: "neural-vault-test",
      name: "Test: pulse a random node",
      callback: () => this.glow.testPulse(),
    });

    this.startServer();

    // start the master loop (render-awake + node breathing) if either is on
    if (this.settings.keepAwake || this.settings.animateNodes) {
      this.app.workspace.onLayoutReady(() => this.glow.ensureLoop());
    }
    console.log("[Neural Vault] loaded");
  }

  onunload() {
    this.stopServer();
    this.glow.detach();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  startServer() {
    this.server = http.createServer((req, res) => {
      const ok = (body: string, type = "text/plain") => {
        res.writeHead(200, { "Content-Type": type });
        res.end(body);
      };
      if (req.method === "POST" && req.url === "/read") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const p = this.extractPath(body);
          if (p) this.glow.activate(p);
          ok("ok");
        });
      } else if (req.url === "/status") {
        const g = this.glow;
        const r = g.getGraphRenderer();
        const firstId = [...g.activation.keys()][0];
        const firstNode = firstId ? g.nodeByIdFast(firstId) : null;
        ok(
          JSON.stringify({
            rafId: g.rafId,
            activation: g.activation.size,
            lastPaintCount: g.lastPaintCount,
            firstId,
            firstLookupHit: !!firstNode,
            firstColor: firstNode?.color ?? null,
            firstWeight: firstNode?.weight ?? null,
            settings: this.settings,
            hasRenderer: !!r,
            nodeCount: r?.nodes?.length ?? 0,
            scale: r?.scale,
            sample: [...g.activation.entries()].slice(0, 5),
          }),
          "application/json"
        );
      } else if (req.method === "POST" && req.url === "/pulse") {
        this.glow.testPulse();
        ok("pulsed");
      } else if (req.method === "POST" && req.url === "/pulse-all") {
        // diagnostic: run EVERY node through the normal glow pipeline
        const r = this.glow.getGraphRenderer();
        if (r) {
          for (const n of r.nodes) this.glow.activation.set(n.id, 1);
          this.glow.ensureLoop();
        }
        ok("pulse-all " + (r?.nodes?.length ?? 0));
      } else if (req.method === "POST" && req.url?.startsWith("/reset-view")) {
        const r = this.glow.getGraphRenderer();
        const m = /scale=([\d.]+)/.exec(req.url ?? "");
        if (r) {
          if (m) {
            r.setScale(parseFloat(m[1]));
            r.targetScale = parseFloat(m[1]);
          }
          r.resetPan?.();
          r.changed?.();
        }
        ok("reset scale=" + (r?.scale ?? "?"));
      } else if (req.method === "POST" && req.url?.startsWith("/paint-all")) {
        // diagnostic: replicate the proven mass-color test (node.color + render)
        const r = this.glow.getGraphRenderer();
        const m = /rgb=([0-9a-fA-F]{6})/.exec(req.url ?? "");
        const rgb = m ? parseInt(m[1], 16) : 0x3bdb63;
        let painted = 0;
        if (r) {
          for (const n of r.nodes) {
            n.color = { a: 1, rgb };
            n.render?.();
            painted++;
          }
          r.queueRender?.();
        }
        ok("painted " + painted);
      } else if (req.method === "POST" && req.url === "/unpaint") {
        const r = this.glow.getGraphRenderer();
        if (r) {
          for (const n of r.nodes) {
            n.color = null;
            n.render?.();
          }
          r.queueRender?.();
        }
        ok("unpainted");
      } else if (req.url === "/probe-green") {
        // read back actual rendered pixels via PIXI extract — no human eyes needed
        try {
          const r = this.glow.getGraphRenderer();
          const px = r?.px;
          const ex = px?.renderer?.extract;
          if (!ex) {
            ok(JSON.stringify({ error: "no extract", hasPx: !!px }), "application/json");
            return;
          }
          const cv: any = ex.canvas(px.stage);
          const c2d = cv.getContext("2d");
          const img = c2d.getImageData(0, 0, cv.width, cv.height).data;
          let green = 0,
            drawn = 0;
          for (let i = 0; i < img.length; i += 4) {
            const R = img[i],
              G = img[i + 1],
              B = img[i + 2],
              A = img[i + 3];
            if (A > 30) drawn++;
            if (A > 30 && G > 110 && G > R + 25 && G > B + 25) green++;
          }
          ok(
            JSON.stringify({ w: cv.width, h: cv.height, drawn, green }),
            "application/json"
          );
        } catch (e: any) {
          ok(JSON.stringify({ error: String(e?.message ?? e) }), "application/json");
        }
      } else if (req.method === "POST" && req.url === "/reload") {
        ok("reloading");
        window.setTimeout(() => window.location.reload(), 200);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.server.on("error", (e: Error) =>
      new Notice("Neural Vault: server error — " + e.message)
    );
    this.server.listen(PORT, "127.0.0.1", () =>
      console.log(`[Neural Vault] listening 127.0.0.1:${PORT}`)
    );
  }

  stopServer() {
    this.server?.close();
    this.server = null;
  }

  extractPath(body: string): string | null {
    try {
      const j = JSON.parse(body);
      const abs: string | undefined =
        j?.tool_input?.file_path ?? j?.file_path ?? undefined;
      if (!abs) return null;
      const base: string | undefined = (this.app.vault.adapter as any).basePath;
      let rel = abs;
      if (base && abs.startsWith(base)) rel = abs.slice(base.length);
      return rel.replace(/^[/\\]+/, "");
    } catch {
      return null;
    }
  }
}

class GlowController {
  plugin: NeuralVaultPlugin;
  activation = new Map<string, number>();
  origColor = new Map<string, any>();
  origScale = new Map<string, number>();
  renderer: any = null;
  rafId: number | null = null;
  dumped = false;
  frame = 0;
  lastReheat = 0; // last time we topped up the physics sim
  lastGlowTs = 0; // last applyGlow timestamp, for wall-clock decay
  lastPaintCount = 0; // diagnostics: nodes painted in the last applyGlow pass
  holdUntil = new Map<string, number>(); // per-node: full brightness until this time

  constructor(plugin: NeuralVaultPlugin) {
    this.plugin = plugin;
  }

  getGraphRenderer(): any {
    const ws = this.plugin.app.workspace;
    const leaf =
      ws.getLeavesOfType("graph")[0] ?? ws.getLeavesOfType("localgraph")[0];
    if (!leaf) return null;
    const view: any = leaf.view;
    return view?.renderer ?? null;
  }

  ensureAttached(): boolean {
    // always re-resolve: the graph leaf/renderer is recreated on reopen
    const r = this.getGraphRenderer();
    if (!r) {
      new Notice("Neural Vault: open the graph view first.");
      return false;
    }
    this.renderer = r;
    if (!this.dumped) {
      this.dumpInternals();
      this.dumped = true;
    }
    return true;
  }

  detach() {
    this.stopLoop();
    this.renderer = null;
  }

  // Master loop. Runs while keepAwake is on (graph never cools) OR while a
  // glow is animating. Re-acquires the renderer each frame so it survives the
  // graph view being closed/reopened.
  loopWanted(): boolean {
    const s = this.plugin.settings;
    return s.keepAwake || s.animateNodes || this.activation.size > 0;
  }

  ensureLoop() {
    if (this.rafId != null) return;
    const loop = () => {
      const s = this.plugin.settings;
      const r = this.getGraphRenderer();
      if (r) {
        this.renderer = r;
        const active = this.activation.size > 0;
        if (s.keepAwake || s.animateNodes) r.idleFrames = 0; // disable cooldown
        if (active) this.applyGlow();
        const moving = s.animateNodes ? this.keepPhysicsWarm(r) : false;
        this.frame++;
        const idleTick = s.keepAwake && this.frame % IDLE_RENDER_EVERY === 0;
        if (active || moving || idleTick) this.forceRender();
      }
      if (this.loopWanted()) {
        this.rafId = window.requestAnimationFrame(loop);
      } else {
        this.rafId = null;
        this.forceRender(); // final repaint after restore
      }
    };
    this.rafId = window.requestAnimationFrame(loop);
  }

  // Keep Obsidian's REAL force simulation alive (links pull, repulsion pushes)
  // instead of overwriting positions. The sim runs in a Web Worker and cools
  // via alpha decay; there's no public off-switch, so we periodically top up
  // alpha by posting to the worker — exactly what setForces / dragging does.
  // Returns true while the sim is being kept warm (so we keep repainting).
  keepPhysicsWarm(r: any): boolean {
    const alpha = this.plugin.settings.liveliness;
    if (alpha <= 0 || !r.worker?.postMessage) return false;
    const t = performance.now();
    if (t - this.lastReheat >= REHEAT_EVERY_MS) {
      r.worker.postMessage({ alpha, run: true });
      this.lastReheat = t;
    }
    return true;
  }

  stopLoop() {
    if (this.rafId != null) window.cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  activate(path: string) {
    if (!this.ensureAttached()) return;
    const node = this.findNode(path);
    if (node) {
      const id = this.nodeId(node);
      const cfg = parseGlowConfig(
        this.plugin.settings.glowConfig,
        !this.plugin.settings.advanced
      );
      this.activation.set(id, 1);
      this.holdUntil.set(id, performance.now() + cfg.holdSecs * 1000);
      this.ensureLoop();
    } else {
      console.log("[Neural Vault] no node matched for", path);
    }
  }

  testPulse() {
    if (!this.ensureAttached()) return;
    const nodes = this.nodes().slice();
    if (!nodes.length) {
      new Notice("Neural Vault: graph has no nodes yet.");
      return;
    }
    // light the 150 most-connected nodes so the effect is unmistakable
    nodes.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const cfg = parseGlowConfig(
      this.plugin.settings.glowConfig,
      !this.plugin.settings.advanced
    );
    const until = performance.now() + cfg.holdSecs * 1000;
    const sample = nodes.slice(0, 150);
    for (const n of sample) {
      this.activation.set(this.nodeId(n), 1);
      this.holdUntil.set(this.nodeId(n), until);
    }
    this.ensureLoop();
    new Notice(`Neural Vault: pulsed ${sample.length} top nodes`);
  }

  nodes(): any[] {
    const r = this.renderer;
    if (!r) return [];
    return r.nodes ?? r.graph?.nodes ?? [];
  }

  nodeId(n: any): string {
    return n?.id ?? n?.name ?? "";
  }

  nodeIndex = new Map<string, any>();
  nodeIndexCount = -1;

  nodeByIdFast(id: string): any | null {
    const r = this.renderer;
    if (!r) return null;
    const direct = r.nodeLookup?.[id];
    if (direct) return direct;
    // nodeLookup can be stale/empty — keep our own id index off renderer.nodes
    const nodes = r.nodes ?? [];
    if (this.nodeIndexCount !== nodes.length) {
      this.nodeIndex.clear();
      for (const n of nodes) this.nodeIndex.set(n.id, n);
      this.nodeIndexCount = nodes.length;
    }
    return this.nodeIndex.get(id) ?? null;
  }

  findNode(path: string): any | null {
    const fast = this.nodeByIdFast(path);
    if (fast) return fast;
    const nodes = this.nodes();
    for (const n of nodes) if (this.nodeId(n) === path) return n;
    for (const n of nodes) {
      const id = this.nodeId(n);
      if (id && (id.endsWith(path) || path.endsWith(id))) return n;
    }
    return null;
  }

  forceRender() {
    const r = this.renderer;
    if (!r) return;
    // Disable the render cooldown: Obsidian sleeps the paint loop once
    // idleFrames passes a threshold. Pinning it to 0 every frame keeps the
    // loop awake so our glow animates instead of freezing mid-fade.
    r.idleFrames = 0;
    // queueRender() repaints the stage as-is (keeps our tint); changed() may
    // recompute colors, so prefer queueRender.
    if (typeof r.queueRender === "function") r.queueRender();
    else if (typeof r.changed === "function") r.changed();
  }

  capture(id: string, n: any) {
    if (this.origColor.has(id)) return;
    this.origColor.set(id, n.color ?? null);
    this.origScale.set(id, n.circle?.scale?.x ?? 1);
  }

  restore(id: string) {
    const n = this.nodeByIdFast(id);
    if (n) {
      n.color = this.origColor.get(id) ?? null;
      n.render?.(); // repaint with restored color
      const s = this.origScale.get(id) ?? 1;
      n.circle?.scale?.set?.(s, s);
    }
    this.origColor.delete(id);
    this.origScale.delete(id);
  }

  // Drive the glow through the node's own color + size, then node.render() — the
  // official path the renderer reads (circle.tint gets clobbered by node.render).
  applyGlow() {
    const t = performance.now();
    const cfg = parseGlowConfig(
      this.plugin.settings.glowConfig,
      !this.plugin.settings.advanced
    );
    const pulse = 1 - cfg.pulseAmp + cfg.pulseAmp * Math.sin(t * 0.008);
    // wall-clock decay: brightness hits ~1% after decaySecs, at any frame rate
    const dt = this.lastGlowTs > 0 ? Math.min(0.25, (t - this.lastGlowTs) / 1000) : 0;
    this.lastGlowTs = t;
    const decayFactor = Math.exp((Math.log(0.01) / cfg.decaySecs) * dt);

    let painted = 0;
    for (const [id, a] of this.activation) {
      const n = this.nodeByIdFast(id);
      if (!n) continue;
      painted++;
      this.capture(id, n);
      // sqrt curve: color/size stay perceptually strong much longer into the fade
      const k = Math.min(1, Math.sqrt(a) * pulse);
      const base = this.origColor.get(id);
      const fromRgb = base && typeof base.rgb === "number" ? base.rgb : 0x888f9c;
      n.color = { a: 1, rgb: lerpInt(fromRgb, cfg.color, k) };
      n.render?.(); // applies color (NEVER touch n.weight — engine resets color)
      // swell via the PIXI sprite, applied after render (render resets transform)
      const baseScale = this.origScale.get(id) ?? 1;
      const s = baseScale * (1 + k * cfg.swell);
      n.circle?.scale?.set?.(s, s);
    }
    this.lastPaintCount = painted;

    // decay + restore finished nodes (hold keeps full brightness first)
    for (const [id, v] of this.activation) {
      if ((this.holdUntil.get(id) ?? 0) > t) continue; // still holding
      const nv = v * decayFactor;
      if (nv < 0.01) {
        this.restore(id);
        this.activation.delete(id);
        this.holdUntil.delete(id);
      } else {
        this.activation.set(id, nv);
      }
    }
  }

  async dumpInternals() {
    const r = this.renderer ?? this.getGraphRenderer();
    const out: any = { ts: new Date().toISOString() };
    if (!r) {
      out.error = "no renderer (open the graph view)";
    } else {
      out.rendererKeys = Object.keys(r);
      // collect callable methods up the prototype chain
      const methods = new Set<string>();
      let proto = Object.getPrototypeOf(r);
      while (proto && proto !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(proto)) {
          try {
            if (typeof r[k] === "function") methods.add(k);
          } catch {
            /* getter may throw */
          }
        }
        proto = Object.getPrototypeOf(proto);
      }
      out.rendererMethods = [...methods].sort();
      out.hasChanged = typeof r.changed === "function";
      out.hasRender = typeof r.render === "function";
      out.hasPx = !!r.px;
      out.hasPxTicker = !!r?.px?.ticker;
      const nodes = r.nodes ?? r.graph?.nodes ?? [];
      out.nodeCount = nodes.length;
      out.nodesField = r.nodes ? "renderer.nodes" : r.graph?.nodes ? "renderer.graph.nodes" : "??";
      if (nodes.length) {
        const n = nodes[0];
        out.sampleNodeKeys = Object.keys(n);
        out.sampleNodeId = n.id ?? n.name ?? null;
        out.sampleNodeColor = n.color ?? null;
        // find any node that currently HAS a color (e.g. from a color group)
        for (const m of nodes) {
          if (m.color != null) {
            out.exampleColoredNode = { id: m.id, color: m.color };
            break;
          }
        }
        const sprite = n.circle ?? n.graphics ?? n.sprite ?? null;
        out.spriteField = n.circle ? "circle" : n.graphics ? "graphics" : n.sprite ? "sprite" : "??";
        if (sprite) {
          out.spriteKeys = Object.keys(sprite);
          out.spriteHasTint = typeof sprite.tint;
          out.spriteHasScale = !!sprite.scale;
          out.spriteHasAlpha = typeof sprite.alpha;
        }
      }
    }
    const json = JSON.stringify(out, null, 2);
    try {
      await this.plugin.app.vault.adapter.write(".neural-vault-debug.json", json);
      new Notice("Neural Vault: dumped internals -> .neural-vault-debug.json");
    } catch (e) {
      new Notice("Neural Vault: dump write failed");
    }
    console.log("[Neural Vault] internals", out);
  }
}

class NeuralSettingTab extends PluginSettingTab {
  plugin: NeuralVaultPlugin;

  constructor(app: any, plugin: NeuralVaultPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Keep graph always awake")
      .setDesc(
        "Disable Obsidian's graph render cooldown so node highlights never freeze. Uses a little more CPU while the graph view is open."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.keepAwake).onChange(async (v) => {
          this.plugin.settings.keepAwake = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.glow.ensureLoop();
        })
      );

    new Setting(containerEl)
      .setName("Advanced highlight")
      .setDesc(
        "Off: green (#3BDB63), swell 2.0, medium fade, no pulse. On: edit the full highlight style as JSON below."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.advanced).onChange(async (v) => {
          this.plugin.settings.advanced = v;
          await this.plugin.saveSettings();
          this.display(); // re-render to show/hide the JSON editor
        })
      );

    if (this.plugin.settings.advanced) {
      this.renderGlowEditor(containerEl);
    }

    new Setting(containerEl)
      .setName("Keep graph alive (physics)")
      .setDesc(
        "Keep Obsidian's real force simulation warm so the graph never freezes — nodes keep moving under their actual link/repulsion forces, like a living brain. Obsidian has no setting for this, so the plugin tops up the sim itself."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.animateNodes).onChange(async (v) => {
          this.plugin.settings.animateNodes = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.glow.ensureLoop();
        })
      );

    new Setting(containerEl)
      .setName("Liveliness")
      .setDesc(
        "How much energy to keep in the physics sim. 0 = still, low = gentle drift, high = constantly reshuffling."
      )
      .addSlider((s) =>
        s
          .setLimits(0, 0.4, 0.02)
          .setValue(this.plugin.settings.liveliness)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.liveliness = v;
            await this.plugin.saveSettings();
          })
      );
  }

  renderGlowEditor(containerEl: HTMLElement) {
    const wrap = containerEl.createDiv();
    wrap.style.margin = "4px 0 18px";
    wrap.style.padding = "14px 16px";
    wrap.style.border = "1px solid var(--background-modifier-border)";
    wrap.style.borderRadius = "10px";
    wrap.style.background = "var(--background-secondary)";

    const title = wrap.createEl("div", { text: "Highlight style (JSON)" });
    title.style.fontWeight = "600";
    title.style.marginBottom = "8px";

    const legend = wrap.createEl("ul");
    legend.style.margin = "0 0 12px";
    legend.style.paddingLeft = "18px";
    legend.style.fontSize = "var(--font-ui-smaller)";
    legend.style.lineHeight = "1.7";
    legend.style.color = "var(--text-muted)";
    const li = (html: string) => {
      legend.createEl("li").innerHTML = html;
    };
    li('<code>color</code> — glow color, hex string e.g. <code>"#3BDB63"</code>');
    li('<code>swell</code> — node growth; <code>2.0</code> ≈ 3× size, <code>0</code> = none');
    li('<code>hold</code> — seconds at full brightness before fading (e.g. <code>2.5</code>)');
    li('<code>decay</code> — fade length <code>0</code>–<code>1</code> (0.1 quick · 0.5 medium · 1 long)');
    li('<code>pulse</code> — throb <code>0</code>–<code>0.9</code> (<code>0</code> = steady)');
    li("missing/invalid keys fall back to defaults");

    const ta = wrap.createEl("textarea");
    ta.value = this.plugin.settings.glowConfig;
    ta.spellcheck = false;
    ta.rows = 8;
    ta.style.width = "100%";
    ta.style.boxSizing = "border-box";
    ta.style.resize = "vertical";
    ta.style.fontFamily = "var(--font-monospace)";
    ta.style.fontSize = "var(--font-ui-small)";
    ta.style.lineHeight = "1.5";
    ta.style.padding = "10px 12px";
    ta.style.borderRadius = "6px";

    const status = wrap.createEl("div");
    status.style.fontSize = "var(--font-ui-smaller)";
    status.style.marginTop = "8px";
    const validate = () => {
      try {
        JSON.parse(ta.value);
        status.setText("✓ valid JSON");
        status.style.color = "var(--text-success)";
      } catch {
        status.setText("✗ invalid JSON — using defaults until fixed");
        status.style.color = "var(--text-error)";
      }
    };
    validate();
    ta.addEventListener("input", async () => {
      this.plugin.settings.glowConfig = ta.value;
      await this.plugin.saveSettings();
      validate();
    });

    const reset = wrap.createEl("button", { text: "Reset to default" });
    reset.style.marginTop = "12px";
    reset.onclick = async () => {
      this.plugin.settings.glowConfig = DEFAULT_GLOW;
      await this.plugin.saveSettings();
      this.display();
    };
  }
}

function hexToInt(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (m) return parseInt(m[1], 16);
  return 0x3bdb63; // vivid green fallback
}

function lerpInt(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff;
  const br = (b >> 16) & 0xff,
    bg = (b >> 8) & 0xff,
    bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
