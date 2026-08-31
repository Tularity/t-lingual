# t-lingual

t-lingual is a simultaneous-interpretation web application with passkey-only
accounts, invitation-only registration, private user workspaces, and an
administrator control plane. It runs the React application and orchestration
backend; speech recognition and translation always come from separately
deployed HTTP APIs. The image contains no model weights or inference runtime.

## Run with Docker Compose

Requirements:

- Docker Engine 24 or newer with Docker Compose v2
- an HTTPS public origin terminated by a reverse proxy
- reachable deployments of `asr-factory` and `llm-translator`

Create an untracked `.env` file. URLs must be visible from inside the container;
do not use `localhost` for a service running on the Docker host. The supplied
Compose network maps `host.docker.internal` on Linux, Docker Desktop, and
Windows.

```dotenv
TLINGUAL_PUBLIC_URL=https://lingual.example.com
# Replace this with the exact /32 or /128 address of the HTTPS proxy as seen
# by the app container (for a host proxy, normally the app network gateway).
TLINGUAL_TRUSTED_PROXY_CIDRS=172.20.0.1/32
TLINGUAL_ASR_BASE_URL=http://host.docker.internal:8300
TLINGUAL_ASR_API_KEY=
TLINGUAL_TRANSLATOR_BASE_URL=http://host.docker.internal:8080
TLINGUAL_TRANSLATOR_API_KEY=
# Only for this host-private HTTP topology; prefer HTTPS for remote providers.
TLINGUAL_ALLOW_INSECURE_PROVIDERS=true
```

Start the application and inspect both liveness and provider readiness:

```console
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8088/health/live
curl -fsS http://127.0.0.1:8088/health/ready
```

Host port 8088 binds to loopback by default; the process still listens on port
8080 inside the container. Put an HTTPS reverse proxy in front of it and
preserve the request host and WebSocket upgrade headers. Set
`TLINGUAL_BIND_ADDRESS=0.0.0.0` only when the host firewall and deployment
topology require a non-loopback bind. `TLINGUAL_PUBLIC_URL` must be the exact
browser origin. Additional passkey origins can be supplied as a comma-separated
`TLINGUAL_RP_ORIGINS` value; the public origin is always included and duplicate
entries are ignored.

Production also requires `TLINGUAL_TRUSTED_PROXY_CIDRS`. Use only the immediate
HTTPS proxy peer address or its smallest stable network; never use `0.0.0.0/0`
or `::/0`. The proxy must overwrite `X-Forwarded-For`, or append the actual
connecting client address to a pre-existing chain. t-lingual ignores forwarded
addresses from every other peer, walks trusted multi-hop chains from right to
left, and groups IPv6 clients by `/64` for authentication load limits. For a
host-side proxy, inspect the Compose network and use its gateway as a `/32`;
for a proxy container, put both services on a private network and trust only
that proxy's stable address or narrow subnet.

The Docker healthcheck uses `/health/live`, so a temporary provider outage does
not restart the process. `/health/ready` reports database, ASR, and translator
availability and returns 503 until all three are ready.

## Bootstrap administration

The `tlingualctl` binary talks to the running process through its mode-0600 Unix
socket. It never opens SQLite. Generate the first six-digit invitation, then
register with that code and a passkey in the browser:

```console
docker exec t-lingual tlingualctl status
docker exec t-lingual tlingualctl invite create --ttl 24h
```

The clear invitation code is shown only by the create command and cannot be
recovered later. After the account has registered, promote it and perform later
administration with:

```console
docker exec t-lingual tlingualctl invite list
docker exec t-lingual tlingualctl invite revoke <invitation-id>
docker exec t-lingual tlingualctl users list
docker exec t-lingual tlingualctl users set-role <user-id> admin
docker exec t-lingual tlingualctl users disable <user-id>
docker exec t-lingual tlingualctl users enable <user-id>
```

Add `--json` for machine-readable output. The CLI returns 0 on success, 1 for a
server or transport failure, and 2 for invalid command usage.

Promoting a user to `admin` invalidates every existing browser session for that
account. This is intentional: the new administrator must sign in again with a
passkey before the elevated role can be used. Disabling an account likewise
revokes its browser sessions and any active interpretation streams.

