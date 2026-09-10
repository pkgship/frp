#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "pkgship/frp";
const FILE = "publish-npm.yml";

const dryRun = process.argv.includes("--dry-run");

function discoverPackages() {
  const dirs = readdirSync(path.join(ROOT, "packages"), {
    withFileTypes: true,
  })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const packages = [];
  for (const dir of dirs) {
    const pkgPath = path.join(ROOT, "packages", dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (!pkg.private && pkg.name) {
        packages.push(pkg.name);
      }
    } catch {
      // skip dirs without valid package.json
    }
  }
  return packages;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const packages = discoverPackages();

  console.log(`Found ${packages.length} publishable packages:`);
  packages.forEach((p) => console.log(`  - ${p}`));
  console.log();

  if (dryRun) {
    console.log("[dry-run] would run:");
    for (const pkg of packages) {
      console.log(
        `  npm trust github ${pkg} --file ${FILE} --repo ${REPO} --allow-publish --yes`,
      );
    }
    console.log();
    console.log("[dry-run] no changes made");
    process.exit(0);
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    console.log(
      `\n[${i + 1}/${packages.length}] Setting up trust for ${pkg}...`,
    );

    try {
      execSync(
        `npm trust github ${pkg} --file ${FILE} --repo ${REPO} --allow-publish --yes`,
        { cwd: ROOT, stdio: "inherit" },
      );
      success++;
      console.log(`  ✓ ${pkg} configured`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${pkg} failed: ${err.message}`);
    }

    // rate limit protection
    if (i < packages.length - 1) {
      await sleep(2000);
    }
  }

  console.log(
    `\nDone: ${success} succeeded, ${failed} failed out of ${packages.length}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`[setup-trust] failed: ${err.message}`);
  process.exit(1);
});
