#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const { resolveBinary } = require("../lib/platform");

let exitCode = 0;
try {
  const binary = resolveBinary();
  const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
  exitCode = result.status === null ? (result.error ? 1 : 0) : result.status;
} catch (error) {
  console.error(error.message);
  exitCode = 1;
}
process.exit(exitCode);
