# Wire protocol

Everything the bridge speaks to Roblox, bottom to top. Derived from
`server/quic_bridge.py` and `server/relay.js`, cross-checked against months of
live packet captures of the native desktop client and the official web client.

## Layer 0: RUPP (Roblox UDP Protocol)

Every UDP datagram to/from the UDMux edge is RUPP-wrapped:

```
[01 00][u16be headerLen][TLV...][QUIC packet]
  TLV1 [01 17 <ver><16B token>]   ver=1 join token (NetStackTokenValue)
                                  ver=2 rotated session token (server-assigned)
  TLV2 [02 06 <rccIp 4B><rccPort u16be>]   rcc = MachineAddress + NetStackPort
```

- The subtype-2 field inbound is a rolling per-window tag the edge expects
  reflected back. Stamping the **join token** in subtype-2 gets outbound
  silently dropped (CONNECT ignored → idle-kill ~30s → error 279); a
  3-sighting-guarded tag lags a full window and starves the reliable
  channel ~40s in. Default is `WEBPORT_RUPP_TAG=latest` — echo the freshest
  subtype-2 tag received (`first` locks the initial tag per the issued-token
  grammar, `join` never harvests).
- Wrong/omitted TLV2 → the packet is silently dropped (the udmux routes on
  the netstack channel).
- Dial target is `udmux.Address : NetStackPort` (NOT `UdmuxEndpoints.Port`).

## Layer 1: QUIC

- aioquic `QuicConnection`, `verify_mode=CERT_NONE`, DATAGRAM frames on,
  `idle_timeout=60`.
- **ALPN `h3`** — the browser WT path only accepts HTTP/3 (native
  `RbxTransport` ALPN is desktop-only).
- **SNI** = `{32-hex token}-{8hex rccIp}-{4hex rccPort}.{8hex
  vip}.qdmux.roblox.com` — the grammar the listener parses; without it the
  handshake dies at the crypto phase.
- Keepalive ping 1/s.

## Layer 2: HTTP/3 + WebTransport CONNECT

On handshake-complete, open a client-bidi stream and extended-CONNECT:

```
:method CONNECT  :protocol webtransport  :scheme https
:authority <sni>  :path /wt?X-Rbx-Capabilities=<caps>
origin https://<sni>  sec-webtransport-http3-draft draft02
user-agent Roblox/WinInet
```

- `caps` comes from `NetStackConfig.caps` in the joinScript (percent-decoded
  JSON) — required or the CONNECT is 400.
- `:status 200` = WT session accepted; that CONNECT stream's id (`wt_sid`) is
  the session context for all WT streams/datagrams.

## Layer 3: WT streams — channel model

Every logical channel is a pair of unidirectional QUIC streams
(client→server AND server→client), each starting with a 7-byte preamble:

```
[06 01 <app u8> <chanId u32be>]
```

- `app=4` gameplay channels, `app=6` DummyClient keepalive, `app=0` second
  ctrl.
- chan ids seen: `0,1,2,3,4,5,6,7,8,9,10,11,12,13`, ctrl = `0x6374726c`
  ('ctrl').
- ctrl messages declare channels: type `0x02` `OpenUnreliable`/`OpenReliable`
  carrying `[app][chan u32be][wireId u32be]` — wire ids are allocated per
  session and mapped to datagram channel numbers.

## Layer 4: messages

Inside each channel stream:

```
[cvarint len][type u8][payload (len-1 B)]
```

cvarint = QUIC-style varint (top-2-bit size: `XX`=1B, `40XX`=2B, `80XX`=4B).
Big frames show as `80 00 LL LL`.

### Client → server (chan-1, join sequence)

| type | size | meaning |
|---|---|---|
| `a8` | ~103B | early-auth: `a8 11 21 <33B pre> 42 <66B auth>` (ClientTicket parts 2/3) |
| `a7` | var | script-hash queue: `[a7][u16le count][count×16B]` (empty allowed) |
| `90` | ~12KB | client-info: flags list + LEB JSON (RandomSeed1, APIsecurityToken, joinTicket) |
| `92` | ~11B | nonce: `LEB(zigzag64((v8<<32)\|(v8^0x63E25F26)))` |
| `8a` | ~1.7KB | join request: userid LEB + ClientTicket + xxh32-obfuscated checks + SessionId + `fe ca 01 c0` |
| `8f` | 2B | `8f 00` end-of-join marker |
| `9b` | 9B | challenge answer: `[9b][u2 u32le][answer u32le]` |
| `fa` | ~236B | chan-10 message (post-join, resent periodically) |
| `ba` | var | post-join replication responses/acks (ISR item chain, below) |
| `a6` | var | chan-11 route declarations `a6 01..04 01 00 <chan><size>` |

### `ba` — ISR item chain

