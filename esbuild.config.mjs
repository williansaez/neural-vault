import esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv.includes("production");

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", ...builtins],
    format: "cjs",
    target: "es2018",
    platform: "browser",
    outfile: "main.js",
    sourcemap: prod ? false : "inline",
    minify: prod,
    treeShaking: true,
    logLevel: "info",
  })
  .catch(() => process.exit(1));
