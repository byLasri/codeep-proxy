// DeepSeek Web Protocol PoW
// Complete PoW implementation — isolated from application layer

import { DEEPSEEK } from "./constants.js";
import type { DeepSeekPowChallenge, DeepSeekPowSolution } from "./types.js";
import { DeepSeekProtocolError, toDeepSeekError } from "./errors.js";

const ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const CONSTANTS = [
  1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];

export function solvePow(challenge: DeepSeekPowChallenge): DeepSeekPowSolution {
  if (challenge.algorithm !== DEEPSEEK.POW.ALGORITHM) {
    throw new DeepSeekProtocolError(
      `Unsupported PoW algorithm: ${challenge.algorithm}`,
      { kind: "pow", code: "UNSUPPORTED_ALGORITHM", raw: { algorithm: challenge.algorithm } }
    );
  }

  if (!Number.isSafeInteger(challenge.difficulty) || challenge.difficulty <= 0) {
    throw new DeepSeekProtocolError(
      "Invalid PoW difficulty",
      { kind: "pow", code: "INVALID_DIFFICULTY", raw: { difficulty: challenge.difficulty } }
    );
  }

  const prefix = `${challenge.salt}_${challenge.expire_at}_`;

  for (let answer = 0; answer < challenge.difficulty; answer += 1) {
    if (hash(`${prefix}${answer}`) === challenge.challenge) {
      return { ...challenge, answer };
    }
  }

  throw new DeepSeekProtocolError(
    "Unable to solve PoW challenge",
    { kind: "pow", code: "SOLUTION_NOT_FOUND", raw: { difficulty: challenge.difficulty } }
  );
}

function hash(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const state = new Uint32Array(50);
  const rhoPi = new Uint32Array(50);
  const parity = new Uint32Array(10);
  const theta = new Uint32Array(10);

  for (let offset = 0; offset < bytes.length; offset += 136) {
    const remaining = Math.min(136, bytes.length - offset);
    for (let index = 0; index < remaining; index += 1) {
      state[index >>> 2] ^= bytes[offset + index] << ((index & 3) * 8);
    }
    if (remaining < 136) {
      state[remaining >>> 2] ^= 0x06 << ((remaining & 3) * 8);
      state[33] ^= 0x80000000;
    } else {
      keccakP(state, rhoPi, parity, theta);
    }
  }

  if (bytes.length === 0 || bytes.length % 136 === 0) {
    state[0] ^= 0x06;
    state[33] ^= 0x80000000;
    keccakP(state, rhoPi, parity, theta);
  } else {
    keccakP(state, rhoPi, parity, theta);
  }

  return Array.from({ length: 32 }, (_, index) =>
    ((state[index >>> 2] >>> ((index & 3) * 8)) & 0xff).toString(16).padStart(2, "0")
  ).join("");
}

function keccakP(
  state: Uint32Array,
  rhoPi: Uint32Array,
  parity: Uint32Array,
  theta: Uint32Array,
): void {
  for (let round = 1; round < 24; round += 1) {
    for (let x = 0; x < 5; x += 1) {
      const word = 2 * x;
      parity[word] =
        state[word] ^
        state[word + 10] ^
        state[word + 20] ^
        state[word + 30] ^
        state[word + 40];
      parity[word + 1] =
        state[word + 1] ^
        state[word + 11] ^
        state[word + 21] ^
        state[word + 31] ^
        state[word + 41];
    }
    for (let x = 0; x < 5; x += 1) {
      const previous = 2 * ((x + 4) % 5);
      const next = 2 * ((x + 1) % 5);
      theta[2 * x] = parity[previous] ^ ((parity[next] << 1) | (parity[next + 1] >>> 31));
      theta[2 * x + 1] = parity[previous + 1] ^ ((parity[next + 1] << 1) | (parity[next] >>> 31));
    }
    for (let x = 0; x < 5; x += 1) {
      const word = 2 * x;
      for (let lane = word; lane < 50; lane += 10) {
        state[lane] ^= theta[word];
        state[lane + 1] ^= theta[word + 1];
      }
    }
    rhoPi[0] = state[0];
    rhoPi[1] = state[1];
    for (let lane = 1; lane < 25; lane += 1) {
      const source = 2 * lane;
      const destination = 2 * (Math.floor(lane / 5) + 5 * ((2 * (lane % 5) + 3 * Math.floor(lane / 5)) % 5));
      const amount = ROTATIONS[lane];
      const low = state[source];
      const high = state[source + 1];
      if (amount < 32) {
        rhoPi[destination] = (low << amount) | (high >>> (32 - amount));
        rhoPi[destination + 1] = (high << amount) | (low >>> (32 - amount));
      } else {
        const reduced = amount - 32;
        rhoPi[destination] = (high << reduced) | (low >>> (32 - reduced));
        rhoPi[destination + 1] = (low << reduced) | (high >>> (32 - reduced));
      }
    }
    for (let lane = 0; lane < 25; lane += 1) {
      const word = 2 * lane;
      const row = lane - (lane % 5);
      const x = lane % 5;
      const next = 2 * (row + ((x + 1) % 5));
      const nextNext = 2 * (row + ((x + 2) % 5));
      state[word] = rhoPi[word] ^ (~rhoPi[next] & rhoPi[nextNext]);
      state[word + 1] = rhoPi[word + 1] ^ (~rhoPi[next + 1] & rhoPi[nextNext + 1]);
    }
    state[0] ^= Number(CONSTANTS[round] & 0xffffffffn);
    state[1] ^= Number((CONSTANTS[round] >> 32n) & 0xffffffffn);
  }
}

export function encodePowResponse(solution: DeepSeekPowSolution): string {
  return btoa(JSON.stringify(solution));
}