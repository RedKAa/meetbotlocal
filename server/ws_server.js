// ws_server.js
// A tiny WebSocket server to log messages coming from your Meet payload.
// Usage:
//   npm i ws
//   node ws_server.js --port 8765 --outfile ws_log.jsonl
//
// The payload typically sends a 4-byte little-endian message type header:
//   1 = JSON (UTF-8)  -> we'll parse and pretty-print
//   other/unknown     -> we'll dump as hex/base64 for inspection
//
// Tips:
// - Set window.initialData.websocketPort in your injected script to match --port
// - You can run multiple instances on different ports if needed

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// -------- CLI args --------
function parseArgs(argv) {
  const args = { port: 8765, outfile: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i+1]) { args.port = Number(argv[++i]); continue; }
    if ((a === '--outfile' || a === '--out') && argv[i+1]) { args.outfile = argv[++i]; continue; }
    if (a === '--quiet' || a === '-q') { args.quiet = true; continue; }
    if (a === '--help' || a === '-h') {
      console.log(`
Usage: node ws_server.js [--port 8765] [--outfile ws_log.jsonl] [--quiet]

Examples:
  node ws_server.js --port 8765
  node ws_server.js --port 9001 --outfile meet_events.jsonl
`);
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

// -------- Logging helpers --------
function ts() {
  return new Date().toISOString();
}

function log(...xs) {
  if (!args.quiet) console.log(...xs);
}

function appendOutFile(line) {
  if (!args.outfile) return;
  try {
    fs.appendFileSync(args.outfile, line + '\n');
  } catch (e) {
    console.error('[ERR] write outfile:', e.message);
  }
}

function hexPreview(buf, max = 64) {
  const view = buf.subarray(0, Math.min(buf.length, max));
  return Array.from(view, b => b.toString(16).padStart(2, '0')).join(' ') +
         (buf.length > max ? ` ... (+${buf.length - max} bytes)` : '');
}

// -------- Message decoding --------
function handleBinaryMessage(buf, ctx) {
  if (buf.length >= 4) {
    const type = buf.readInt32LE(0);
    const body = buf.subarray(4);
    if (type === 1) {
      // JSON frame
      try {
        const text = body.toString('utf8');
        const json = JSON.parse(text);
        prettyPrintJson(json, ctx);
        appendOutFile(JSON.stringify({ t: ts(), ...json }));
        return;
      } catch (e) {
        log(`[${ts()}] [${ctx.id}] JSON parse error: ${e.message}`);
        log(`[${ts()}] [${ctx.id}] body preview:`, hexPreview(body));
      }
    } else {
      log(`[${ts()}] [${ctx.id}] Binary frame type=${type}, bytes=${body.length}`);
      log(hexPreview(body));
      appendOutFile(JSON.stringify({ t: ts(), _type: 'binary', mtype: type, data_b64: body.toString('base64') }));
    }
  } else {
    log(`[${ts()}] [${ctx.id}] Short binary message (${buf.length} bytes):`, hexPreview(buf));
    appendOutFile(JSON.stringify({ t: ts(), _type: 'binary_short', data_b64: buf.toString('base64') }));
  }
}

function prettyPrintJson(obj, ctx) {
  const kind = obj && obj.type || 'JSON';
  if (kind === 'UsersUpdate') {
    const nNew = obj.newUsers?.length || 0;
    const nUpd = obj.updatedUsers?.length || 0;
    const nRem = obj.removedUsers?.length || 0;
    log(`[${ts()}] [${ctx.id}] UsersUpdate  +${nNew}  ~${nUpd}  -${nRem}`);
    if (nNew) {
      const names = obj.newUsers.map(u => u.displayName || u.fullName || u.deviceId).join(', ');
      log(`  new: ${names}`);
    }
    if (nRem) {
      const ids = obj.removedUsers.map(u => u.deviceId || u.id || '?').join(', ');
      log(`  removed: ${ids}`);
    }
  } else if (kind === 'DeviceOutputsUpdate') {
    const n = obj.deviceOutputs?.length || 0;
    log(`[${ts()}] [${ctx.id}] DeviceOutputsUpdate  items=${n}`);
    if (n) {
      const head = obj.deviceOutputs.slice(0, 3).map(o => `${o.deviceId}:${o.outputType}:${o.disabled?'off':'on'}`).join('  ');
      log(`  sample: ${head}${n>3?'  ...':''}`);
    }
  } else {
    log(`[${ts()}] [${ctx.id}] JSON:`, JSON.stringify(obj));
  }
}

// -------- Server --------
const wss = new WebSocketServer({ port: args.port });

wss.on('listening', () => {
  log(`[INFO] Listening on ws://127.0.0.1:${args.port}`);
  if (args.outfile) log(`[INFO] Appending JSON to ${path.resolve(args.outfile)}`);
});

let nextId = 1;

wss.on('connection', (ws, req) => {
  const id = nextId++;
  const ctx = { id };
  const ip = req.socket?.remoteAddress || 'unknown';
  log(`[${ts()}] [${id}] Connected from ${ip}`);

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary || Buffer.isBuffer(data)) {
        handleBinaryMessage(Buffer.from(data), ctx);
      } else {
        // plain text (rare, but handle it)
        const text = data.toString();
        try {
          const json = JSON.parse(text);
          prettyPrintJson(json, ctx);
          appendOutFile(JSON.stringify({ t: ts(), ...json }));
        } catch {
          log(`[${ts()}] [${id}] Text: ${text}`);
          appendOutFile(JSON.stringify({ t: ts(), _type: 'text', data: text }));
        }
      }
    } catch (e) {
      console.error(`[${ts()}] [${id}] message error:`, e.stack || e.message);
    }
  });

  ws.on('close', (code, reason) => {
    log(`[${ts()}] [${id}] Closed code=${code} reason=${reason}`);
  });

  ws.on('error', (err) => {
    console.error(`[${ts()}] [${id}] Socket error:`, err.message);
  });
});

wss.on('error', (err) => {
  console.error('[SERVER ERROR]', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error('Port in use. Try: node ws_server.js --port 9001');
  }
});
