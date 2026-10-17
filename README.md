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

`scripts/sync.mjs` syncs one upstream release into a self-contained tree under
`publish/` (git-ignored): every `@pkgship/frp{c,s}-<platform>` binary package,
the two shim packages, and a `publish/.packages` manifest in publish order. It
never publishes and never writes a version back into the repository, so the
committed manifests stay at `0.0.0`.

```bash
node scripts/sync.mjs                  # latest upstream release
node scripts/sync.mjs --version 0.71.1 # pin a version
```

The release lookup uses the GitHub API. Unauthenticated it is capped at
60 requests/hour per IP (returns HTTP 403 once exhausted); a token raises this
to 5000. The token is read from `GITHUB_TOKEN`/`GH_TOKEN`, else discovered from
the local `gh` CLI (`gh auth login`), so CI and local runs both authenticate.
Set `FRP_ASSET_DIR=<dir>` to read release assets from disk instead of
downloading them.

Publishing is the workflow's job: `.github/workflows/publish-npm.yml` runs
`sync.mjs`, then walks `publish/.packages` and `npm publish --provenance` each
entry that is not on the registry yet (platform packages first, then the
shims). Local publish uses `npm login`; CI uses npm Trusted Publishers (OIDC).

## Upstream

[Official frp](https://github.com/fatedier/frp)
