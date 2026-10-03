# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM --platform=$BUILDPLATFORM node:24.20.0-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS web-build
WORKDIR /src/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

COPY frontend/ ./
RUN npm run build


FROM --platform=$BUILDPLATFORM golang:1.26.7-alpine3.24@sha256:28d89ee9cc0ff9fec75c82ca201e6bf7fdf9a679d4b7b24dfa04f2bb766bb468 AS go-build
WORKDIR /src

ARG TARGETOS
ARG TARGETARCH
ARG VERSION=development

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -buildvcs=false \
      -ldflags="-s -w -buildid= -X main.version=${VERSION}" \
      -o /out/t-lingual ./cmd/t-lingual && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -buildvcs=false \
      -ldflags="-s -w -buildid=" \
      -o /out/tlingualctl ./cmd/tlingualctl


# Debian rather than Alpine: when the GPU is shared with the container
# (compose.gpu.yaml), the runtime mounts in the driver's nvidia-smi, which
# needs glibc. Nothing is installed; the CA bundle comes from the build stage.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

ARG VERSION=development
ARG REVISION=unknown
ARG BUILD_DATE=1970-01-01T00:00:00Z

LABEL org.opencontainers.image.title="t-lingual" \
      org.opencontainers.image.description="Simultaneous interpretation with passkeys and one-time access codes using external ASR and translation APIs" \
      org.opencontainers.image.url="https://github.com/Tularity/t-lingual" \
      org.opencontainers.image.source="https://github.com/Tularity/t-lingual" \
      org.opencontainers.image.documentation="https://github.com/Tularity/t-lingual#readme" \
      org.opencontainers.image.vendor="Tularity" \
      org.opencontainers.image.base.name="docker.io/library/debian:bookworm-slim" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.created=$BUILD_DATE

COPY --from=go-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN test -s /etc/ssl/certs/ca-certificates.crt && \
    groupadd --system --gid 10001 tlingual && \
    useradd --system --no-create-home --uid 10001 --gid tlingual --shell /usr/sbin/nologin tlingual && \
    mkdir -p /app/data /app/web && \
    chown -R 10001:10001 /app && \
    chmod 0700 /app/data

WORKDIR /app
COPY --from=go-build --chown=10001:10001 --chmod=0555 /out/t-lingual /out/tlingualctl /app/
COPY --from=web-build --chown=10001:10001 /src/frontend/dist/ /app/web/

ENV PATH="/app:${PATH}" \
    TLINGUAL_ENV=production \
    TLINGUAL_LISTEN_ADDR=:8080 \
    TLINGUAL_DATA_PATH=/app/data/t-lingual.db \
    TLINGUAL_MASTER_KEY_PATH=/app/data/master.key \
    TLINGUAL_ADMIN_SOCKET=/app/data/admin.sock \
    TLINGUAL_WEB_ROOT=/app/web

USER 10001:10001
VOLUME ["/app/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/app/t-lingual", "healthcheck"]

ENTRYPOINT ["/app/t-lingual"]
