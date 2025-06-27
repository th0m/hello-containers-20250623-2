import { Container } from "@cloudflare/containers";
import { Hono } from "hono";

interface FSMessage {
  id: number;
  operation: "read" | "write" | "stat" | "readdir" | "unlink";
  path: string;
  data?: number[];
  offset?: number;
  size?: number;
}

interface FSResponse {
  id: number;
  data?: number[];
  bytesWritten?: number;
  files?: string[];
  stat?: {
    size: number;
    isFile: boolean;
    isDir: boolean;
    mtime: number;
  };
  success?: boolean;
  error?: string;
}

interface Connection {
  opened: Promise<any>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

// Global map to store TCP connections by container ID
const containerConnections = new Map<string, Connection>();

export class MyContainer extends Container<Env> {
  // Port the container listens on
  defaultPort = 80;
  // Time before container sleeps due to inactivity (default: 30s)
  sleepAfter = "2m";
  // Environment variables passed to the container
  envVars = {
    MESSAGE: "I was passed in via the container class!",
    MYSECRET: this.env.MYSECRET
  };

  public fileSystemStorage = new Map<string, Uint8Array>();
  private containerId?: string;

  async performFileSystemOperation(message: FSMessage): Promise<FSResponse> {
    const { id, operation, path, data, offset, size } = message;

    switch (operation) {
      case "read":
        const fileData = this.fileSystemStorage.get(path);
        if (!fileData) {
          return { id, error: "File not found" };
        }
        const readData = fileData.slice(offset || 0, (offset || 0) + (size || fileData.length));
        return { id, data: Array.from(readData) };

      case "write":
        const writeData = new Uint8Array(data || []);
        if (offset) {
          const existing = this.fileSystemStorage.get(path) || new Uint8Array();
          const newData = new Uint8Array(Math.max(existing.length, offset + writeData.length));
          newData.set(existing);
          newData.set(writeData, offset);
          this.fileSystemStorage.set(path, newData);
        } else {
          this.fileSystemStorage.set(path, writeData);
        }
        await this.ctx.storage.put(`fs:${path}`, writeData);
        return { id, bytesWritten: writeData.length };

      case "stat":
        const statData = this.fileSystemStorage.get(path);
        if (!statData) {
          return { id, error: "File not found" };
        }
        return {
          id,
          stat: {
            size: statData.length,
            isFile: true,
            isDir: false,
            mtime: Date.now()
          }
        };

      case "readdir":
        const files = Array.from(this.fileSystemStorage.keys())
          .filter((key: string) => key.startsWith(path === "/" ? "" : path))
          .map((key: string) => key.slice(path.length).split("/")[0])
          .filter((name, index, arr) => arr.indexOf(name) === index && name);
        return { id, files };

      case "unlink":
        const existed = this.fileSystemStorage.has(path);
        this.fileSystemStorage.delete(path);
        await this.ctx.storage.delete(`fs:${path}`);
        return { id, success: existed };

      default:
        return { id, error: "Unknown operation" };
    }
  }

  async handleFilesystemConnection(conn: Connection): Promise<void> {
    const reader = conn.readable.getReader();
    const writer = conn.writable.getWriter();

    let buffer = new Uint8Array();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Append new data to buffer
        const combined = new Uint8Array(buffer.length + value.length);
        combined.set(buffer);
        combined.set(value, buffer.length);
        buffer = combined;

        // Try to parse complete messages (length-prefixed)
        while (buffer.length >= 4) {
          const messageLength = new DataView(buffer.buffer).getUint32(0, true);
          if (buffer.length >= 4 + messageLength) {
            const messageBytes = buffer.slice(4, 4 + messageLength);
            const message = JSON.parse(new TextDecoder().decode(messageBytes)) as FSMessage;

            // Process the filesystem operation
            const response = await this.performFileSystemOperation(message);
            const responseBytes = new TextEncoder().encode(JSON.stringify(response));

            // Send length-prefixed response
            const responseBuffer = new ArrayBuffer(4 + responseBytes.length);
            const view = new DataView(responseBuffer);
            view.setUint32(0, responseBytes.length, true);
            new Uint8Array(responseBuffer, 4).set(responseBytes);

            await writer.write(new Uint8Array(responseBuffer));

            // Remove processed message from buffer
            buffer = buffer.slice(4 + messageLength);
          } else {
            break; // Wait for more data
          }
        }
      }
    } catch (error) {
      console.error("Filesystem stream error:", error);
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }



  // Optional lifecycle hooks
  override async onStart() {
    console.log("Container successfully started");
    // Load existing files from storage
    const files = await this.ctx.storage.list({ prefix: "fs:" });
    for (const [key, value] of files) {
      const path = key.slice(3); // Remove "fs:" prefix
      this.fileSystemStorage.set(path, value as Uint8Array);
    }
    
    // Check for TCP connections for all possible container IDs
    // Try to find a connection that matches this DO instance
    for (const [id, connection] of containerConnections.entries()) {
      // Start handling the connection for this DO instance
      console.log(`Starting filesystem connection handler for container ${id}`);
      this.handleFilesystemConnection(connection);
      // Remove from map once handled
      containerConnections.delete(id);
      break; // Only handle one connection per DO instance
    }
  }

  override onStop() {
    console.log("Container successfully shut down");
  }

  override onError(error: unknown) {
    console.log("Container error:", error);
  }
}

// Create Hono app with proper typing for Cloudflare Workers
const app = new Hono<{
  Bindings: {
    MY_CONTAINER: DurableObjectNamespace<MyContainer>;
  };
}>();

// Home route with available endpoints
app.get("/", (c) => {
  return c.text(
    "Available endpoints:\n" +
    "GET /container/<ID> - Start a container for each ID with a 2m timeout\n"
  );
});

// Route requests to a specific container using the container ID
app.get("/container/:id", async (c) => {
  const id = c.req.param("id");
  const containerId = c.env.MY_CONTAINER.idFromName(`/container/${id}`);
  const container = c.env.MY_CONTAINER.get(containerId);

  // Initialize filesystem connection for this container instance
  try {
    const conn = container.connect('10.0.0.1:8000') as Connection;
    await conn.opened;
    console.log(`Filesystem connection established for container ${id}`);
    
    // Store connection for the DO to pick up
    containerConnections.set(id, conn);
  } catch (error) {
    console.error(`Failed to connect to filesystem for container ${id}:`, error);
  }

  return await container.fetch(c.req.raw);
});

export default app;
