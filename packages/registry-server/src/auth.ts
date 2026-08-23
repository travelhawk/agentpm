import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const TOKEN_PREFIX = 'agpm_';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

// Async so a burst of login attempts cannot serialize scrypt work on the
// single HTTP thread and stall every other request.
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex!, 'hex');
  const derived = (await scryptAsync(password, salt!, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generatePassword(): string {
  return randomBytes(15).toString('base64url');
}
