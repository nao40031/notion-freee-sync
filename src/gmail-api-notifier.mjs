const safeAddress = value => typeof value === "string" && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && !/[\r\n]/.test(value);
const safeText = value => String(value ?? "").replace(/[\r\n\t]+/g, " ")
  .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, 500);
const safeErrorCode = value => /^[A-Za-z0-9_:-]{1,96}$/.test(String(value ?? "")) ? String(value) : "sync_error";
function base64url(value) { return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }

function errorBody(event) {
  if (!event || !["sync_run_failed", "sync_unknown", "sync_failed", "sync_email_failed"].includes(event.type || event.event)) throw Error("gmail_notification_event_invalid");
  const type = event.type || event.event;
  return [
    `Occurred: ${safeText(event.failed_at || event.occurred_at || event.at || new Date().toISOString())}`,
    `Error type: ${safeErrorCode(event.error_type || event.reason || type)}`,
    `Document: ${safeText(event.document_type || "unknown")}${event.freee_id ? ` / ${safeText(event.freee_id)}` : ""}`,
    `Summary: ${safeErrorCode(event.error_type || event.reason || type)}`,
    `Sync status: ${type === "sync_unknown" ? "stopped; no automatic resend" : "run failed; inspect before resuming"}`,
    "Recommended action: inspect the sanitized run log and reconcile any unknown operation by read-back before retrying.",
    `Log reference: ${safeText(event.log_reference || "configured local run log")}`,
  ].join("\r\n");
}

/** Gmail API transport using the host's OAuth provider. It sends only sanitized
 * operational error summaries; account, token store and recipient are host config. */
export function createGmailApiNotifier({ tokenProvider, from, to = from, fetchImpl = globalThis.fetch, endpoint = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" } = {}) {
  if (typeof tokenProvider?.getAccessToken !== "function" || !safeAddress(from) || !safeAddress(to) || typeof fetchImpl !== "function" || new URL(endpoint).protocol !== "https:") throw Error("gmail_notifier_config_invalid");
  return async event => {
    const type = event?.type || event?.event;
    const subject = type === "sync_unknown" ? "[Notion × freee] Sync outcome unknown" : "[Notion × freee] Sync error";
    const message = [`To: ${to}`, `From: ${from}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", errorBody(event)].join("\r\n");
    let response;
    try { response = await fetchImpl(endpoint, { method: "POST", headers: { authorization: `Bearer ${await tokenProvider.getAccessToken()}`, "content-type": "application/json" }, body: JSON.stringify({ raw: base64url(message) }) }); }
    catch { throw Object.assign(Error("gmail_notification_transport_failed"), { code: "gmail_notification_transport_failed" }); }
    if (!response?.ok) throw Object.assign(Error(`gmail_notification_http_${Number(response?.status) || "unknown"}`), { code: `gmail_notification_http_${Number(response?.status) || "unknown"}` });
    return Object.freeze({ sent: true, message_id: (await response.json().catch(() => ({})))?.id || null });
  };
}