`ba` is the Instance State Replicator container: `[ba][type][body]*[00]`.
Every observed message ends in `00` ("End Item", enum 0). Wire type bytes are
an enum→byte translation (`f_ttp`, table @ mem 2997712, decoded from
`WebClient.wasm` and verified against live tx/rx dumps):

| wire | enum | item | shape |
|---|---|---|---|
| `00` | 0 | End Item | terminator |
| `1f` | 2 | New Items | `1f 01 <u32 ref> <record>` |
| `2f` | 3 | Change Property | `2f 04 <u32><u24><u8>` |
| `27` | 4 | Marker | `27 <u32>` (5B acks) |
| `d6`/`e1` | 5/6 | Other 1/2 | flag-sized physics/state records |
| `b1` | 7 | Event Invoke | `b1 01 <u32 ref><u16 member><args>` |
| `4a` | 8 | **Request Character** | `4a <u32 flags><u32 strlen><str><01\|LEB+u32 playerRef>` — client→server only; the `0x83/04` analog. Engine never emits it; injected immediately after each bridge `9b` reply AND each engine `f8` answer (native slot: record directly post-answer, before replication). `NO_BA4A` disables, `NO_BA4A_9B` drops the post-9b copy; `BA4A_FLAGS`/`BA4A_STR`/`BA4A_REF`(`<u32>`\|`peer`\|`0`) override fields for A/B |
| `45` | 9 | Other 3 | |
| `c2` | 10 | CFrame Ack | `c2 01 <u32 ref><u16><u8><u32>` |
| `b7` | 11 | Join Data | |
| `8e` | 12 | Delete Pure Object | |
| `3e` | 13 | Stream Data | `3e <u32><u8>` |
| `7d` | 14 | Region Removal | |
| `db` | 15 | Instance Removal | |
| `2d` | 16 | Tag | `2d 0c <u32>` |
| `7a` | 17 | Stats | |
| `14` | 18 | Other 4 | |
| `0c` | 19 | Resolve Atomic Tree | |
| `2b` | 20 | Stream Info | `2b 00 fe00 02 02 <u32><u16>` |
| `05` | 21 | Change Attribute | |
| `16` | 22 | Join Data V2 | `16 01 <u8><16B>` |
| `34` | 23 | Stream Terrain | |
| `1e`/`56`/`13` | 24/25/26 | Prefetch/Focus | |
| `7e` | 27 | Destroy | `7e <u8 grp><u32><u32>` |
| `75` | 28 | Client Quota Stream Update | `75 00 <u32><u16>` |
| `44`/`35` | 29/30 | Persistent Player Add/Remove | |
| `24` | 31 | Client QoS | |
| `2e`/`be` | 32/33 | Change Inst/ObjProp | |
| `9a` | 34 | Deferred SharedString | |
| `6e` | 35 | ISR Timestamp | `6e <u32>` (5B clock) |
| `4c`/`4f` | 36/37 | Focus Remove/Pin Data | |
| `fc` | 1 | Delete Items | `fc 04 <u32be>` |
| `c7`/`6a`/`17` | 41/42/43 | Inst Intent/Excl Inst/Terrain LOD | |

Wire byte `0x04` is **not** an item type — injecting `ba 04` makes the server
decoder hit "Item type unknown" and drop the session.

### Server → client (chan-1 unless noted)

| type | size | meaning |
|---|---|---|
| `02` | 10B | ctrl OpenUnreliable app/chan/wire declarations (ctrl streams) |
| `93` | ~1.9KB | flag-override (FEAT-string JSON — `...AnimGraphSerPlayerScr...`) |
| `f8` | ~1.9KB | anti-cheat challenge `[f8][u1][u2][u32 len][blob]` — see challenge.md |
| `81` | 528B | peer assignment (arrives with post-answer traffic) |
| `c4` | 32B | post-join control frame |
| `eb` | 5B | post-join marker `eb eb 00 00 00` |
| `ba` | 7B–5.4KB | reliable replication stream messages (instance updates, "Touch","Cam","Att","Game" strings visible) |
| `96`/`97` | KBs | zstd replication frames (`[97][50 d3][00 00][u32 decomp][zstd]`) |
| `05 xx` | 32B+ | chan-5 unreliable datagrams (WT datagrams, not streams) |

### Direction notes

- Client→server frames: small → 1–2B cvarints (`09`, `4x xx`, `80 00…`).
- Server→client: messages chunk arbitrarily across QUIC stream deliveries —
  never assume a chunk starts on a frame boundary (that's what `_RxFrames`
  and the `_sbuf` resync loop exist for).

---
*This document was written 100% by an AI model, based on roughly 4 months of
work, ~20 GB of captured data, and a map of all the context used during
decompilation and debugging.

If anything seems wrong or doesn't connect to the code, the doc was written
wrong — these docs weren't made perfect because they weren't strictly
required. If you spot an issue and have some time on your hands, please open
an issue for it!*
