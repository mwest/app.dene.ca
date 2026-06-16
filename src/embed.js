// Local sentence embeddings for semantic search over the English side.
// Runs entirely on-device (transformers.js + onnxruntime-node) — the text
// never leaves the server. Weights download once to data/models (the Fly
// volume) and persist across deploys.
import { pipeline, env } from '@huggingface/transformers';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
// Weights are baked into the image at build time (Dockerfile runs
// scripts/fetch-model.mjs into ./models), so production loads them from local
// disk and never reaches the network — no runtime download to stall on. Outside
// production (local dev, the build step) the one-time download is allowed.
env.cacheDir = path.join(ROOT, 'models');
env.allowRemoteModels = process.env.NODE_ENV !== 'production';

export const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DIM = 384;

let pipePromise = null;
const getPipe = () => (pipePromise ??= pipeline('feature-extraction', MODEL));

/** Embed text → normalized Float32Array of length DIM (cosine == dot product). */
export async function embed(text) {
  const pipe = await getPipe();
  const out = await pipe(String(text ?? ''), { pooling: 'mean', normalize: true });
  return Float32Array.from(out.data);
}

/** Float32Array ↔ SQLite BLOB. fromBlob copies so the Float32Array is aligned. */
export const toBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
export const fromBlob = (buf) =>
  new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/** Cosine similarity of two normalized vectors. */
export function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
