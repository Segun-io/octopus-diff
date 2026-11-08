/**
 * Small deterministic helpers for the mock backend (dev/test only, never shipped).
 */

/** FNV-1a 32-bit with a configurable seed/multiplier. */
export function fnv1a32(input: string, seed = 0x811c9dc5, multiplier = 0x01000193): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, '0');
}

/** 16 lowercase hex chars (matches the contract's IdSchema). */
export function hash16(input: string): string {
  return hex8(fnv1a32(input)) + hex8(fnv1a32(input, 0x9e3779b9, 0x85ebca6b));
}

/** 40 hex chars, shaped like a git object id. */
export function hash40(input: string): string {
  let out = '';
  for (let i = 0; i < 5; i++) out += hex8(fnv1a32(`${i}:${input}`, 0x811c9dc5 + i * 7919));
  return out;
}

/** Mulberry32 PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

export function intBetween(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/** UTF-8 byte length without Node built-ins. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** base64 of raw bytes (for `rawPath`). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const BASE_TIME = Date.parse('2026-11-08T09:00:00.000Z');

/** Deterministic, monotonically increasing ISO timestamps. */
export function makeClock(startOffsetMs = 0): () => string {
  let tick = 0;
  return () => new Date(BASE_TIME + startOffsetMs + tick++ * 1000).toISOString();
}

export function isoAt(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}
