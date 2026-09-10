# frp — Debian & npm Packages

Automated `.deb` and npm package builds for [frp](https://github.com/fatedier/frp), a fast reverse proxy.

## Debian

Architectures: `amd64`, `arm64`, `armhf`, `i386`

```bash
sudo dpkg -i frpc_*.deb frps_*.deb
sudo systemctl enable --now frpc   # or frps
```

Config at `/etc/frp/frpc.toml` and `/etc/frp/frps.toml`.

## npm

```bash
npm i -g @pkgship/frpc @pkgship/frps
```

Platform packages: `@pkgship/frpc-<platform>` / `@pkgship/frps-<platform>`

### Sync & publish

`scripts/sync.mjs` downloads official release binaries, stamps versions, and publishes.

```bash
node scripts/sync.mjs                       # publish latest frp release
node scripts/sync.mjs --no-publish          # download only
node scripts/sync.mjs --version 0.71.0      # pin a version
```

Local publish uses `npm login`; CI uses npm Trusted Publishers (OIDC).

## Upstream

[Official frp](https://github.com/fatedier/frp)
