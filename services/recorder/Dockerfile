# syntax=docker/dockerfile:1
# IndiansAssist server-side recorder (docs/specs/phase-a2-recorder.md).

FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=0.1.0
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath \
      -ldflags "-s -w -X github.com/indiansassist/recorder/internal/config.Version=${VERSION}" \
      -o /out/recorder ./cmd/recorder \
 && mkdir -p /out/data/recorder

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/recorder /recorder
COPY --from=build --chown=65532:65532 /out/data /data
ENV OUT_DIR=/data/recorder \
    HTTP_ADDR=:9470 \
    UDP_PORT_MIN=50000 \
    UDP_PORT_MAX=50100
USER 65532:65532
VOLUME ["/data"]
# /healthz and /metrics (internal only, never proxied); UDP range for ICE host candidates.
EXPOSE 9470 50000-50100/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["/recorder", "healthcheck"]
ENTRYPOINT ["/recorder"]
