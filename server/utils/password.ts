import argon2 from 'argon2';

/**
 * Hash a plain text password using Argon2id
 * Argon2id combines resistance against side-channel and GPU cracking attacks.
 * Offloaded to libuv thread pool to keep the Node.js event loop responsive.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || password.trim().length === 0) {
    throw new Error('Parola boş olamaz.');
  }

  return await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16, // 64 MB
    timeCost: 3,         // 3 iterations
    parallelism: 1       // 1 thread
  });
}

/**
 * Verify a plain text password against an Argon2id hash
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  if (!hash || !password) return false;
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    return false;
  }
}
