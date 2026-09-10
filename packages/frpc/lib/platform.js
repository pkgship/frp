"use strict";

const path = require("path");

const SUPPORTED_PLATFORMS = {
  "linux-x64": { pkg: "@pkgship/frpc-linux-amd64", binary: "frpc" },
  "linux-arm64": { pkg: "@pkgship/frpc-linux-arm64", binary: "frpc" },
  "linux-arm": { pkg: "@pkgship/frpc-linux-arm", binary: "frpc" },
  "darwin-x64": { pkg: "@pkgship/frpc-darwin-amd64", binary: "frpc" },
  "darwin-arm64": { pkg: "@pkgship/frpc-darwin-arm64", binary: "frpc" },
  "win32-x64": { pkg: "@pkgship/frpc-windows-amd64", binary: "frpc.exe" },
  "win32-arm64": { pkg: "@pkgship/frpc-windows-arm64", binary: "frpc.exe" },
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
