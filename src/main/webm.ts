// Reads the Opus packets out of a WebM file the recorder wrote (Chromium's MediaRecorder), so the hidden decoder
// page can decode them a batch at a time (WebCodecs) instead of the whole call at once.
// Only what that file needs: EBML header, Segment / Cluster of unknown size (live recording), TimecodeScale,
// the track's CodecPrivate (OpusHead), sampling rate, channels, SimpleBlock / Block without lacing.
// A file cut off by a crash (R6) gives the packets before the cut.
// Pure TypeScript: no Electron, no Node APIs.

export interface OpusPacket {
  /** Presentation time in microseconds. */
  timestampUs: number;
  data: Uint8Array;
}

export interface OpusTrack {
  /** The OpusHead (decoder configuration). */
  codecPrivate: Uint8Array | null;
  sampleRate: number;
  channels: number;
  packets: OpusPacket[];
}

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

/** Containers whose children we read in place (their size may be "unknown" in a live recording). */
const DESCEND = new Set<number>([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster, ID.BlockGroup]);

class Truncated extends Error {}

function vintLength(first: number): number {
  for (let len = 1; len <= 8; len++) if (first & (0x80 >> (len - 1))) return len;
  throw new Error("Not a WebM file (bad element header)");
}

/** An element id (marker bits kept). */
function readId(b: Uint8Array, pos: number): { id: number; next: number } {
  if (pos >= b.length) throw new Truncated();
  const len = vintLength(b[pos]);
  if (len > 4) throw new Error("Not a WebM file (bad element id)");
  if (pos + len > b.length) throw new Truncated();
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
  return { id, next: pos + len };
}

/** An element size (marker removed); null = unknown size. */
function readSize(b: Uint8Array, pos: number): { size: number | null; next: number } {
  if (pos >= b.length) throw new Truncated();
  const len = vintLength(b[pos]);
  if (pos + len > b.length) throw new Truncated();
  let value = b[pos] & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? null : value, next: pos + len };
}

function readUint(b: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + b[i];
  return v;
}

function readFloat(b: Uint8Array, start: number, end: number): number {
  const view = new DataView(b.buffer, b.byteOffset + start, end - start);
  if (end - start === 4) return view.getFloat32(0);
  if (end - start === 8) return view.getFloat64(0);
  return 0;
}

export function demuxWebmOpus(bytes: Uint8Array): OpusTrack {
  const track: OpusTrack = { codecPrivate: null, sampleRate: 48000, channels: 1, packets: [] };
  let timecodeScale = 1_000_000;
  let clusterTimecode = 0;
  let sawHeader = false;
  let entry: { number: number | null; codec: string | null; priv: Uint8Array | null; rate: number | null; channels: number | null } | null = null;
  const found: { track: number | null } = { track: null };

  const finishEntry = () => {
    if (entry && found.track === null && entry.codec === "A_OPUS") {
      found.track = entry.number ?? 1;
      track.codecPrivate = entry.priv;
      if (entry.rate) track.sampleRate = Math.round(entry.rate);
      if (entry.channels) track.channels = entry.channels;
    }
    entry = null;
  };

  let pos = 0;
  try {
    while (pos < bytes.length) {
      const { id, next: afterId } = readId(bytes, pos);
      const { size, next: dataStart } = readSize(bytes, afterId);
      if (!sawHeader) {
        if (id !== ID.EBML) throw new Error("Not a WebM file");
        sawHeader = true;
      }
      if (DESCEND.has(id)) {
        if (id === ID.TrackEntry) {
          finishEntry();
          entry = { number: null, codec: null, priv: null, rate: null, channels: null };
        }
        if (id === ID.Cluster) finishEntry();
        pos = dataStart;
        continue;
      }
      if (size === null) throw new Error("Not a WebM file (unknown size)");
      const dataEnd = dataStart + size;
      if (dataEnd > bytes.length) throw new Truncated();

      switch (id) {
        case ID.TimecodeScale:
          timecodeScale = readUint(bytes, dataStart, dataEnd) || 1_000_000;
          break;
        case ID.TrackNumber:
          if (entry) entry.number = readUint(bytes, dataStart, dataEnd);
          break;
        case ID.CodecID:
          if (entry) entry.codec = new TextDecoder().decode(bytes.subarray(dataStart, dataEnd)).replace(/\0+$/, "");
          break;
        case ID.CodecPrivate:
          if (entry) entry.priv = bytes.slice(dataStart, dataEnd);
          break;
        case ID.SamplingFrequency:
          if (entry) entry.rate = readFloat(bytes, dataStart, dataEnd);
          break;
        case ID.Channels:
          if (entry) entry.channels = readUint(bytes, dataStart, dataEnd);
          break;
        case ID.Timecode:
          clusterTimecode = readUint(bytes, dataStart, dataEnd);
          break;
        case ID.SimpleBlock:
        case ID.Block: {
          finishEntry();
          const t = readSize(bytes, dataStart); // the track number is coded like a size
          if (t.next + 3 > dataEnd) break;
          if (found.track !== null && t.size !== found.track) break;
          let rel = (bytes[t.next] << 8) | bytes[t.next + 1];
          if (rel & 0x8000) rel -= 0x10000;
          const flags = bytes[t.next + 2];
          if ((flags >> 1) & 0x03) throw new Error("Laced WebM blocks are not supported");
          track.packets.push({
            timestampUs: Math.round(((clusterTimecode + rel) * timecodeScale) / 1000),
            data: bytes.slice(t.next + 3, dataEnd),
          });
          break;
        }
        default:
          break; // EBML header, Cues, SeekHead, Tags, Void…: skipped
      }
      pos = dataEnd;
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
  }
  finishEntry();
  if (!sawHeader) throw new Error("Not a WebM file");
  if (found.track === null) throw new Error("No Opus audio track in this file");
  return track;
}
