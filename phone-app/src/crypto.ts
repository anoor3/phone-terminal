/**
 * ECDSA P-256 keypair module for phone-terminal.
 *
 * Security model (§2.1, §6.2):
 * - Private key is non-extractable (cannot be read from IndexedDB or JS)
 * - Keypair stored in IndexedDB (supports CryptoKey objects directly)
 * - Generated fresh on each page load / pairing session
 * - No localStorage for security-relevant data
 */

const DB_NAME = 'phone-terminal-keys';
const DB_VERSION = 1;
const STORE_NAME = 'keypair';
const KEY_ID = 'current';

// --- IndexedDB helpers ---

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeKeypair(keypair: CryptoKeyPair): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(keypair, KEY_ID);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

async function loadKeypair(): Promise<CryptoKeyPair | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(KEY_ID);
    request.onsuccess = () => {
      db.close();
      resolve(request.result as CryptoKeyPair | null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
  });
}

// --- Key generation ---

/**
 * Generate a fresh ECDSA P-256 keypair.
 * Private key is non-extractable to prevent exfiltration.
 * Stores the keypair in IndexedDB for the duration of the session.
 */
export async function generateKeypair(): Promise<CryptoKeyPair> {
  const keypair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, // non-extractable private key
    ['sign', 'verify'],
  );
  await storeKeypair(keypair);
  return keypair;
}

/**
 * Load existing keypair from IndexedDB, or null if none exists.
 */
export async function getKeypair(): Promise<CryptoKeyPair | null> {
  return loadKeypair();
}

// --- Public key export ---

/**
 * Export the public key as JWK for sending to the backend during pairing.
 */
export async function exportPublicKeyJWK(
  keypair: CryptoKeyPair,
): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', keypair.publicKey);
}

// --- Signing ---

/**
 * Base64url encode a Uint8Array (no padding).
 */
function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Sign a control message. The canonical message format is:
 *   `${sessionId}|${seq}|${ts}|${type}|${payload}`
 *
 * Returns the signature as a base64url-encoded string.
 */
export async function sign(
  keypair: CryptoKeyPair,
  sessionId: string,
  seq: number,
  ts: number,
  type: string,
  payload: string,
): Promise<string> {
  const message = `${sessionId}|${seq}|${ts}|${type}|${payload}`;
  const encoded = new TextEncoder().encode(message);

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keypair.privateKey,
    encoded,
  );

  return base64urlEncode(new Uint8Array(signature));
}

// --- Cleanup ---

/**
 * Remove the keypair from IndexedDB. Called on session end / disconnect.
 */
export async function clearKeypair(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(KEY_ID);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
