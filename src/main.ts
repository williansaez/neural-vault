import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import * as http from "http";

const IDLE_RENDER_EVERY = 6; // when awake but no glow, repaint every Nth frame (~10fps)
const REHEAT_EVERY_MS = 450; // how often to top up the physics sim
const TRACE_REASSERT_EVERY = 30; // frames between re-painting session-trail nodes

interface NeuralSettings {
  keepAwake: boolean;
  animateNodes: boolean;
  liveliness: number; // physics alpha topped up each cycle (0 = still, ~0.3 = very lively)
  advanced: boolean; // when off, use the fixed defaults below; when on, use glowConfig
  glowConfig: string; // JSON: { color, writeColor, swell, hold, decay, pulse, cascade, trace }
  port: number; // localhost listener port
  debugEndpoints: boolean; // expose /paint-all, /pulse-all, /probe-green, /reset-view
}
// Simple-mode defaults (also the starting point for the advanced JSON box)
const GLOW_DEFAULTS = {
  color: "#00ff00", // Read glow
  writeColor: "#ff0000", // Edit/Write glow
  swell: 2.0,
  hold: 2.5,
  decay: 0.5,
  pulse: 0,
  cascade: 0.45, // neighbor brightness (0 = off)
  trace: 0.18, // session-trail tint strength (0 = off)
};
const DEFAULT_GLOW = JSON.stringify(GLOW_DEFAULTS, null, 2);
const DEFAULT_SETTINGS: NeuralSettings = {
  keepAwake: true,
  animateNodes: true,
  liveliness: 0.1,
  advanced: false,
  glowConfig: DEFAULT_GLOW,
  port: 8765,
  debugEndpoints: false,
};

