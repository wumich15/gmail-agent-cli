#!/usr/bin/env node
/**
 * Emits a CycloneDX 1.5 software bill of materials for the production
 * dependency tree, plus the build provenance the release record keeps.
 *
 * The plan requires an SBOM and preserved provenance for every signed release.
 * This reads the resolved production tree from the package manager rather than
 * package.json ranges, so the document describes what actually shipped.
 *
 * Usage: node scripts/generate-sbom.mjs [output-path]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const outputPath = process.argv[2] ?? "sbom.cdx.json";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function resolvedProductionTree() {
  const raw = execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  const components = new Map();
  const walk = (dependencies) => {
    for (const [name, info] of Object.entries(dependencies ?? {})) {
      if (!info?.version) continue;
      const key = `${name}@${info.version}`;
      if (!components.has(key)) {
        components.set(key, {
          type: "library",
          name,
          version: info.version,
          purl: `pkg:npm/${name.replace("@", "%40")}@${info.version}`,
          scope: "required"
        });
      }
      walk(info.dependencies);
    }
  };
  for (const project of JSON.parse(raw)) {
    walk(project.dependencies);
    walk(project.optionalDependencies);
  }
  return [...components.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const lockHash = createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex");
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: pkg.name,
      version: pkg.version,
      purl: `pkg:npm/${pkg.name}@${pkg.version}`,
      licenses: pkg.license ? [{ license: { id: pkg.license } }] : []
    },
    properties: [
      { name: "build:node", value: process.version },
      { name: "build:platform", value: `${process.platform}-${process.arch}` },
      { name: "build:lockfileSha256", value: lockHash },
      { name: "build:commit", value: process.env["GITHUB_SHA"] ?? gitCommit() },
      { name: "build:runId", value: process.env["GITHUB_RUN_ID"] ?? "local" }
    ]
  },
  components: resolvedProductionTree()
};

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Wrote ${outputPath} with ${sbom.components.length} production components.`);
