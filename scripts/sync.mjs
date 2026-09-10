#!/usr/bin/env node
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { connect as netConnect } from "node:net";
import path from "node:path";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GITHUB_REPO = "fatedier/frp";
const MAINS = [
  { dir: "packages/frpc", pkg: "@pkgship/frpc", cmd: "frpc" },
  { dir: "packages/frps", pkg: "@pkgship/frps", cmd: "frps" },
];
const PLATFORMS = JSON.parse(
  readFileSync(path.join(ROOT, "scripts", "platforms.json"), "utf8"),
);

const noPublish = process.argv.includes("--no-publish");
const versionIndex = process.argv.indexOf("--version");
const versionOverride =
  versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined;

// ── Zip constants ──────────────────────────────────────────────────────
const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function u16(buf, off) {
  return buf.readUInt16LE(off);
}
function u32(buf, off) {
  return buf.readUInt32LE(off);
}

// ── HTTP client (zero dependencies) ────────────────────────────────────
export function isProxiedHost(hostname) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
  const entries = noProxy
    .split(",")
    .map((s) => s.trim().replace(/^\./, ""))
    .filter(Boolean);
  if (entries.includes("*")) return false;
  if (entries.some((h) => hostname === h || hostname.endsWith("." + h)))
    return false;
  return Boolean(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy,
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const msg = String(err?.message || err?.code || "");
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|disconnect|reset by peer|timeout|closed|TLS|tunnel|zip:|tar:|executable|central directory|local file header|compression method|incomplete response|HTTP 5\d\d/i.test(
    msg,
  );
}

function connectThroughProxy(proxy, hostname, port) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy);
    const proxyPort =
      Number(proxyUrl.port) || (proxyUrl.protocol === "https:" ? 443 : 80);
    const auth = proxyUrl.username
      ? "Basic " +
        Buffer.from(
          decodeURIComponent(proxyUrl.username) +
            ":" +
            decodeURIComponent(proxyUrl.password),
        ).toString("base64")
      : null;

    let rawSocket;
    let ready = () => {};
    const pending = new Promise((res) => {
      ready = res;
    });

    if (proxyUrl.protocol === "https:") {
      rawSocket = tlsConnect({
        host: proxyUrl.hostname,
        port: proxyPort,
        servername: proxyUrl.hostname,
      });
      rawSocket.once("secureConnect", ready);
    } else {
      rawSocket = netConnect({ host: proxyUrl.hostname, port: proxyPort });
      rawSocket.once("connect", ready);
    }
    rawSocket.once("error", reject);

    const connectTimer = setTimeout(() => {
      rawSocket.destroy(
        new Error(`proxy ${proxyUrl.hostname}:${proxyPort} connect timeout`),
      );
    }, 30000);

    pending.then(() => {
      const lines = [
        `CONNECT ${hostname}:${port} HTTP/1.1`,
        `Host: ${hostname}:${port}`,
      ];
      if (auth) lines.push(`Proxy-Authorization: ${auth}`);
      rawSocket.write(lines.join("\r\n") + "\r\n\r\n");

      let buffer = "";
      const onData = (chunk) => {
        buffer += chunk.toString("latin1");
        const sep = buffer.indexOf("\r\n\r\n");
        if (sep === -1) return;
        clearTimeout(connectTimer);
        rawSocket.off("data", onData);
        const status = parseInt(
          /^HTTP\/\d\.\d\s+(\d{3})/.exec(buffer.slice(0, sep))[1],
          10,
        );
        if (status === 200) resolve(rawSocket);
        else {
          reject(new Error(`Proxy CONNECT failed: ${buffer.slice(0, sep)}`));
          rawSocket.destroy();
        }
      };
      rawSocket.on("data", onData);
    });
  });
}

async function openSocket(hostname, port, useTls) {
  let socket;
  if (isProxiedHost(hostname)) {
    const proxy =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy;
    socket = await connectThroughProxy(proxy, hostname, port);
  } else {
    socket = netConnect({ host: hostname, port });
    const connected = new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`connect timeout to ${hostname}:${port}`));
    }, 30000);
    await connected;
    clearTimeout(connectTimer);
  }
  if (!useTls) return socket;

  const tlsSocket = tlsConnect({ socket, servername: hostname });
  const secured = new Promise((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });
  const handshakeTimer = setTimeout(() => {
    tlsSocket.destroy(
      new Error(`TLS handshake timeout to ${hostname}:${port}`),
    );
  }, 30000);
  await secured;
  clearTimeout(handshakeTimer);
  return tlsSocket;
}

