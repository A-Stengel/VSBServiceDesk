// Microsoft Graph, signed in as the Function App's managed identity (on your
// machine, whoever is signed in to the Azure CLI). It needs the application
// permissions Mail.Read, Mail.Send and Calendars.ReadWrite, limited to the
// desk's mailboxes with an Exchange "RBAC for Applications" scope (README).
const { DefaultAzureCredential } = require("@azure/identity");

const GRAPH = "https://graph.microsoft.com/v1.0";
let credential;

async function token() {
  if (!credential) {
    credential = new DefaultAzureCredential(process.env.AZURE_CLIENT_ID ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID } : {});
  }
  return (await credential.getToken("https://graph.microsoft.com/.default")).token;
}

class GraphError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls Graph and returns the JSON answer (or the raw bytes with raw: true).
// A busy answer (429 or 503) is tried again once, after the wait Graph asks
// for. "path" is either a path under /v1.0 or a full URL (for paging).
async function graph(method, path, body, { raw = false, headers = {} } = {}) {
  const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        ...(body !== undefined && !Buffer.isBuffer(body) ? { "Content-Type": "application/json" } : {}),
        ...headers
      },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
    });
    if ((response.status === 429 || response.status === 503) && attempt === 1) {
      const seconds = Math.min(Number(response.headers.get("retry-after")) || 5, 30);
      await wait(seconds * 1000);
      continue;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = text;
      try {
        message = JSON.parse(text).error?.message || text;
      } catch {
        // not JSON
      }
      throw new GraphError(response.status, `Microsoft Graph ${method} ${path.split("?")[0]} failed (${response.status}): ${String(message).slice(0, 300)}`);
    }
    if (raw) return Buffer.from(await response.arrayBuffer());
    if (response.status === 202 || response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

// A file upload to a Graph upload session (attachments over 3 MB), in 4 MB
// pieces. The upload URL carries its own sign-in, so no token goes with it.
async function uploadInPieces(uploadUrl, buffer) {
  const size = buffer.length;
  const piece = 4 * 320 * 1024 * 3; // a multiple of 320 KB, as Graph asks
  for (let start = 0; start < size; start += piece) {
    const end = Math.min(start + piece, size);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${size}` },
      body: buffer.subarray(start, end)
    });
    if (!response.ok) throw new GraphError(response.status, `Uploading an attachment failed (${response.status})`);
  }
}

module.exports = { graph, uploadInPieces, GraphError };
