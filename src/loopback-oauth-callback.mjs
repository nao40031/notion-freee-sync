import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

const loopback = address => address === "127.0.0.1" || address === "::ffff:127.0.0.1" || address === "::1";
const secureEqual = (a, b) => { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); return left.length === right.length && timingSafeEqual(left, right); };
function single(url, key) { const values = url.searchParams.getAll(key); if (values.length > 1) throw Error("oauth_callback_duplicate_parameter"); return values[0] || ""; }

/** Provider-neutral one-shot loopback receiver. It validates state and never
 * exchanges or logs the authorization code; caller performs the token exchange. */
export async function startLoopbackOAuthCallback({ redirectUri, authorizationUrlForState, host = "127.0.0.1", port, path,
  timeoutMs = 180_000, random = randomBytes, serverFactory = createServer, now = Date.now } = {}) {
  if (host !== "127.0.0.1" || typeof redirectUri !== "string" || typeof authorizationUrlForState !== "function" || !Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw Error("oauth_callback_config_invalid");
  const redirect = new URL(redirectUri);
  const callbackPath = path || redirect.pathname;
  if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirect.hostname) || redirect.pathname !== callbackPath || (port !== 0 && Number(redirect.port || 80) !== port)) throw Error("oauth_callback_redirect_invalid");
  const state = random(32).toString("hex"), authorizationUrl = authorizationUrlForState({ state, redirectUri });
  if (typeof authorizationUrl !== "string" || new URL(authorizationUrl).protocol !== "https:") throw Error("oauth_authorization_url_invalid");
  const server = serverFactory(); let settled = false, timer;
  let resolveResult, rejectResult;
  const done = new Promise((resolvePromise, rejectPromise) => { resolveResult = resolvePromise; rejectResult = rejectPromise; });
  void done.catch(() => {});
  server.on("request", (req, res) => {
    if (!loopback(req.socket.remoteAddress)) { res.writeHead(403).end("Loopback only."); return; }
    let url; try { url = new URL(req.url || "/", redirectUri); } catch { res.writeHead(400).end("Invalid callback."); return; }
    if (req.method !== "GET" || url.pathname !== callbackPath) { res.writeHead(404).end("Not found."); return; }
    if (settled) { res.writeHead(409).end("Callback already handled."); return; }
    let incoming, code, providerError;
    try { incoming = single(url, "state"); code = single(url, "code"); providerError = single(url, "error"); }
    catch { res.writeHead(400).end("Invalid callback."); return; }
    if (!incoming || !secureEqual(incoming, state)) { res.writeHead(400).end("State validation failed."); return; }
    if (providerError) { settled = true; res.writeHead(400).end("Authorization was not completed."); rejectResult(Error("oauth_authorization_denied")); return; }
    if (!code || code.length > 4096) { res.writeHead(400).end("Authorization code missing or invalid."); return; }
    settled = true; res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("Authorization received. You may close this window.");
    resolveResult(Object.freeze({ code, received_at: new Date(now()).toISOString() }));
  });
  await new Promise((resolvePromise, rejectPromise) => { server.once("error", () => rejectPromise(Error("oauth_callback_listener_failed"))); server.listen(port, host, resolvePromise); });
  const address = server.address();
  if (!address || typeof address === "string") { await new Promise(r => server.close(r)); throw Error("oauth_callback_listener_invalid"); }
  const actualRedirectUri = `${redirect.protocol}//127.0.0.1:${address.port}${callbackPath}`;
  if (port !== 0 && actualRedirectUri !== redirectUri.replace("localhost", "127.0.0.1")) { await new Promise(r => server.close(r)); throw Error("oauth_callback_port_mismatch"); }
  timer = setTimeout(() => { if (!settled) { settled = true; rejectResult(Error("oauth_callback_timeout")); } }, timeoutMs);
  return Object.freeze({ state, authorizationUrl, redirectUri: actualRedirectUri, callbackAddress: address,
    wait: async () => { try { return await done; } finally { clearTimeout(timer); await new Promise(r => server.close(r)); } },
    close: async () => { if (!settled) { settled = true; rejectResult(Error("oauth_callback_cancelled")); } clearTimeout(timer); await new Promise(r => server.close(r)); } });
}
