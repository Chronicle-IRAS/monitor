# Monitor production deployment

## Deployment correction — 2026-11-12

Release 20261112-05, source fe43d9c, has now been installed and activated using ubuntu@43.142.120.169 with the existing key and sudo. The earlier root-login blocker below is historical. All 32 backend tests passed locally and on the server. Type checking and the production build passed. The backend and health timer are active, the loopback health request returned 200, and nodes.json matched the backup byte-for-byte after restart. Public anonymous HTTPS returns 401 as intended. Physical ESP32 integration remains unverified. Future deployments must use the ubuntu account and sudo, replacing the root login in the historical runbook below.

## JPEG/UDP compatibility release 20261112-05 — prepared, not deployed

Scope: backend JPEG/UDP receiver for CAM-WEB (`streamType=jpeg-udp`), frontend mode selector/preview, hardware configuration checklist. H.264 (`ffmpeg`) and existing MJPEG (`mjpeg`) paths are unchanged; no API path, node field, or recording endpoint was removed.

Verification completed locally:

- `npm run test:server` passes 32 tests, including 14 hardware-format tests using 4-byte big-endian offsets, 1400-byte fragments, `0xFFFFFFFF` end markers, real UDP sockets, reordering, duplicates, missing head/middle/tail fragments, lost EOF, timeout cleanup, persistence/restore, `/mjpeg` byte-exact delivery and lazy ffmpeg recording.
- `npm run build` passes type checking and the production build.
- No standard H.264 or generic MJPEG stream was used to stand in for the hardware protocol tests.
- Real system FFmpeg 8.1 end-to-end: 37 hardware-format frames (4.1 KB JPEG, 1400-byte fragments) produced a 3.8 s, 320×240 H.264 MP4 (10 fps) that `ffprobe` reads and `ffmpeg -frames:v 1` decodes; `/mjpeg` returned the sent JPEG byte-for-byte.
- Headless Chromium against a local same-origin proxy: the node card rendered the MJPEG image at 320×240, the badge read `MJPEG`, and the add-node dialog exposed `ESP32 硬件 JPEG (UDP 分片)`.
- No physical ESP32 was attached to this workstation; hardware integration remains unverified.

Deployment status: **blocked**. `root@43.142.120.169` accepts only `publickey`, and none of the private keys available on this workstation are authorized (`Permission denied (publickey)`). No deployment key exists in the repository or local secrets. Therefore this release has not been uploaded, `current` has not been switched, and the backend has not been restarted.

Existing production state is untouched:

- `GET https://monitor.chronicleiras.top/api/health` returns 200 with one node.
- `GET /` returns 200 behind Basic authentication.
- The existing node remains `{ id: "1", udp: 9001, http: 9051, streamType: "ffmpeg", isRecord: false, status: "online" }`.
- No remote file, service, Nginx configuration or environment file was modified during this work.

Deployment runbook when SSH access is restored:

```sh
npm ci
npm run test:server
npm run build
# archive tracked source at the verified commit plus dist/, write REVISION
scp -r release-20261112-05 root@43.142.120.169:/srv/apps/monitor/releases/
ssh root@43.142.120.169 '
  systemctl stop monitor-health.timer
  systemctl stop monitor
  cp -a /srv/apps/monitor/shared/data/nodes.json /var/backups/monitor/nodes-20261112-05.json
  ln -sfn /srv/apps/monitor/releases/20261112-05 /srv/apps/monitor/current.next
  mv -Tf /srv/apps/monitor/current.next /srv/apps/monitor/current
  systemctl start monitor
  systemctl start monitor-health.timer
'
curl -u chronicle https://monitor.chronicleiras.top/api/health
```

No `/etc/monitor.env` change is required: `UDP_BIND_HOST`, `JPEG_FRAME_TIMEOUT_MS`, `JPEG_SOURCE_IDLE_MS`, `JPEG_MAX_FRAME_BYTES`, `JPEG_RECORD_IDLE_MS` and `JPEG_RECORD_FPS` have working defaults. No Nginx change is required; `/video/<9051-9100>/mjpeg` already routes the new mode. The cloud security group must allow UDP `9001–9050` inbound before hardware can reach the backend.

Rollback: point `current` back to `/srv/apps/monitor/releases/20261112-04` and restart `monitor`. Shared data and `/etc/monitor.env` stay untouched. Existing H.264 nodes do not require migration; `jpeg-udp` nodes only exist after this release is running.

Post-deploy acceptance:

1. Existing node `1` is still listed and does not enter a restart loop.
2. `/api/health` returns 200 and `systemctl status monitor` is active.
3. Records API still lists and downloads existing files.
4. Do not create a `jpeg-udp` node until a real ESP32 is on the network; after creating one, require `rxFrames > 0` and a visible `/mjpeg` image. `status=online` alone is not evidence of video reception.

## Preview update 20261112-04

Node cards expand into a viewport-level preview with a card-origin animation, full-frame video, connection feedback and node details. The player DOM instance is retained across opening and closing. Escape, backdrop click, close button, focus trapping and focus restoration are supported. Reduced-motion preferences skip the spatial transition. Mobile previews fit the dynamic viewport. Stopping a node requires administrator access and confirmation.

Desktop and mobile browser checks cover opening, closing, player identity, keyboard focus and guest permissions. Backend tests, type checking and the production build pass. This release changes frontend assets and documentation. The release symlink can be switched without restarting the backend. To roll back this UI, atomically point `current` to `/srv/apps/monitor/releases/20261112-03`.

Local access credentials now live in `.local-secrets/monitor-access.txt` and `.local-secrets/monitor-admin-token.txt`. The directory is ignored by Git, credential files retain owner-only ACLs, and release archives are made from tracked source plus `dist/`. Credentials must never be added to source or build artifacts.

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
