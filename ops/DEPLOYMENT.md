# Monitor production deployment

## Private access added 2026-11-12

Nginx requires HTTP Basic authentication for the entire HTTPS site, including static files, API requests and video upgrades. The username is `chronicle`. The generated password is stored in the owner's local `monitor-access.txt` file and root-only `/etc/monitor-access.credentials` on the server. The password hash lives in `/etc/nginx/monitor.htpasswd`, owned by root and readable by the Nginx group. Application administrator authentication still controls management operations.

Anonymous requests to `/`, `/api/health`, `/video/9051/stream` and `/video/9051/mjpeg` were verified to return 401. Authenticated root and health requests return 200. Certificate challenge paths bypass Basic authentication so renewal continues to work. The local systemd health check connects directly to the loopback API.

The preceding Nginx configuration is backed up at `/var/backups/monitor/basic-auth-20261112-153201/monitor.chronicleiras.top`. Restoring that configuration would reopen anonymous site access. Run `nginx -t` before any reload. Public command-line verification now requires `curl -u chronicle https://monitor.chronicleiras.top/api/health`, which prompts for the access password.

## Release 20261112-03

- URL https://monitor.chronicleiras.top
- Host 43.142.120.169, Ubuntu 24.04, Nginx 1.24, Node 24.22.2, system FFmpeg.
- Source branch `codex/monitor-production`. Source and built assets are delivered by SCP. No remote Git pull is required.
- Releases live in `/srv/apps/monitor/releases/`. `current` selects the active release.
- Persistent nodes live in `/srv/apps/monitor/shared/data/nodes.json` and recordings in `/srv/apps/monitor/shared/records`.
- `/etc/monitor.env` is root-readable only. `ADMIN_TOKEN` is entered in the browser login dialog and exchanged for an HttpOnly session. It is absent from frontend assets. Sessions expire after eight hours and on backend restart.
- `monitor.service` runs as `monitor`, is enabled at boot and restarts on failure. `monitor-health.timer` checks the API every minute. Logs are available through `journalctl -u monitor` and Nginx logs.
- API listens on `127.0.0.1:3100`. Video HTTP listeners use `127.0.0.1:9051–9100`. Nginx exposes same-origin HTTPS API, MJPEG and WSS.
- ESP32 uses UDP 9001–9050, allocated per node. Tencent cloud ingress still needs confirmation. A public UDP probe timed out. Host UFW is inactive and the existing firewall was preserved.
- Recording pool is 3072 MiB. Segments are 60 seconds in production. Fragmented MP4 preserves completed fragments after interrupted writes. Filenames include a random per-process prefix to avoid restart collisions.
- MJPEG preview is capped at 5 fps and scaled to 640 pixels wide to reduce network load. Recording retains the incoming encoded video.
- Certificate lineage is `/etc/letsencrypt/live/monitor.chronicleiras.top`, initially valid through 2027-02-10. Certbot renewal dry-run passed. The deploy hook validates Nginx before reloading it.

## Changes

Shutdown stops processes without deleting persisted node definitions. Node creation is serialized. Pipeline replacement clears stale stream caches. The H.264 cache retains every slice of an IDR frame. Browser authentication uses backend sessions, downloads use the same cookie and encoded paths, and stream URLs follow the current HTTPS origin. The frontend contains no administrator password. Vue and Axios lockfile updates stay within existing dependency ranges.

## Verification

- Backend regression suite, TypeScript check and production build pass.
- Public HTTPS page, API health and frontend data loading pass.
- Actual browser H.264 playback over WSS reached 320-pixel video width with advancing playback time. MJPEG decoded at 640 pixels wide.
- Browser login, authenticated records access, session restoration after page reload and unauthenticated 401 responses pass.
- Node definitions were byte-identical across a systemd restart and both simulated nodes recovered.
- Killing a simulated node's FFmpeg process triggered automatic replacement. New fragmented recordings passed ffprobe.
- Personal website and blog return 200. Assistant site retains its authenticated 401 response.
- `npm audit --omit=dev` reports zero vulnerabilities after dependency updates. The development dependency tree still reports 18 findings, including one critical. Development tools are excluded from the deployed runtime.
- Build retains existing large-chunk and JMuxer Node-stream externalization warnings. Browser playback was tested despite those warnings.
- ESP32 hardware integration remains outstanding. Simulated sources exercise the software transport and recording paths only.

## Backups and rollback

Initial Nginx backup is `/var/backups/monitor/20261112-initial/nginx.tar.gz`. Shared-data backups and pre-release node snapshots are retained there. Acceptance recordings are retained, while only the two explicitly named acceptance nodes are removed after verification.

To roll back application code to the preceding release, keep shared data and the environment file intact.

```sh
sudo systemctl stop monitor-health.timer
sudo systemctl stop monitor
sudo ln -s /srv/apps/monitor/releases/20261112-02 /srv/apps/monitor/rollback.next
sudo mv -Tf /srv/apps/monitor/rollback.next /srv/apps/monitor/current
sudo systemctl start monitor
sudo systemctl start monitor-health.timer
curl --fail https://monitor.chronicleiras.top/api/health
```

Application rollback does not require an Nginx change. For an Nginx change, back up the active file first, restore only the monitor site when necessary, run `sudo nginx -t`, then reload. Avoid restoring the entire global archive over subsequently changed sites.

## Repeatable delivery

Run `npm ci`, `npm run test:server`, and `npm run build` locally. Archive tracked source from the verified commit, add the generated `dist/`, and record that commit in `REVISION`. Upload to a new release directory. Stop the health timer, stop the backend, back up shared data, atomically change `current`, start the backend and health timer, then verify public HTTPS, health and authentication. Reverting `current` restores the previous application version.
