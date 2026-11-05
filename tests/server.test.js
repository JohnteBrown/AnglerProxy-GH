import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { createProxyServer } from "../server/server.js";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

const close = async (server) => {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const proxyRequest = (port, options) => {
  const { body, ...requestOptions } = options;
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        ...requestOptions,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
};

const proxyConnect = (port, headers = "") =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let received = Buffer.alloc(0);
    socket.once("connect", () => {
      socket.write(
        `CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n${headers}\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.includes("\r\n\r\n")) {
        socket.end();
        resolve(received.toString());
      }
    });
    socket.on("error", reject);
  });

test("forwards absolute HTTP requests and removes proxy-only headers", async (t) => {
  const logs = [];
  let observed;
  const upstream = http.createServer((req, res) => {
    observed = {
      method: req.method,
      url: req.url,
      host: req.headers.host,
      proxyAuthorization: req.headers["proxy-authorization"],
    };
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("x-upstream", "reached");
      res.end(Buffer.concat(chunks));
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({
    resolveTarget: async () => ({ address: "127.0.0.1", family: 4 }),
    logger: { info: (entry) => logs.push(entry) },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const result = await proxyRequest(proxyPort, {
    method: "POST",
    path: `http://public.example:${upstreamPort}/echo?q=1`,
    headers: {
      "proxy-authorization": "Basic c2VjcmV0OnNlY3JldA==",
    },
    body: "payload",
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, "payload");
  assert.equal(result.headers["x-upstream"], "reached");
  assert.deepEqual(observed, {
    method: "POST",
    url: "/echo?q=1",
    host: `public.example:${upstreamPort}`,
    proxyAuthorization: undefined,
  });
  assert.deepEqual(logs, [{
    method: "POST",
    url: `http://public.example:${upstreamPort}/echo?q=1`,
    statusCode: 200,
  }]);
});

test("tunnels HTTPS CONNECT traffic", { timeout: 10_000 }, async (t) => {
  const logs = [];
  const upstream = net.createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({
    username: "user",
    password: "pass",
    resolveTarget: async () => ({ address: "127.0.0.1", family: 4 }),
    connect: () => net.connect({ host: "127.0.0.1", port: upstreamPort }),
    logger: { info: (entry) => logs.push(entry) },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
  });

  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let received = Buffer.alloc(0);
    let sentPayload = false;
    socket.once("connect", () => {
      socket.write(
        "CONNECT public.example:443 HTTP/1.1\r\n" +
          "Host: public.example:443\r\n" +
          "Proxy-Authorization: Basic dXNlcjpwYXNz\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf("\r\n\r\n");
      if (boundary !== -1 && !sentPayload) {
        sentPayload = true;
        socket.write("tunnel-data");
      }
      if (sentPayload && received.subarray(boundary + 4).includes("tunnel-data")) {
        socket.end();
        resolve(received.toString());
      }
    });
    socket.on("error", reject);
  });

  assert.match(response, /^HTTP\/1\.1 200 Connection Established\r\n/);
  assert.ok(response.includes("tunnel-data"));
  assert.deepEqual(logs, [{
    method: "CONNECT",
    url: "public.example:443",
    statusCode: 200,
  }]);
});

test("rejects local and private destinations", async (t) => {
  const proxy = createProxyServer();
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  for (const destination of ["http://localhost/", "http://192.168.1.1/", "http://[::1]/"]) {
    const result = await proxyRequest(proxyPort, { path: destination });

    assert.equal(result.status, 403, destination);
    assert.match(result.body, /Destination is not allowed/, destination);
  }
});

test("requires credentials off loopback and challenges unauthenticated clients", async (t) => {
  assert.throws(
    () => createProxyServer({ host: "0.0.0.0" }),
    /Credentials are required/,
  );

  const proxy = createProxyServer({
    username: "user",
    password: "pass",
  });
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const result = await proxyRequest(proxyPort, {
    path: "http://public.example/",
  });

  assert.equal(result.status, 407);
  assert.match(result.headers["proxy-authenticate"], /^Basic/);
  const tunnelResponse = await proxyConnect(proxyPort);
  assert.match(tunnelResponse, /^HTTP\/1\.1 407 Proxy Authentication Required\r\n/);
  assert.match(tunnelResponse, /Proxy-Authenticate: Basic realm="AnglerProxy"/);
});

test("rejects relative-form requests", async (t) => {
  const proxy = createProxyServer();
  const proxyPort = await listen(proxy);
  t.after(() => close(proxy));

  const result = await proxyRequest(proxyPort, {
    path: "/relative/path",
  });

  assert.equal(result.status, 400);
});
