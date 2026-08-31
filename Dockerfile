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


FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

ARG VERSION=development
ARG REVISION=unknown
ARG BUILD_DATE=1970-01-01T00:00:00Z

LABEL org.opencontainers.image.title="t-lingual" \
      org.opencontainers.image.description="Passkey-only simultaneous interpretation using external ASR and translation APIs" \
      org.opencontainers.image.url="https://github.com/Tularity/t-lingual" \
      org.opencontainers.image.source="https://github.com/Tularity/t-lingual" \
      org.opencontainers.image.documentation="https://github.com/Tularity/t-lingual#readme" \
      org.opencontainers.image.vendor="Tularity" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24.1" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.created=$BUILD_DATE

RUN test -s /etc/ssl/certs/ca-certificates.crt && \
    addgroup -S -g 10001 tlingual && \
    adduser -S -D -H -u 10001 -G tlingual tlingual && \
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
    CMD wget -q -T 3 -O /dev/null http://127.0.0.1:8080/health/live || exit 1

ENTRYPOINT ["/app/t-lingual"]