export function dechunk(buf) {
  const parts = [];
  let off = 0;
  while (off < buf.length) {
    const lineEnd = buf.indexOf("\r\n", off);
    if (lineEnd === -1) break;
    const size = parseInt(
      buf.subarray(off, lineEnd).toString("utf8").trim().split(";")[0],
      16,
    );
    if (!size) break;
    parts.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    off = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

export function parseRawResponse(buf) {
  const headEnd = buf.indexOf("\r\n\r\n");
  const head = buf.subarray(0, headEnd).toString("latin1");
  const lines = head.split("\r\n");
  const status = parseInt(/^HTTP\/\d\.\d\s+(\d{3})/.exec(lines[0])[1], 10);
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(":");
    if (idx > 0)
      headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i]
        .slice(idx + 1)
        .trim();
  }
  let body = buf.subarray(headEnd + 4);
  if ((headers["transfer-encoding"] || "").toLowerCase().includes("chunked")) {
    body = dechunk(body);
  }
  return { status, headers, body };
}

export async function requestRaw(
  targetUrl,
  method,
  requestHeaders,
  { maxRedirects = 5, retries = 3 } = {},
) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await requestOnce(targetUrl, method, requestHeaders, maxRedirects);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      console.log(
        `[sync] retrying request (${attempt + 1}/${retries}) after error: ${String(err?.message || err?.code || "")}`,
      );
      await sleep(attempt * 1000);
    }
  }
}

async function requestOnce(targetUrl, method, requestHeaders, maxRedirects) {
  let url = targetUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const u = new URL(url);
    const useTls = u.protocol === "https:";
    const port = Number(u.port) || (useTls ? 443 : 80);
    const socket = await openSocket(u.hostname, port, useTls);

    const lines = [
      `${method} ${u.pathname + u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      "Connection: close",
      ...Object.entries(requestHeaders).map(([k, v]) => `${k}: ${v}`),
    ];
    socket.write(lines.join("\r\n") + "\r\n\r\n");

    let buf = Buffer.alloc(0);
    await new Promise((resolve, reject) => {
      let ended = false;
      const readTimer = setTimeout(() => {
        socket.destroy(new Error("socket read timeout"));
      }, 180000);
      const cleanup = () => clearTimeout(readTimer);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
      });
      socket.once("end", () => {
        ended = true;
        cleanup();
        resolve();
      });
      socket.once("close", () => {
        cleanup();
        if (ended) return;
        reject(new Error("socket closed before the response completed"));
      });
      socket.once("error", (err) => {
        cleanup();
        reject(err);
      });
    });

    const response = parseRawResponse(buf);
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.location
    ) {
      url = new URL(response.headers.location, url).toString();
      continue;
    }
    const expected = Number(response.headers["content-length"]);
    if (expected && response.body.length < expected) {
      throw new Error(
        `incomplete response from ${url} (got ${response.body.length} of ${expected} bytes)`,
      );
    }
    return response;
  }
  throw new Error(`Too many redirects for ${targetUrl}`);
}

// ── GitHub / npm ───────────────────────────────────────────────────────
async function fetchLatestVersion() {
  const { status, body } = await requestRaw(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    "GET",
    { "User-Agent": "pkg-frp-npm", Accept: "application/vnd.github+json" },
  );
  if (status >= 400)
    throw new Error(`HTTP ${status} while fetching latest release`);
  return String(JSON.parse(body.toString("utf8")).tag_name).replace(/^v/, "");
}

async function isPublished(pkgName, version) {
  const { status } = await requestRaw(
    `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/${version}`,
    "GET",
    { "User-Agent": "pkg-frp-npm" },
  );
  return status >= 200 && status < 300;
}

async function fetchAsset(version, assetName) {
  if (process.env.FRP_ASSET_DIR) {
    const localPath = path.join(process.env.FRP_ASSET_DIR, assetName);
    if (existsSync(localPath)) return readFileSync(localPath);
    throw new Error(`Asset not found in FRP_ASSET_DIR: ${localPath}`);
  }
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${assetName}`;
  const { status, body } = await requestRaw(url, "GET", {
    "User-Agent": "pkg-frp-npm",
  });
  if (status >= 400)
    throw new Error(`HTTP ${status} while downloading ${assetName}`);
  return body;
}

// ── Archive extraction ─────────────────────────────────────────────────
function findEOCD(buf) {
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (u32(buf, i) === SIG_EOCD) return i;
  }
  throw new Error("zip: end of central directory not found");
}

