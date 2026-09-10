"use strict";

const path = require("path");

const SUPPORTED_PLATFORMS = {
  "linux-x64": { pkg: "@pkgship/frps-linux-amd64", binary: "frps" },
  "linux-arm64": { pkg: "@pkgship/frps-linux-arm64", binary: "frps" },
  "linux-arm": { pkg: "@pkgship/frps-linux-arm", binary: "frps" },
  "darwin-x64": { pkg: "@pkgship/frps-darwin-amd64", binary: "frps" },
  "darwin-arm64": { pkg: "@pkgship/frps-darwin-arm64", binary: "frps" },
  "win32-x64": { pkg: "@pkgship/frps-windows-amd64", binary: "frps.exe" },
  "win32-arm64": { pkg: "@pkgship/frps-windows-arm64", binary: "frps.exe" },
};

function resolveBinary() {
  const key = process.platform + "-" + process.arch;
  const entry = SUPPORTED_PLATFORMS[key];
  if (!entry) {
    throw new Error(
      `Unsupported platform "${key}". Supported platforms: ${Object.keys(SUPPORTED_PLATFORMS).join(", ")}`,
    );
  }

  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve(entry.pkg + "/package.json"));
  } catch {
    throw new Error(
      `The platform package "${entry.pkg}" could not be found. ` +
        'Reinstall without "--no-optional" or "--ignore-scripts".',
    );
  }
  return path.join(pkgDir, entry.binary);
}

module.exports = { resolveBinary, SUPPORTED_PLATFORMS };
