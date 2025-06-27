import { Container, loadBalance, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";

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

  private fileSystemStorage = new Map<string, Uint8Array>();


  private async handleFileSystemOperation(message: any) {
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
        const writeData = new Uint8Array(data);
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
          .filter(key => key.startsWith(path === "/" ? "" : path))
          .map(key => key.slice(path.length).split("/")[0])
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

  // Optional lifecycle hooks
  override async onStart() {
    console.log("Container successfully started");
    // Load existing files from storage
    const files = await this.ctx.storage.list({ prefix: "fs:" });
    for (const [key, value] of files) {
      const path = key.slice(3); // Remove "fs:" prefix
      this.fileSystemStorage.set(path, value as Uint8Array);
    }
  }

  override onStop() {
    console.log("Container successfully shut down");
  }

  override onError(error: unknown) {
    console.log("Container error:", error);
  }
}

export class MyContainer2 extends Container<Env> {
  // Port the container listens on
  defaultPort = 80;
  // Time before container sleeps due to inactivity (default: 30s)
  sleepAfter = "2m";
  // Environment variables passed to the container
  envVars = {
    MESSAGE: "I was passed in via the container class 2!",
    MYSECRET: this.env.MYSECRET,
  };

  // Optional lifecycle hooks
  override onStart() {
    console.log("Container 2 successfully started");
  }

  override onStop() {
    console.log("Container 2 successfully shut down");
  }

  override onError(error: unknown) {
    console.log("Container 2 error:", error);
  }
}

// Create Hono app with proper typing for Cloudflare Workers
const app = new Hono<{
  Bindings: {
    MY_CONTAINER: DurableObjectNamespace<MyContainer>;
    MY_CONTAINER2: DurableObjectNamespace<MyContainer2>;
  };
}>();

// Home route with available endpoints
app.get("/", (c) => {
  return c.text(
    "Available endpoints:\n" +
    "GET /container/<ID> - Start a container for each ID with a 2m timeout\n" +
    "GET /lb - Load balance requests over multiple containers\n" +
    "GET /error - Start a container that errors (demonstrates error handling)\n" +
    "GET /singleton - Get a single specific container instance\n" +
    "GET /random?size=<bytes> - Generate random data (default: 1024 bytes)",
  );
});

// Route requests to a specific container using the container ID
app.get("/container/:id", async (c) => {
  const id = c.req.param("id");
  const containerId = c.env.MY_CONTAINER.idFromName(`/container/${id}`);
  const container = c.env.MY_CONTAINER.get(containerId);

  // Initialize filesystem connection for this container instance
  try {
    const conn = container.connect('10.0.0.1:8000');
    await conn.opened;
    console.log(`Filesystem connection established for container ${id}`);

    // Handle the connection for filesystem operations
    // Store connection reference or handle streams here
  } catch (error) {
    console.error(`Failed to connect to filesystem for container ${id}:`, error);
  }

  return await container.fetch(c.req.raw);
});

export default app;
