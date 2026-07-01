import esbuild from "esbuild";
import { builtinModules } from "module";

const prod = process.argv.includes("production");

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", ...builtinModules],
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