function listCentralEntries(buf, eocdOff) {
  const total = u16(buf, eocdOff + 10);
  const cdStart = u32(buf, eocdOff + 16);
  const entries = [];
  let off = cdStart;
  for (let n = 0; n < total; n++) {
    if (u32(buf, off) !== SIG_CENTRAL)
      throw new Error("zip: invalid central directory entry");
    const method = u16(buf, off + 10);
    const compSize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const localOffset = u32(buf, off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  const off = entry.localOffset;
  if (u32(buf, off) !== SIG_LOCAL)
    throw new Error("zip: invalid local file header");
  const nameLen = u16(buf, off + 26);
  const extraLen = u16(buf, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const packed = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 8) return inflateRawSync(packed);
  if (entry.method === 0) return Buffer.from(packed);
  throw new Error(`zip: unsupported compression method ${entry.method}`);
}

function extractFromTar(buf, binName) {
  if (buf.length < 512 || buf.toString("ascii", 257, 262) !== "ustar")
    return null;
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) break;
    const sizeOct =
      buf
        .toString("utf8", off + 124, off + 136)
        .replace(/\0.*$/, "")
        .trim() || "0";
    const size = parseInt(sizeOct, 8) || 0;
    const type = String.fromCharCode(buf[off + 156]);
    if (
      (type === "0" || type === "\0") &&
      path.posix.basename(name) === binName
    ) {
      return Buffer.from(buf.subarray(off + 512, off + 512 + size));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

function extractFromZip(buf, binName) {
  const eocd = findEOCD(buf);
  const entries = listCentralEntries(buf, eocd);
  const target = entries.find((e) => path.posix.basename(e.name) === binName);
  if (!target) return null;
  return readZipEntry(buf, target);
}

function isExecutable(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46)
    return true;
  if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
  const magicLE = buf.readUInt32LE(0);
  const magicBE = buf.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf].includes(magicLE))
    return true;
  if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf].includes(magicBE))
    return true;
  return false;
}

// ── Platform preparation ───────────────────────────────────────────────
async function preparePlatform(platform, version) {
  const assetName = platform.asset.replace("{VERSION}", version);
  const isZip = assetName.endsWith(".zip");

  // Check if all binaries for this platform are already present
  const allPresent = MAINS.every((main) => {
    const binName =
      main.cmd + (isZip && platform.os[0] === "win32" ? ".exe" : "");
    const binPath = path.join(ROOT, platform.dir, binName);
    const markerPath = path.join(ROOT, platform.dir, `.${main.cmd}-version`);
    return (
      existsSync(binPath) &&
      existsSync(markerPath) &&
      readFileSync(markerPath, "utf8").trim() === version &&
      isExecutable(readFileSync(binPath))
    );
  });

  if (allPresent) {
    console.log(
      `[sync] binaries already present for ${platform.pkg} @ ${version} - skipping`,
    );
    return;
  }

  console.log(`[sync] downloading ${assetName}`);
  const raw = await fetchAsset(version, assetName);

  mkdirSync(path.join(ROOT, platform.dir), { recursive: true });

  for (const main of MAINS) {
    const binName =
      main.cmd + (isZip && platform.os[0] === "win32" ? ".exe" : "");
    const binPath = path.join(ROOT, platform.dir, binName);
    const markerPath = path.join(ROOT, platform.dir, `.${main.cmd}-version`);

    if (
      existsSync(binPath) &&
      existsSync(markerPath) &&
      readFileSync(markerPath, "utf8").trim() === version &&
      isExecutable(readFileSync(binPath))
    ) {
      console.log(
        `[sync] ${binName} already present for ${version} - skipping`,
      );
      continue;
    }

    let binary = null;
    if (isZip) {
      binary = extractFromZip(raw, binName);
    } else {
      // tar.gz: gunzip then search tar
      const tarBuf = gunzipSync(raw);
      binary = extractFromTar(tarBuf, binName);
    }

    if (!binary || !isExecutable(binary)) {
      throw new Error(`Failed to extract valid ${binName} from ${assetName}`);
    }

    writeFileSync(binPath, binary);
    chmodSync(binPath, 0o755);
    writeFileSync(markerPath, version + "\n");
    console.log(
      `[sync] wrote ${binName} (${(binary.length / 1024 / 1024).toFixed(1)} MiB)`,
    );
  }
}

