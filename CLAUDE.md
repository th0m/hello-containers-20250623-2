# Stateful Storage for Cloudflare Workers Containers

## Project Overview
Created a stateful storage library that provides filesystem-like persistence for Cloudflare Workers containers using Durable Objects. Any application running inside a container can write to `/storage/` and the data persists across container restarts/scaling.

## Architecture

### Components
1. **Durable Object Storage Backend** (`src/index.ts`)
   - Extends Container class from `@cloudflare/containers`
   - Provides TCP connection handling from DO to container
   - File operations: read, write, stat, readdir, unlink
   - Persistent storage using Durable Object storage with `fs:` prefix
   - Each container ID gets isolated storage via `c.env.MY_CONTAINER.idFromName(\`/container/\${id}\`)`

2. **Rust FUSE Filesystem Daemon** (`container_src/fsdaemon.rs`)
   - Mounts `/storage` directory inside container using FUSE
   - Listens on `10.0.0.1:8000` for incoming DO connections
   - Translates file I/O operations to TCP messages sent to DO
   - Uses length-prefixed JSON protocol for communication
   - Built with dependencies: `fuser`, `serde`, `tokio`, `libc`

3. **Multi-stage Dockerfile**
   - Builds Go server (for demo app with visit counter)
   - Builds Rust FUSE daemon
   - Ubuntu-based final stage with FUSE support
   - Runs both binaries via start script

## Communication Flow
1. HTTP request to `/container/:id` creates/gets DO instance for that ID
2. DO calls `container.connect('10.0.0.1:8000')` to establish TCP connection to container
3. Container apps write to `/storage/myfile.txt` using normal file I/O
4. FUSE daemon intercepts file operations and sends to DO via TCP
5. DO processes file operations and stores in persistent Durable Object storage
6. Each container ID has completely isolated filesystem storage

## API Reference

### Container Class Methods
- `connect(address: string)`: Establishes TCP connection to container filesystem daemon
- `handleFileSystemOperation(message)`: Processes filesystem requests (read, write, stat, readdir, unlink)
- File storage uses Map in memory + Durable Object storage for persistence

### Filesystem Protocol (JSON over TCP, length-prefixed)
```typescript
// Request format
{
  id: number,
  operation: "read" | "write" | "stat" | "readdir" | "unlink",
  path: string,
  data?: Uint8Array,  // for write operations
  offset?: number,    // for read/write operations  
  size?: number       // for read operations
}

// Response format
{
  id: number,
  data?: Uint8Array,           // for read operations
  bytesWritten?: number,       // for write operations
  files?: string[],            // for readdir operations
  stat?: FileStat,             // for stat operations
  success?: boolean,           // for unlink operations
  error?: string               // for error conditions
}
```

## Current Status
- ✅ Durable Object with TCP connection handling 
- ✅ Rust FUSE filesystem daemon with TCP listener
- ✅ Container builds successfully with Ubuntu base
- ✅ Go demo app with persistent visit counter
- ✅ Wrangler dev server running
- ✅ Proper container.connect() API usage
- ⚠️ TODO: Complete TCP stream handling with conn.readable/writable
- ⚠️ TODO: Test end-to-end file I/O functionality

## Key Files
- `src/index.ts`: Main Worker with Container classes and routing
- `container_src/fsdaemon.rs`: FUSE filesystem daemon
- `container_src/main.go`: Demo Go app using persistent storage
- `container_src/Cargo.toml`: Rust dependencies
- `Dockerfile`: Multi-stage build for Go + Rust
- `wrangler.jsonc`: Worker configuration with containers and DO bindings

## Usage Example
```go
// Inside any container application
os.WriteFile("/storage/myfile.txt", data, 0644)  // Persisted to DO
data, _ := os.ReadFile("/storage/myfile.txt")     // Retrieved from DO
```

## Notes
- Uses `@cloudflare/containers` with proper `container.connect()` API
- Each container instance gets isolated storage by ID
- FUSE provides transparent filesystem interface for any language
- Length-prefixed TCP protocol for reliable message framing