const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameDecoder } = require('../relay');

function encode(frame) {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(frame.length);
  return Buffer.concat([header, frame]);
}

test('decodes frames split across arbitrary pipe chunks', () => {
  const decoder = new FrameDecoder();
  const wire = encode(Buffer.from([0, 1, 2, 3, 4]));
  const frames = [];
  for (let i = 0; i < wire.length; i++) frames.push(...decoder.push(wire.subarray(i, i + 1)));
  assert.deepEqual(frames, [Buffer.from([0, 1, 2, 3, 4])]);
  assert.equal(decoder.buffered, 0);
});

test('decodes coalesced frames and an empty frame in order', () => {
  const decoder = new FrameDecoder();
  const wire = Buffer.concat([
    encode(Buffer.from('first')),
    encode(Buffer.alloc(0)),
    encode(Buffer.from('third')),
  ]);
  assert.deepEqual(decoder.push(wire), [
    Buffer.from('first'), Buffer.alloc(0), Buffer.from('third'),
  ]);
  assert.equal(decoder.buffered, 0);
});

test('rejects an oversized frame length', () => {
  const decoder = new FrameDecoder(8);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(9);
  assert.throws(() => decoder.push(header), /invalid bridge frame length 9/);
});
