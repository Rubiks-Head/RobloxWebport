// lib/ws.js — minimal RFC6455 WebSocket server (binary frames only need apply).
// Enough for the udp/tcp relay: handshake, masked frame decode, send/close.
// No fragmentation support beyond reassembling continuation frames — datagrams
// and engine ws payloads are small.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// upgrade(req, socket) -> WebSocketConn | null
function accept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return null;
  const hash = crypto.createHash('sha1').update(key + GUID).digest('base64');
  // the handshake write below can EPIPE asynchronously if the client aborts
  // instantly — an 'error' event with no listener crashes the process, so
  // make sure one exists before the write (WsConn adds its own in a moment)
  socket.on('error', () => {});
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${hash}\r\n\r\n`);
  socket.setNoDelay(true);
  return new WsConn(socket);
}

class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._frags = [];          // continuation reassembly
    this._fragOp = 0;
    socket.on('data', d => this._feed(d));
    socket.on('close', hadError => { this._closeHadError = hadError; this._die(); });
    socket.on('error', e => { this._lastError = e; this._die(); });
  }

  _die() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _feed(data) {
    this._buf = Buffer.concat([this._buf, data]);
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const mlen = masked ? 4 : 0;
      if (b.length < off + mlen + len) return;
      let payload = b.subarray(off + mlen, off + mlen + len);
      if (masked) {
        const mask = b.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this._buf = b.subarray(off + mlen + len);

      if (op === 0x8) { this.close(); return; }            // close
      if (op === 0x9) { this._send(0xA, payload); continue; } // ping -> pong
      if (op === 0xA) continue;                            // pong
      if (op === 0x0 || !fin) {                            // continuation / fragmented
        if (op !== 0x0) this._fragOp = op;
        this._frags.push(payload);
        if (!fin) continue;
        payload = Buffer.concat(this._frags);
        this._frags = [];
        this.emit('message', payload, this._fragOp === 0x1);
        continue;
      }
      this.emit('message', payload, op === 0x1);           // data frame
    }
  }

  _send(op, payload) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch { this._die(); }
  }

  send(data) { this._send(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data)); }
  sendText(s) { this._send(0x1, Buffer.from(String(s), 'utf8')); }
  close() {
    if (this.closed) return;
    try { this._send(0x8, Buffer.alloc(0)); this.socket.end(); } catch {}
    this._die();
  }
}

module.exports = { accept };
