// lib/session.js — per-session game endpoint state.
// The gamejoin/matchmaking transforms call capture() with each join response
// so the rest of the server (GET /udmux, the UDP relay, the WT front) can
// reach the same game server the client was assigned to. index.js keeps one
// of these per /pg/<sid>/ session, plus the shared default below.

function createSession() {
  let last = null;
  let lastJoinScript = null;

  // the full joinScript object (token fields intact) — the socket pump needs
  // NetStackTokenValue/TokenValue for the RUPP codec, which stripRbx removes
  // from the client-facing response, so we stash a pristine copy server-side.
  function setJoinScript(js) { lastJoinScript = js; }

  // pull the interesting fields out of a joinScript-shaped object
  function capture(joinScript) {
    if (!joinScript || typeof joinScript !== 'object') return;
    const ud = Array.isArray(joinScript.UdmuxEndpoints) ? joinScript.UdmuxEndpoints[0] : null;
    const conn = Array.isArray(joinScript.ServerConnections) ? joinScript.ServerConnections[0] : null;
    last = {
      at: Date.now(),
      placeId: joinScript.PlaceId,
      joinScript,
      jobId: joinScript.GameId || joinScript.SessionId,
      // the engine's datagram destination (UDMux tunnel) and the RCC behind it
      udmux: ud && ud.Address ? { ip: ud.Address, port: ud.Port } : null,
      machine: joinScript.MachineAddress ? { ip: joinScript.MachineAddress, port: joinScript.NetStackPort } : null,
      server: conn && conn.Address ? { ip: conn.Address, port: conn.Port || joinScript.ServerPort } : null,
    };
    console.log(`[session] captured join: place=${last.placeId} udmux=${last.udmux ? last.udmux.ip + ':' + last.udmux.port : 'none'} rcc=${last.server ? last.server.ip + ':' + last.server.port : 'none'}`);
  }

  // best-guess datagram target: UDMux first, then the raw server connection
  function datagramTarget() {
    if (!last) return null;
    return last.udmux || last.server || last.machine || null;
  }

  return { capture, datagramTarget, last: () => last, setJoinScript, joinScript: () => lastJoinScript };
}

module.exports = { createSession, ...createSession() };