async function preparePlatformWithRetry(platform, version) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await preparePlatform(platform, version);
    } catch (err) {
      if (attempt >= 3 || !isRetryable(err)) throw err;
      console.log(
        `[sync] retrying ${platform.dir} (${attempt + 1}/3) after error: ${String(err?.message || err?.code || "")}`,
      );
      await sleep(attempt * 1000);
    }
  }
}

// ── Version + publish ──────────────────────────────────────────────────
function setPackageVersion(pkgPath, version, optionalDeps) {
  const pkgFile = path.join(ROOT, pkgPath, "package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  pkg.version = version;
  if (optionalDeps)
    pkg.optionalDependencies = { ...pkg.optionalDependencies, ...optionalDeps };
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
}

function publishPackage(dir) {
  const provenance =
    process.env.GITHUB_ACTIONS === "true" ? " --provenance" : "";
  console.log(`[sync] publishing ${path.join(ROOT, dir)}`);
  execSync(`npm publish --access public${provenance}`, {
    cwd: path.join(ROOT, dir),
    stdio: "inherit",
  });
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const version = versionOverride ?? (await fetchLatestVersion());
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Unexpected version string: ${version}`);
  }
  console.log(`[sync] frp version: ${version}`);

  // Check what's already published
  const platformPublished = new Map();
  for (const platform of PLATFORMS) {
    platformPublished.set(
      platform.pkg,
      await isPublished(platform.pkg, version),
    );
  }
  const mainsPublished = new Map();
  for (const main of MAINS) {
    mainsPublished.set(main.pkg, await isPublished(main.pkg, version));
  }

  // --no-publish: download + stamp only
  if (noPublish) {
    for (const platform of PLATFORMS) {
      await preparePlatformWithRetry(platform, version);
    }
    for (const platform of PLATFORMS) {
      setPackageVersion(platform.dir, version);
    }
    for (const main of MAINS) {
      const deps = Object.fromEntries(
        PLATFORMS.filter(
          (p) => p.bin === main.cmd || p.bin === main.cmd + ".exe",
        ).map((p) => [p.pkg, version]),
      );
      setPackageVersion(main.dir, version, deps);
    }
    console.log(
      `[sync] prepared binaries for ${version} (publish skipped due to --no-publish)`,
    );
    return;
  }

  // Check if everything is already published
  if (
    [...mainsPublished.values()].every(Boolean) &&
    [...platformPublished.values()].every(Boolean)
  ) {
    console.log(
      `[sync] all packages @${version} already published - nothing to do`,
    );
    process.exit(0);
  }

  // Publish platform packages
  for (const platform of PLATFORMS) {
    if (platformPublished.get(platform.pkg)) {
      console.log(
        `[sync] ${platform.pkg}@${version} already published - skipping`,
      );
      continue;
    }
    await preparePlatformWithRetry(platform, version);
    setPackageVersion(platform.dir, version);
    publishPackage(platform.dir);
  }

  // Publish main packages
  for (const main of MAINS) {
    const deps = Object.fromEntries(
      PLATFORMS.filter(
        (p) => p.bin === main.cmd || p.bin === main.cmd + ".exe",
      ).map((p) => [p.pkg, version]),
    );
    setPackageVersion(main.dir, version, deps);
    if (mainsPublished.get(main.pkg)) {
      console.log(`[sync] ${main.pkg}@${version} already published - skipping`);
    } else {
      publishPackage(main.dir);
    }
  }

  console.log(`[sync] done: published all packages @${version}`);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(`[sync] failed: ${err.message}`);
    process.exit(1);
  });
}

export { main };