interface GlowCfg {
  color: number;
  writeColor: number;
  swell: number;
  holdSecs: number; // time at full brightness before fading starts
  decaySecs: number; // wall-clock fade time — frame-rate independent
  pulseAmp: number;
  cascade: number; // 0..1 neighbor activation level
  trace: number; // 0..0.5 persistent session-trail tint
}
// decay knob 0..1 -> visible fade time in real seconds (0.5 ~= 7s).
// Negative (-1) = never fade: Infinity makes the decay factor exp(0) = 1.
function decayKnobToSecs(knob: number): number {
  if (knob < 0) return Infinity;
  return Math.max(0.15, Math.min(1, knob) * 14);
}
function parseGlowConfig(raw: string, useDefaults: boolean): GlowCfg {
  let color = hexToInt(GLOW_DEFAULTS.color),
    writeColor = hexToInt(GLOW_DEFAULTS.writeColor),
    swell = GLOW_DEFAULTS.swell,
    holdSecs = GLOW_DEFAULTS.hold,
    knob = GLOW_DEFAULTS.decay,
    pulseAmp = GLOW_DEFAULTS.pulse,
    cascade = GLOW_DEFAULTS.cascade,
    trace = GLOW_DEFAULTS.trace;
  if (!useDefaults) {
    try {
      const c = JSON.parse(raw);
      if (typeof c.color === "string") color = hexToInt(c.color, color);
      if (typeof c.writeColor === "string")
        writeColor = hexToInt(c.writeColor, writeColor); // bad value keeps red, not green
      if (typeof c.swell === "number") swell = Math.max(0, c.swell);
      if (typeof c.hold === "number")
        holdSecs = c.hold < 0 ? Infinity : Math.min(30, c.hold); // -1 = hold forever
      if (typeof c.decay === "number") knob = c.decay;
      if (typeof c.pulse === "number") pulseAmp = Math.max(0, Math.min(0.9, c.pulse));
      if (typeof c.cascade === "number") cascade = Math.max(0, Math.min(1, c.cascade));
      if (typeof c.trace === "number") trace = Math.max(0, Math.min(0.5, c.trace));
    } catch {
      /* invalid JSON -> defaults */
    }
  }
  return {
    color,
    writeColor,
    swell,
    holdSecs,
    decaySecs: decayKnobToSecs(knob),
    pulseAmp,
    cascade,
    trace,
  };
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

    this.addCommand({
      id: "neural-vault-clear-trail",
      name: "Clear session trail",
      callback: () => this.glow.clearTrail(),
    });

    this.startServer();

    // cascade uses a backlink index built from resolvedLinks; invalidate on change
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => (this.glow.reverseLinks = null))
    );

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
      const debugOn = this.settings.debugEndpoints;
      if (req.method === "POST" && req.url === "/read") {
        // Write/Edit hook payloads carry full file contents — cap what we buffer
        const MAX_BODY = 4 * 1024 * 1024;
        let body = "";
        let truncated = false;
        req.on("data", (c) => {
          if (body.length < MAX_BODY) body += c;
          else truncated = true;
        });
        req.on("end", () => {
          // file_path lives at the head of the JSON; a truncated tail still parses
          // if we got lucky, otherwise extractEvent returns null and we drop it
          const ev = this.extractEvent(truncated ? body.slice(0, 64 * 1024) : body);
          if (ev) this.glow.activate(ev.path, ev.kind);
          ok("ok");
        });
      } else if (req.method === "POST" && req.url === "/clear-trail") {
        this.glow.clearTrail();
        ok("trail cleared");
      } else if (req.url === "/status") {
        const g = this.glow;
        const r = g.getGraphRenderer();
        const firstId = [...g.activation.keys()][0];
        const firstNode = firstId ? g.nodeByIdFast(firstId) : null;
        ok(
          JSON.stringify({
            rafId: g.rafId,
            activation: g.activation.size,
            traced: g.traced.size,
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
      } else if (debugOn && req.method === "POST" && req.url === "/pulse-all") {
        // diagnostic: run EVERY node through the normal glow pipeline
        const r = this.glow.getGraphRenderer();
        if (r) {
          for (const n of r.nodes) {
            this.glow.activation.set(n.id, 1);
            this.glow.transient.add(n.id); // diagnostics never leave a trail
          }
          this.glow.ensureLoop();
        }
        ok("pulse-all " + (r?.nodes?.length ?? 0));
      } else if (debugOn && req.method === "POST" && req.url?.startsWith("/reset-view")) {
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
      } else if (debugOn && req.method === "POST" && req.url?.startsWith("/paint-all")) {
        // diagnostic: replicate the proven mass-color test (node.color + render)
        const r = this.glow.getGraphRenderer();
        const m = /rgb=([0-9a-fA-F]{6})/.exec(req.url ?? "");
        const rgb = m ? parseInt(m[1], 16) : 0x00ff00;
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
      } else if (debugOn && req.method === "POST" && req.url === "/unpaint") {
        const r = this.glow.getGraphRenderer();
        if (r) {
          for (const n of r.nodes) {
            n.color = null;
            n.render?.();
          }
          r.queueRender?.();
        }
        ok("unpainted");
      } else if (debugOn && req.url === "/probe-green") {
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
      } else if (debugOn && req.method === "POST" && req.url === "/reload") {
        ok("reloading");
        window.setTimeout(() => window.location.reload(), 200);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const port = this.settings.port || 8765;
    this.server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        new Notice(
          `Neural Vault: port ${port} is already in use (another vault open?). ` +
            `Change the port in Settings → Neural Vault.`,
          10000
        );
      } else {
        new Notice("Neural Vault: server error — " + e.message);
      }
    });
    this.server.listen(port, "127.0.0.1", () =>
      console.log(`[Neural Vault] listening 127.0.0.1:${port}`)
    );
  }

  stopServer() {
    this.server?.close();
    this.server = null;
  }

  extractEvent(body: string): { path: string; kind: "read" | "write" } | null {
    try {
      let abs: string | undefined;
      let toolName: string | undefined;
      try {
        const j = JSON.parse(body);
        abs =
          j?.tool_input?.file_path ??
          j?.tool_input?.notebook_path ?? // NotebookEdit uses notebook_path
          j?.file_path ??
          undefined;
        toolName = j?.tool_name;
      } catch {
        // truncated payload (huge Write bodies): both fields live near the head
        abs = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(body)?.[1];
        toolName = /"tool_name"\s*:\s*"([^"]+)"/.exec(body)?.[1];
        if (abs) abs = JSON.parse(`"${abs}"`); // unescape
      }
      if (!abs) return null;
      const base: string | undefined = (this.app.vault.adapter as any).basePath;
      // only light up files that actually belong to THIS vault — with several
      // vaults open, suffix matching could otherwise glow the wrong graph
      const isAbsolute = /^([/\\]|[A-Za-z]:[/\\])/.test(abs);
      const inVault =
        !!base &&
        abs.startsWith(base) &&
        // boundary check: "/Vaults/Work" must not match "/Vaults/Work-Archive"
        (abs.length === base.length || abs[base.length] === "/" || abs[base.length] === "\\");
      if (base && isAbsolute && !inVault) return null;
      const rel = inVault ? abs.slice(base!.length) : abs;
      const kind = /^(Edit|Write|MultiEdit|NotebookEdit)$/i.test(toolName ?? "Read")
        ? ("write" as const)
        : ("read" as const);
      return { path: rel.replace(/^[/\\]+/, ""), kind };
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
  kinds = new Map<string, "read" | "write">(); // last event kind per node
  traced = new Map<string, "read" | "write">(); // session trail: faded nodes keep a tint
  reverseLinks: Map<string, Set<string>> | null = null; // backlink index for cascade

  cachedCfg: GlowCfg | null = null;
  cachedCfgKey = "";
  disposed = false; // set on detach; blocks late HTTP callbacks from resurrecting the loop
  transient = new Set<string>(); // test-pulse activations: never leave a trail
  lastK = new Map<string, number>(); // last painted brightness, to skip redundant renders
  traceCursor = 0; // round-robin index for amortized trail reasserts
  lastIndexRebuild = 0;

  constructor(plugin: NeuralVaultPlugin) {
    this.plugin = plugin;
  }

  getCfg(): GlowCfg {
    const s = this.plugin.settings;
    const key = (s.advanced ? "1" : "0") + s.glowConfig;
    if (!this.cachedCfg || this.cachedCfgKey !== key) {
      this.cachedCfg = parseGlowConfig(s.glowConfig, !s.advanced);
      this.cachedCfgKey = key;
    }
    return this.cachedCfg;
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
    this.disposed = true; // late HTTP callbacks must not resurrect the loop
    this.stopLoop();
    // leave the graph exactly as we found it
    for (const id of [...this.activation.keys()]) this.restoreNode(id);
    for (const id of [...this.traced.keys()]) this.restoreNode(id);
    this.activation.clear();
    this.traced.clear();
    this.holdUntil.clear();
    this.transient.clear();
    this.lastK.clear();
    this.forceRender();
    this.renderer = null;
  }

  // Master loop. Runs while keepAwake is on (graph never cools) OR while a
  // glow is animating. Re-acquires the renderer each frame so it survives the
  // graph view being closed/reopened.
  loopWanted(): boolean {
    const s = this.plugin.settings;
    return (
      s.keepAwake || s.animateNodes || this.activation.size > 0 || this.traced.size > 0
    );
  }

  ensureLoop() {
    if (this.disposed) return;
    if (this.rafId != null) return;
    const loop = () => {
      // schedule first: a throw in the body must never kill the loop for good
      this.rafId = this.loopWanted() && !this.disposed
        ? window.requestAnimationFrame(loop)
        : null;
      try {
        const s = this.plugin.settings;
        const r = this.getGraphRenderer();
        if (!r) return;
        this.renderer = r;
        const active = this.activation.size > 0;
        if (s.keepAwake || s.animateNodes) r.idleFrames = 0; // disable cooldown
        if (active) this.applyGlow();
        const moving = s.animateNodes ? this.keepPhysicsWarm(r) : false;
        this.frame++;
        // session trail: engine repaints can wipe the tint — re-assert a small
        // slice per frame (round-robin) instead of all traced nodes at once
        let traceTouched = false;
        if (this.traced.size) {
          const cfg = this.getCfg();
          const ids = [...this.traced.keys()];
          const per = Math.max(1, Math.ceil(ids.length / TRACE_REASSERT_EVERY));
          for (let i = 0; i < per; i++) {
            const id = ids[(this.traceCursor + i) % ids.length];
            if (!this.activation.has(id)) {
              this.paintTrace(id, cfg);
              traceTouched = true;
            }
          }
          this.traceCursor = (this.traceCursor + per) % ids.length;
        }
        const idleTick = s.keepAwake && this.frame % IDLE_RENDER_EVERY === 0;
        if (active || moving || (traceTouched && idleTick) || idleTick) {
          this.forceRender();
        }
      } catch (e) {
        console.error("[Neural Vault] loop error (continuing)", e);
      }
      if (this.rafId == null) this.forceRender(); // final repaint after restore
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

  activate(path: string, kind: "read" | "write" = "read") {
    if (this.disposed) return;
    if (!this.ensureAttached()) return;
    const node = this.findNode(path);
    if (!node) {
      console.log("[Neural Vault] no node matched for", path);
      return;
    }
    const id = this.nodeId(node);
    const cfg = this.getCfg();
    const now = performance.now();
    this.activation.set(id, 1);
    this.kinds.set(id, kind);
    this.holdUntil.set(id, now + cfg.holdSecs * 1000);
    this.lastK.delete(id);
    this.traced.delete(id); // back to live glow; re-traced when it fades out

    // cascade: light direct neighbors at reduced brightness (synaptic spread)
    if (cfg.cascade > 0) {
      for (const nb of this.neighborsOf(id)) {
        // only nodes actually present in the current graph view — tracing a
        // node we never painted would corrupt its "original color" later
        if (!this.nodeByIdFast(nb)) continue;
        // refresh the (shorter) neighbor hold even if already at cascade level
        this.holdUntil.set(
          nb,
          Math.max(this.holdUntil.get(nb) ?? 0, now + cfg.holdSecs * 400)
        );
        const cur = this.activation.get(nb) ?? 0;
        if (cur >= cfg.cascade) continue; // never dim a stronger activation
        this.activation.set(nb, cfg.cascade);
        if (!this.kinds.has(nb)) this.kinds.set(nb, kind);
        this.lastK.delete(nb);
        this.traced.delete(nb);
      }
    }
    this.ensureLoop();
  }

  // direct neighbors (outgoing + incoming links) of a node, by vault path
  neighborsOf(id: string): string[] {
    const mc = this.plugin.app.metadataCache;
    const resolved = mc.resolvedLinks ?? {};
    const out = Object.keys(resolved[id] ?? {});
    if (!this.reverseLinks) {
      const rev = new Map<string, Set<string>>();
      for (const src in resolved) {
        for (const dest in resolved[src]) {
          let s = rev.get(dest);
          if (!s) rev.set(dest, (s = new Set()));
          s.add(src);
        }
      }
      this.reverseLinks = rev;
    }
    const inc = [...(this.reverseLinks.get(id) ?? [])];
    return [...new Set([...out, ...inc])];
  }

  clearTrail() {
    // full reset: trail AND live glows (incl. hold:-1 "forever" highlights)
    for (const id of [...this.traced.keys()]) this.restoreNode(id);
    for (const id of [...this.activation.keys()]) this.restoreNode(id);
    this.traced.clear();
    this.activation.clear();
    this.holdUntil.clear();
    this.transient.clear();
    this.lastK.clear();
    this.forceRender();
    new Notice("Neural Vault: highlights cleared");
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
    const cfg = this.getCfg();
    const until = performance.now() + cfg.holdSecs * 1000;
    const sample = nodes.slice(0, 150);
    for (const n of sample) {
      const id = this.nodeId(n);
      this.activation.set(id, 1);
      this.holdUntil.set(id, until);
      this.transient.add(id); // test pulse must not pollute the session trail
      this.lastK.delete(id);
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
    let hit = this.nodeIndex.get(id);
    // equal-count swaps (rename) keep the count but change ids — on a miss,
    // rebuild at most once per 2s so we don't serve destroyed node objects
    if (!hit && performance.now() - this.lastIndexRebuild > 2000) {
      this.lastIndexRebuild = performance.now();
      this.nodeIndex.clear();
      for (const n of nodes) this.nodeIndex.set(n.id, n);
      this.nodeIndexCount = nodes.length;
      hit = this.nodeIndex.get(id);
    }
    return hit ?? null;
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

  // full restore: node returns to its untouched look
  restoreNode(id: string) {
    const n = this.nodeByIdFast(id);
    if (n) {
      n.color = this.origColor.get(id) ?? null;
      n.render?.(); // repaint with restored color
      const s = this.origScale.get(id) ?? 1;
      n.circle?.scale?.set?.(s, s);
    }
    this.origColor.delete(id);
    this.origScale.delete(id);
    this.kinds.delete(id);
    this.lastK.delete(id);
    this.transient.delete(id);
  }

  // a glow finished fading: either restore fully or leave the session-trail tint
  onFadeOut(id: string, cfg: GlowCfg) {
    const wasPainted = this.origColor.has(id); // node existed and we touched it
    const isTransient = this.transient.delete(id); // test pulses leave no trail
    if (cfg.trace > 0 && wasPainted && !isTransient) {
      this.traced.set(id, this.kinds.get(id) ?? "read");
      this.paintTrace(id, cfg);
      // scale back to normal — only the tint stays
      const n = this.nodeByIdFast(id);
      const s = this.origScale.get(id) ?? 1;
      n?.circle?.scale?.set?.(s, s);
    } else {
      this.restoreNode(id);
    }
  }

  paintTrace(id: string, cfg: GlowCfg) {
    const n = this.nodeByIdFast(id);
    if (!n) return;
    const base = this.origColor.get(id);
    const fromRgb = base && typeof base.rgb === "number" ? base.rgb : 0x888f9c;
    const kindColor = this.traced.get(id) === "write" ? cfg.writeColor : cfg.color;
    n.color = { a: 1, rgb: lerpInt(fromRgb, kindColor, cfg.trace) };
    n.render?.();
  }

  // Drive the glow through the node's own color + size, then node.render() — the
  // official path the renderer reads (circle.tint gets clobbered by node.render).
  applyGlow() {
    const t = performance.now();
    const cfg = this.getCfg();
    // throb between (1 - pulseAmp) and 1 — never negative, no color extrapolation
    const pulse = 1 - cfg.pulseAmp * (0.5 - 0.5 * Math.sin(t * 0.008));
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
      const k = Math.max(0, Math.min(1, Math.sqrt(a) * pulse));
      // hold phase with no pulse = constant k: skip the PIXI rebuild, but still
      // re-assert every few frames in case the engine repainted over us
      const prevK = this.lastK.get(id);
      if (
        prevK !== undefined &&
        Math.abs(prevK - k) < 0.004 &&
        this.frame % IDLE_RENDER_EVERY !== 0
      ) {
        continue;
      }
      this.lastK.set(id, k);
      const base = this.origColor.get(id);
      const fromRgb = base && typeof base.rgb === "number" ? base.rgb : 0x888f9c;
      const kindColor = this.kinds.get(id) === "write" ? cfg.writeColor : cfg.color;
      n.color = { a: 1, rgb: lerpInt(fromRgb, kindColor, k) };
      n.render?.(); // applies color (NEVER touch n.weight — engine resets color)
      // swell via the PIXI sprite, applied after render (render resets transform)
      const baseScale = this.origScale.get(id) ?? 1;
      const s = baseScale * (1 + k * cfg.swell);
      n.circle?.scale?.set?.(s, s);
    }
    this.lastPaintCount = painted;

    // decay + finish faded nodes (hold keeps full brightness first)
    for (const [id, v] of this.activation) {
      if ((this.holdUntil.get(id) ?? 0) > t) continue; // still holding
      const nv = v * decayFactor;
      if (nv < 0.01) {
        this.onFadeOut(id, cfg);
        this.activation.delete(id);
        this.holdUntil.delete(id);
        this.lastK.delete(id);
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
        "Off: reads glow green (#00ff00), writes glow red (#ff0000), swell 2.0, medium fade. On: edit the full highlight style as JSON below."
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
      .setName("Listener port")
      .setDesc(
        "Localhost port the Claude Code hook posts to (default 8765). Use a different port per vault if you run several at once. Applies immediately; remember to update the port in the vault's .claude/settings.json hook too."
      )
      .addText((tx) =>
        tx.setValue(String(this.plugin.settings.port)).onChange(async (v) => {
          const p = parseInt(v, 10);
          if (!Number.isInteger(p) || p < 1024 || p > 65535) return;
          if (p === this.plugin.settings.port) return;
          this.plugin.settings.port = p;
          await this.plugin.saveSettings();
          // restart the listener on the new port right away
          this.plugin.stopServer();
          this.plugin.startServer();
          new Notice(`Neural Vault: listening on 127.0.0.1:${p}`);
        })
      );

    new Setting(containerEl)
      .setName("Debug endpoints")
      .setDesc(
        "Expose extra localhost endpoints for development (/pulse-all, /paint-all, /probe-green, /reset-view, /reload). Off for normal use."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugEndpoints).onChange(async (v) => {
          this.plugin.settings.debugEndpoints = v;
          await this.plugin.saveSettings();
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
    li('<code>color</code> — Read glow, hex string e.g. <code>"#00ff00"</code>');
    li('<code>writeColor</code> — Edit/Write glow, e.g. <code>"#ff0000"</code>');
    li('<code>swell</code> — node growth; <code>2.0</code> ≈ 3× size, <code>0</code> = none');
    li('<code>hold</code> — seconds at full brightness before fading; <code>-1</code> = stay lit until cleared');
    li('<code>decay</code> — fade length <code>0</code>–<code>1</code> (0.1 quick · 0.5 medium · 1 long); <code>-1</code> = never fade');
    li('<code>pulse</code> — throb <code>0</code>–<code>0.9</code> (<code>0</code> = steady)');
    li('<code>cascade</code> — neighbor spread <code>0</code>–<code>1</code> (<code>0</code> = off)');
    li('<code>trace</code> — session-trail tint <code>0</code>–<code>0.5</code> (<code>0</code> = off)');
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

function hexToInt(hex: string, fallback = 0x00ff00): number {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (m) return parseInt(m[1], 16);
  return fallback;
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