The web administration area requires a fresh passkey assertion for every
invitation create or revoke and every role or account-status change. Each
two-minute authorization is bound to the exact operation and target, is usable
once, and cannot be replayed for a different administrative action. The local
container CLI is the explicitly trusted bootstrap and recovery control plane.

## Account and workspace safety

The Security settings page lists this account's passkeys and signed-in browser
sessions. A user can end the current session directly; revoking another device,
all other devices, or changing passkeys requires a fresh passkey verification.
Credential-clone warnings quarantine the affected passkey, revoke the account's
sessions, and are recorded in the security audit trail.

Durable per-user limits prevent one tenant from exhausting the shared SQLite
store: at most 1,000 saved interpretation sessions, 25,000 segments or 16 MiB of
transcript per session, and 256 MiB of transcript per user. Each user may keep up
to 20 browser sessions and 10 passkeys. Live interpretation is limited to two
streams per user and 64 streams process-wide, with a 30-second no-audio timeout
and a four-hour maximum stream duration. The API returns explicit capacity or
storage errors instead of silently dropping data.

## Persistence and updates

SQLite state, the master key, and the local administration socket live under
`/app/data`. Compose stores that directory in the `t-lingual-data` named volume.
Back up the volume while the application is stopped, and retain the master key
with the database; losing it invalidates secrets derived from that key.

```console
docker compose stop app
docker run --rm -v t-lingual-data:/source:ro -v "$PWD":/backup alpine:3.24.1 \
  tar -C /source -czf /backup/t-lingual-data.tar.gz .
docker compose start app
```

Never delete the volume during an ordinary image update:

```console
docker compose build --pull
docker compose up -d
```

## Configuration

The image defaults to production mode, listens on container port 8080, serves
the built React application from `/app/web`, and persists under `/app/data`.
Important overrides are:

| Variable | Purpose |
| --- | --- |
| `TLINGUAL_PUBLIC_URL` | Required external HTTPS origin used by passkeys and cookies. |
| `TLINGUAL_RP_ID` | Optional WebAuthn relying-party ID; defaults to the public hostname. |
| `TLINGUAL_RP_ORIGINS` | Optional comma-separated additional exact WebAuthn origins; the public origin is always included. |
| `TLINGUAL_TRUSTED_PROXY_CIDRS` | Required in production; comma-separated immediate HTTPS proxy CIDRs used to validate `X-Forwarded-For`. |
| `TLINGUAL_ASR_BASE_URL` | Required URL of the separately deployed ASR API. |
| `TLINGUAL_ASR_API_KEY` | Optional ASR bearer credential. |
| `TLINGUAL_TRANSLATOR_BASE_URL` | Required URL of the separately deployed translator API. |
| `TLINGUAL_TRANSLATOR_API_KEY` | Optional translator bearer credential. |
| `TLINGUAL_ALLOW_INSECURE_PROVIDERS` | Explicit production opt-in for private-network HTTP providers; defaults to `false`. |
| `TLINGUAL_INVITATION_TTL` | Default invitation lifetime; defaults to `168h`. |
| `TLINGUAL_SESSION_TTL` | Browser-session lifetime; defaults to `168h`. |
| `TLINGUAL_SHUTDOWN_TIMEOUT` | Graceful shutdown deadline; defaults to `15s`. |

Keep API credentials in the deployment secret store or the untracked `.env`;
never place them in the image or source control. Provider URLs cannot contain
embedded credentials, and provider clients reject redirects so credentials and
audio/text bodies cannot be forwarded to a different or downgraded origin.

## Build and verify

The multi-stage build pins Node, Go, and Alpine versions, builds the React
bundle and both Go binaries, then copies only runtime artifacts into a non-root
Alpine image. Build metadata can be supplied without changing the source:

```console
docker build \
  --build-arg VERSION=0.1.0 \
  --build-arg REVISION=<git-commit> \
  --build-arg BUILD_DATE=2026-09-01T00:00:00Z \
  -t tularity/t-lingual:0.1.0 .
```

For local source verification outside Docker:

```console
go test ./cmd/... ./internal/...
npm --prefix frontend ci
npm --prefix frontend run lint
npm --prefix frontend run test
npm --prefix frontend run build
```

The runtime container has no Go toolchain, Node.js, package source, local agent
instructions, project documentation directory, tests, or model artifacts. It
runs as UID/GID 10001 with all Linux capabilities dropped by Compose.
