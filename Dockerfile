# syntax=docker/dockerfile:1

# Build Go server
FROM golang:1.24 AS build-go
WORKDIR /app
COPY container_src/go.mod ./
RUN go mod download
COPY container_src/*.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /server

# Build Rust filesystem daemon
FROM rust:1.75 AS build-rust
RUN apt-get update && apt-get install -y libfuse-dev pkg-config ca-certificates
WORKDIR /app
COPY container_src/Cargo.toml ./
COPY container_src/fsdaemon.rs ./src/main.rs
RUN mkdir -p src && cargo build --release

# Final stage
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y fuse ca-certificates
RUN mkdir -p /storage

# Copy binaries
COPY --from=build-go /server /server
COPY --from=build-rust /app/target/release/fsdaemon /fsdaemon

# Start script that runs both the filesystem daemon and the server
RUN echo '#!/bin/bash' > /start.sh && \
    echo '/fsdaemon &' >> /start.sh && \
    echo 'sleep 2' >> /start.sh && \
    echo 'exec /server' >> /start.sh && \
    chmod +x /start.sh

EXPOSE 8080
CMD ["/start.sh"]