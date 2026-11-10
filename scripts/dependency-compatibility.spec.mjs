import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import test from "node:test";

// Resolve from the consuming tool so nested/hoisted lockfile layouts both work.
const miniflareRequire = createRequire(import.meta.resolve("miniflare"));
const sharp = miniflareRequire("sharp");
const { fetch, Agent } = miniflareRequire("undici");

test("patched native sharp decodes, resizes and re-encodes the emulator's image input", async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: "#224466" } }).png().toBuffer();
  const jpg = await sharp(png).resize(2, 3, { fit: "fill" }).jpeg().toBuffer();
  const metadata = await sharp(jpg).metadata();
  assert.equal(metadata.width, 2); assert.equal(metadata.height, 3); assert.equal(metadata.format, "jpeg");
});

test("patched undici consumes a compressed loopback response and releases its connection", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    response.end(gzipSync(JSON.stringify({ local: true, telemetry: "simulated" })));
  });
  const agent = new Agent();
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`, { dispatcher: agent });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { local: true, telemetry: "simulated" });
  } finally {
    await agent.close();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("patched Zod retains the Workers pool configuration-validation contract", () => {
  const poolRequire = createRequire(import.meta.resolve("@cloudflare/vitest-pool-workers"));
  const { z } = poolRequire("zod");
  const schema = z.object({ workers: z.array(z.object({ name: z.string(), enabled: z.boolean() })).max(5) });
  assert.deepEqual(schema.parse({ workers: [{ name: "local", enabled: true }] }), { workers: [{ name: "local", enabled: true }] });
  assert.equal(schema.safeParse({ workers: [{ name: 123, enabled: true }] }).success, false);
  assert.equal(schema.safeParse({ workers: Array.from({ length: 6 }, () => ({ name: "local", enabled: true })) }).success, false);
});
