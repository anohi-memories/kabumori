import * as Crypto from 'expo-crypto';
import type { Sha256 } from '@/domain/reservation-flow';

/** SHA-256 (hex, UTF-8) of a post's text, for binding a confirmation to the exact text. Local only. */
export const sha256Hex: Sha256 = (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text);
