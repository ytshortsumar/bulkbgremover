/* keys.js — client-side serial-key verification.
   Looks up keys/{sha256(key)} in Firestore; only the hash is stored (a leaked
   read exposes no usable key, and the collection can't be listed — see
   firestore.rules). A key binds to the first device that verifies it
   (keys/{hash}.boundDevice); other devices are rejected until an admin resets it.
   Because removal runs in the browser, this is a deterrent, not DRM — accepted
   on purpose to stay private and server-less. */

import { getDb, isConfigured, SDK } from './firebase-config.js';

const DEVICE_STORAGE_KEY = 'bulkbg.device';

/* A stable-ish per-browser device id, persisted in localStorage. Clearing site
   data or switching browsers yields a new id (admin reset is the recovery path). */
export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
           ('dev-' + [...crypto.getRandomValues(new Uint32Array(4))]
             .map((x) => x.toString(16).padStart(8, '0')).join(''));
      localStorage.setItem(DEVICE_STORAGE_KEY, id);
    }
    return id;
  } catch (_) {
    // localStorage blocked (private mode) → ephemeral id, still works this load.
    return 'ephemeral-' + Math.abs(hashStr(navigator.userAgent + screen.width));
  }
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* SHA-256 → lowercase hex via Web Crypto (needs a secure context: https or
   http://localhost — both of which we have). */
export async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Verify a serial key and claim/refresh the device lock. Returns
   { ok, reason?, expiresAt?, transient? }. The active/expiry checks and the
   device claim run in one transaction, so the binding is atomic across devices. */
export async function verifyKey(rawKey) {
  const key = (rawKey || '').trim().toUpperCase();
  if (!key) return { ok: false, reason: 'Please enter your serial key.' };
  if (!isConfigured()) return { ok: false, reason: 'Key checking is not set up yet.' };

  let db, doc, runTransaction, serverTimestamp;
  try {
    db = await getDb();
    ({ doc, runTransaction, serverTimestamp } =
      await import(/* @vite-ignore */ `${SDK}/firebase-firestore.js`));
  } catch (e) {
    console.error('[keys] SDK / init failed', e);
    return { ok: false, transient: true, reason: 'Could not reach the license server. Check your internet.' };
  }

  const myDevice = getDeviceId();

  let hash;
  try {
    hash = await sha256Hex(key);
  } catch (e) {
    console.error('[keys] hash failed', e);
    return { ok: false, transient: true, reason: 'Could not verify right now. Please try again.' };
  }

  try {
    const ref = doc(db, 'keys', hash);
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) return { ok: false, reason: 'This serial key is not valid.' };

      const d = snap.data();
      if (d.active === false) return { ok: false, reason: 'This key has been disabled. Contact support.' };

      // expiresAt may be a Firestore Timestamp (lookup) or null (lifetime).
      const exp = d.expiresAt && typeof d.expiresAt.toMillis === 'function'
        ? d.expiresAt.toMillis()
        : (typeof d.expiresAt === 'number' ? d.expiresAt : null);
      if (exp && Date.now() > exp) {
        return { ok: false, reason: 'This key has expired. Contact support to renew.' };
      }

      // Device lock (permanent single-device binding).
      const bound = d.boundDevice || '';
      if (!bound) {
        // Unbound → claim it for this device.
        tx.update(ref, { boundDevice: myDevice, boundAt: serverTimestamp() });
        return { ok: true, expiresAt: exp };
      }
      if (bound === myDevice) return { ok: true, expiresAt: exp }; // already ours

      return {
        ok: false,
        reason: 'This key is already in use on another device. Contact support to reset it.',
      };
    });
  } catch (e) {
    console.error('[keys] verify/claim failed', e);
    return { ok: false, transient: true, reason: 'Could not verify right now. Please try again.' };
  }
}
