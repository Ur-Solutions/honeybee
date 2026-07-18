import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const expectedPassword = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const expectedUsername = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const expectedAuthorization = `Basic ${Buffer.from(`${expectedUsername}:${expectedPassword}`).toString("base64")}`;
const urlFile = process.env.FAKE_OPENCODE_URL_FILE;
const stopFile = process.env.FAKE_OPENCODE_STOP_FILE;

const requests = [];
const clients = new Set();
const sessions = new Map();
let messages = [];
let permissions = [];
let questions = [];
let status = {};
let promptBeforeSubscription = false;
let healthUnauthorizedAttempts = 0;
let descendant;

if (process.env.FAKE_OPENCODE_RESUME_ID) {
  const id = process.env.FAKE_OPENCODE_RESUME_ID;
  const directory = process.env.FAKE_OPENCODE_RESUME_DIR ?? process.cwd();
  const metadata = process.env.FAKE_OPENCODE_RESUME_METADATA
    ? JSON.parse(process.env.FAKE_OPENCODE_RESUME_METADATA)
    : {};
  sessions.set(id, sessionInfo(id, directory, metadata));
}

if (process.env.FAKE_OPENCODE_SPAWN_DESCENDANT === "1") {
  descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

function sessionInfo(id, directory, metadata = {}) {
  const now = Date.now();
  return {
    id,
    slug: "fake",
    projectID: "project_fake",
    directory,
    title: "Fake OpenCode",
    version: "1.17.18-fixture",
    metadata,
    time: { created: now, updated: now },
  };
}

function sendJson(response, code, value) {
  const body = value === undefined ? "" : JSON.stringify(value);
  response.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function bodyJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk.toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function broadcast(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) response.write(frame);
}

function applyEvent(event) {
  const properties = event?.properties ?? {};
  if (event?.type === "session.status" && typeof properties.sessionID === "string") {
    if (properties.status?.type === "idle") delete status[properties.sessionID];
    else status[properties.sessionID] = properties.status;
  }
  if (event?.type === "session.idle" && typeof properties.sessionID === "string") delete status[properties.sessionID];
  if (event?.type === "permission.asked") {
    permissions = [...permissions.filter((item) => item.id !== properties.id), properties];
  }
  if (event?.type === "permission.replied") permissions = permissions.filter((item) => item.id !== properties.requestID);
  if (event?.type === "question.asked") {
    questions = [...questions.filter((item) => item.id !== properties.id), properties];
  }
  if (event?.type === "question.replied" || event?.type === "question.rejected") {
    questions = questions.filter((item) => item.id !== properties.requestID);
  }
}

function publicState(serverUrl) {
  return {
    url: serverUrl,
    passwordConfigured: expectedPassword.length >= 32,
    username: expectedUsername,
    requests,
    sessions: [...sessions.values()],
    messages,
    permissions,
    questions,
    status,
    promptBeforeSubscription,
    healthUnauthorizedAttempts,
    sseClients: clients.size,
    descendantPid: descendant?.pid,
  };
}

let serverUrl = "";
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path.startsWith("/__test/")) {
    if (path === "/__test/state" && request.method === "GET") return sendJson(response, 200, publicState(serverUrl));
    if (path === "/__test/emit" && request.method === "POST") {
      const event = await bodyJson(request);
      applyEvent(event);
      broadcast(event);
      return sendJson(response, 200, true);
    }
    if (path === "/__test/set" && request.method === "POST") {
      const next = await bodyJson(request);
      if (Array.isArray(next?.messages)) messages = next.messages;
      if (next?.status && typeof next.status === "object") status = next.status;
      if (Array.isArray(next?.permissions)) permissions = next.permissions;
      if (Array.isArray(next?.questions)) questions = next.questions;
      return sendJson(response, 200, true);
    }
    if (path === "/__test/disconnect" && request.method === "POST") {
      for (const client of clients) client.end();
      clients.clear();
      return sendJson(response, 200, true);
    }
    return sendJson(response, 404, { message: "unknown test route" });
  }

  const authorized = request.headers.authorization === expectedAuthorization;
  if (!authorized || process.env.FAKE_OPENCODE_FORCE_401 === "1") {
    if (path === "/global/health") healthUnauthorizedAttempts++;
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Secure Area"' });
    response.end();
    return;
  }

  if (path === "/event" && request.method === "GET") {
    requests.push({ method: request.method, path, authorized, directory: url.searchParams.get("directory") });
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.flushHeaders();
    clients.add(response);
    response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    request.once("close", () => clients.delete(response));
    return;
  }

  let body;
  if (["POST", "PATCH", "PUT"].includes(request.method ?? "")) body = await bodyJson(request);
  requests.push({
    method: request.method,
    path,
    authorized,
    directory: url.searchParams.get("directory"),
    body,
    subscriptionCount: clients.size,
  });

  if (path === "/global/health" && request.method === "GET") {
    return sendJson(response, 200, { healthy: true, version: "1.17.18-fixture" });
  }
  if (path === "/session" && request.method === "POST") {
    const id = "ses_fake";
    const info = sessionInfo(id, url.searchParams.get("directory") ?? process.cwd(), body?.metadata ?? {});
    if (body?.model) info.model = body.model;
    if (body?.permission) info.permission = body.permission;
    sessions.set(id, info);
    return sendJson(response, 200, info);
  }
  if (path === "/session/status" && request.method === "GET") return sendJson(response, 200, status);
  if (path === "/permission" && request.method === "GET") return sendJson(response, 200, permissions);
  if (path === "/question" && request.method === "GET") return sendJson(response, 200, questions);

  const messageMatch = path.match(/^\/session\/([^/]+)\/message$/);
  if (messageMatch && request.method === "GET") return sendJson(response, 200, messages);
  const promptMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (promptMatch && request.method === "POST") {
    const sessionID = decodeURIComponent(promptMatch[1]);
    promptBeforeSubscription ||= clients.size === 0;
    status[sessionID] = { type: "busy" };
    broadcast({ type: "session.status", properties: { sessionID, status: { type: "busy" } } });
    response.writeHead(204);
    response.end();
    if (process.env.FAKE_OPENCODE_AUTO_IDLE === "1") {
      setTimeout(() => {
        delete status[sessionID];
        broadcast({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
        broadcast({ type: "session.idle", properties: { sessionID } });
      }, 10);
    }
    return;
  }
  const abortMatch = path.match(/^\/session\/([^/]+)\/abort$/);
  if (abortMatch && request.method === "POST") {
    const sessionID = decodeURIComponent(abortMatch[1]);
    delete status[sessionID];
    broadcast({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
    broadcast({ type: "session.idle", properties: { sessionID } });
    return sendJson(response, 200, true);
  }
  const sessionMatch = path.match(/^\/session\/([^/]+)$/);
  if (sessionMatch && request.method === "GET") {
    const info = sessions.get(decodeURIComponent(sessionMatch[1]));
    return info ? sendJson(response, 200, info) : sendJson(response, 404, { message: "session not found" });
  }
  if (sessionMatch && request.method === "PATCH") {
    const id = decodeURIComponent(sessionMatch[1]);
    const info = sessions.get(id);
    if (!info) return sendJson(response, 404, { message: "session not found" });
    const updated = { ...info, ...body, metadata: body?.metadata ?? info.metadata };
    sessions.set(id, updated);
    return sendJson(response, 200, updated);
  }
  const permissionReply = path.match(/^\/permission\/([^/]+)\/reply$/);
  if (permissionReply && request.method === "POST") {
    const requestID = decodeURIComponent(permissionReply[1]);
    const pending = permissions.find((item) => item.id === requestID);
    permissions = permissions.filter((item) => item.id !== requestID);
    if (pending) broadcast({ type: "permission.replied", properties: { sessionID: pending.sessionID, requestID, reply: body?.reply } });
    return sendJson(response, 200, true);
  }
  const questionReply = path.match(/^\/question\/([^/]+)\/reply$/);
  if (questionReply && request.method === "POST") {
    const requestID = decodeURIComponent(questionReply[1]);
    const pending = questions.find((item) => item.id === requestID);
    questions = questions.filter((item) => item.id !== requestID);
    if (pending) broadcast({ type: "question.replied", properties: { sessionID: pending.sessionID, requestID, answers: body?.answers } });
    return sendJson(response, 200, true);
  }
  const questionReject = path.match(/^\/question\/([^/]+)\/reject$/);
  if (questionReject && request.method === "POST") {
    const requestID = decodeURIComponent(questionReject[1]);
    const pending = questions.find((item) => item.id === requestID);
    questions = questions.filter((item) => item.id !== requestID);
    if (pending) broadcast({ type: "question.rejected", properties: { sessionID: pending.sessionID, requestID } });
    return sendJson(response, 200, true);
  }

  return sendJson(response, 404, { message: `unhandled ${request.method} ${path}` });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  serverUrl = `http://127.0.0.1:${address.port}`;
  if (urlFile) writeFileSync(urlFile, JSON.stringify({ url: serverUrl }), { mode: 0o600 });
  console.log(`opencode server listening on ${serverUrl}`);
});

function shutdown(signal) {
  if (stopFile) writeFileSync(stopFile, signal, { mode: 0o600 });
  for (const client of clients) client.destroy();
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
