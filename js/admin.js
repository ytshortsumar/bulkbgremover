/* admin.js — admin panel for issuing serial keys. Login uses Firebase Email/
   Password Auth; only accounts in admins/{uid} can read users or write keys
   (enforced by firestore.rules). Keys are stored as keys/{sha256(rawKey)}; the
   raw key is shown once and kept only in the admin-only users/ collection. */

import { getDb, getAuthInstance, isConfigured, SDK } from './firebase-config.js';
import { sha256Hex } from './keys.js';
import { computeExpiry, resolveDuration, DURATIONS } from './duration.js';

const $ = (s) => document.querySelector(s);

/* Crypto-random serial key: BULK-XXXX-XXXX-XXXX (no ambiguous chars). */
function randomKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
  const r = new Uint32Array(12);
  crypto.getRandomValues(r);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[r[i] % alphabet.length];
  return `BULK-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/* Crypto-random unique user id: USR-XXXXXXXXXX. */
function randomUserId() {
  const r = new Uint32Array(4);
  crypto.getRandomValues(r);
  const hex = [...r].map((x) => x.toString(16).padStart(8, '0')).join('');
  return 'USR-' + hex.slice(0, 10).toUpperCase();
}

function fmtDate(ts) {
  if (!ts) return 'Lifetime';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/* Milliseconds for a Firestore Timestamp | Date | number | null. */
function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  return null;
}

/* Whole days from now until `ts` (negative if already past). null = lifetime. */
function daysUntil(ts) {
  const ms = toMillis(ts);
  if (ms == null) return null;
  return Math.ceil((ms - Date.now()) / 86400000);
}

/* Human relative expiry: "Lifetime" | "in 3 days" | "today" | "Expired 5 days ago". */
function fmtExpiryRelative(ts) {
  const d = daysUntil(ts);
  if (d == null) return 'Lifetime';
  if (d > 1) return `in ${d} days`;
  if (d === 1) return 'in 1 day';
  if (d === 0) return 'today';
  const past = -d;
  return past === 1 ? 'Expired 1 day ago' : `Expired ${past} days ago`;
}

/* Prefilled hand-off message for a customer (self-contained: app URL + how-to). */
function keyMessage({ name, key, expiryText }) {
  const url = location.origin + '/';
  const hi = name ? `Hello ${name},` : 'Hello,';
  const valid = expiryText && expiryText !== 'Lifetime'
    ? `Valid until ${expiryText}.`
    : 'This is a lifetime key (never expires).';
  return (
`${hi}

Here is your BulkBGRemover serial key:

${key}

${valid}

How to use:
1. Open ${url}
2. Add your photos and click "Remove backgrounds".
3. To download 2 or more photos, paste this key to unlock.

Note: the key locks to the FIRST device + browser it is used on. Please don't clear your browser data for this site, and don't use private/incognito mode — that can unbind the key and you'd need a reset. Contact me any time if you need it reset.`
  );
}

/* wa.me link. Phone optional; digits only (wa.me rejects +, spaces, dashes).
   Normalizes common Pakistani formats to international (0332…→92332…, bare
   332…→92332…); an existing 92… or other country code is left untouched. */
function waLink(phone, text) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = '92' + digits.slice(1);
  else if (/^3\d{9}$/.test(digits)) digits = '92' + digits;
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(text)}`;
}

/* mailto: link with prefilled subject + body. */
function mailtoLink(subject, body) {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function showError(el, msg) {
  el.textContent = msg;
  el.hidden = !msg;
}

/* ------------------------------------------------------------ */

if (!isConfigured()) {
  $('#configWarning').hidden = false;
} else {
  init().catch((e) => {
    console.error('[admin] init failed', e);
    $('#configWarning').hidden = false;
    $('#configWarning').querySelector('p').textContent =
      'Could not start Firebase. Check your config in js/firebase-config.js and your internet connection.';
  });
}

async function init() {
  const db = await getDb();
  const auth = await getAuthInstance();
  const authMod = await import(/* @vite-ignore */ `${SDK}/firebase-auth.js`);
  const fs = await import(/* @vite-ignore */ `${SDK}/firebase-firestore.js`);
  const { onAuthStateChanged, signInWithEmailAndPassword, signOut } = authMod;
  const { doc, getDoc, writeBatch, collection, getDocs, serverTimestamp, Timestamp } = fs;

  const loginView = $('#loginView');
  const toolsView = $('#toolsView');
  const loginError = $('#loginError');
  const genError = $('#genError');

  // --- Login ---
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(loginError, '');
    const btn = $('#loginBtn');
    btn.disabled = true;
    try {
      await signInWithEmailAndPassword(auth, $('#adminEmail').value.trim(), $('#adminPass').value);
      // onAuthStateChanged handles the view switch.
    } catch (err) {
      showError(loginError, friendlyAuthError(err));
    } finally {
      btn.disabled = false;
    }
  });

  $('#signOutBtn').addEventListener('click', () => signOut(auth));

  // --- Auth state → which view + admin check ---
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      toolsView.hidden = true;
      loginView.hidden = false;
      return;
    }
    // Confirm this account is on the admin allow-list (admins/{uid}).
    let isAdmin = false;
    try {
      const snap = await getDoc(doc(db, 'admins', user.uid));
      isAdmin = snap.exists();
    } catch (_) {
      isAdmin = false; // rules deny the read for non-admins → treat as not admin
    }
    if (!isAdmin) {
      showError(loginError, 'This account is not authorized as an admin.');
      await signOut(auth);
      return;
    }
    loginView.hidden = true;
    toolsView.hidden = false;
    $('#whoami').textContent = user.email || user.uid;
    loadKeys();
  });

  // --- Generate a key ---
  // Show the "days" input only when Custom duration is picked.
  const genDuration = $('#genDuration');
  const genDaysField = $('#genDaysField');
  const syncDaysField = () => { if (genDaysField) genDaysField.hidden = genDuration.value !== 'custom'; };
  genDuration.addEventListener('change', syncDaysField);
  syncDaysField();

  $('#genForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError(genError, '');
    const name = $('#genName').value.trim();
    const phone = $('#genPhone').value.trim();
    const durKey = genDuration.value;
    if (!name) { showError(genError, 'Please enter the user\'s name.'); return; }

    const dur = resolveDuration(durKey, $('#genDays') ? $('#genDays').value : '');
    if (!dur) { showError(genError, 'Enter a valid number of days (1 or more).'); return; }

    const btn = $('#genBtn');
    btn.disabled = true;
    try {
      const rawKey = randomKey();
      const userId = randomUserId();
      const hash = await sha256Hex(rawKey);

      const expDate = computeExpiry(dur);
      const expiresAt = expDate ? Timestamp.fromDate(expDate) : null;

      // Write the key doc + the admin-only user doc (PII + raw key) in one
      // atomic batch. boundDevice starts empty so the first device can claim it.
      const batch = writeBatch(db);
      batch.set(doc(db, 'keys', hash), {
        active: true,
        expiresAt,
        durationLabel: dur.label,
        userId,
        boundDevice: '',
        boundAt: null,
        createdAt: serverTimestamp(),
      });
      batch.set(doc(db, 'users', userId), {
        name, phone,
        keyHash: hash,
        serialKey: rawKey,          // raw key kept here (users/ is admin-only)
        durationLabel: dur.label,
        expiresAt,
        active: true,
        createdAt: serverTimestamp(),
      });
      await batch.commit();

      $('#outKey').textContent = rawKey;
      $('#outUserId').textContent = userId;
      const expiryText = expiresAt ? fmtDate(expiresAt) : 'Lifetime';
      $('#outExpiry').textContent = expiresAt ? fmtDate(expiresAt) : 'Never (lifetime)';
      // Prefilled hand-off links so the owner can send the key in one tap.
      const msg = keyMessage({ name, key: rawKey, expiryText });
      const waEl = $('#sendWhatsapp');
      if (waEl) waEl.href = waLink(phone, msg);
      const mailEl = $('#sendEmail');
      if (mailEl) mailEl.href = mailtoLink('Your BulkBGRemover serial key', msg);
      $('#keyResult').hidden = false;
      $('#genForm').reset();
      syncDaysField();
      loadKeys();
    } catch (err) {
      console.error('[admin] generate failed', err);
      showError(genError, 'Could not save the key. Check your rules/permissions and try again.');
    } finally {
      btn.disabled = false;
    }
  });

  // --- Copy generated key ---
  $('#copyKeyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#outKey').textContent);
      $('#copyKeyBtn').textContent = 'Copied!';
      setTimeout(() => { $('#copyKeyBtn').textContent = 'Copy'; }, 1500);
    } catch (_) { /* clipboard may be blocked; user can select manually */ }
  });

  $('#refreshBtn').addEventListener('click', loadKeys);
  const keySearch = $('#keySearch');
  const keyFilter = $('#keyFilter');
  if (keySearch) keySearch.addEventListener('input', renderRows);
  if (keyFilter) keyFilter.addEventListener('change', renderRows);

  // --- List issued keys ---
  // Read users/ and keys/ once each (admins may list keys/), merged in memory.
  // Filter/search/sort are then pure client-side re-renders — zero extra reads.
  let allRows = []; // merged: { ...userDoc, id, keyData }

  async function loadKeys() {
    const body = $('#keysBody');
    body.innerHTML = '<tr><td colspan="8" class="muted">Loading…</td></tr>';
    try {
      const [usersSnap, keysSnap] = await Promise.all([
        getDocs(collection(db, 'users')),
        getDocs(collection(db, 'keys')),
      ]);
      const keyMap = new Map();
      keysSnap.forEach((k) => keyMap.set(k.id, k.data()));
      allRows = [];
      usersSnap.forEach((d) => {
        const u = { id: d.id, ...d.data() };
        u.keyData = u.keyHash ? (keyMap.get(u.keyHash) || null) : null;
        allRows.push(u);
      });
    } catch (err) {
      console.error('[admin] loadKeys failed', err);
      body.innerHTML = '<tr><td colspan="8" class="muted">Could not load keys.</td></tr>';
      return;
    }
    renderRows();
  }

  /* Apply the active filter + search + sort and paint the table. No reads. */
  function renderRows() {
    const body = $('#keysBody');
    const summary = $('#keysSummary');
    const q = ((keySearch && keySearch.value) || '').trim().toLowerCase();
    const filter = (keyFilter && keyFilter.value) || 'all';

    // "Expiring soon" = ACTIVE keys only. A disabled key isn't awaiting
    // renewal, so it shouldn't inflate the count or get the amber tint.
    const soonCount = allRows.filter((u) => {
      if (u.active === false) return false;
      const dn = daysUntil(u.expiresAt);
      return dn != null && dn >= 0 && dn <= 7;
    }).length;
    if (summary) summary.textContent = allRows.length
      ? `${allRows.length} key${allRows.length > 1 ? 's' : ''}` +
        (soonCount ? ` · ${soonCount} expiring within 7 days` : '')
      : '';

    let rows = allRows.filter((u) => {
      const active = u.active !== false;
      const dn = daysUntil(u.expiresAt);      // null = lifetime
      const expired = dn != null && dn < 0;
      switch (filter) {
        case 'soon7':    return active && dn != null && dn >= 0 && dn <= 7;
        case 'soon30':   return active && dn != null && dn >= 0 && dn <= 30;
        case 'expired':  return expired;
        case 'active':   return active && !expired;
        case 'disabled': return !active;
        default:         return true;
      }
    });

    if (q) rows = rows.filter((u) =>
      [u.name, u.phone, u.serialKey, u.id].some((v) => String(v || '').toLowerCase().includes(q)));

    if (filter === 'soon7' || filter === 'soon30') {
      // Soonest expiry first (lifetime/none sorts last).
      rows.sort((a, b) => (toMillis(a.expiresAt) ?? Infinity) - (toMillis(b.expiresAt) ?? Infinity));
    } else {
      // Newest issued first.
      rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    }

    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="8" class="muted">${allRows.length ? 'No keys match this filter.' : 'No keys yet.'}</td></tr>`;
      return;
    }
    body.innerHTML = '';
    rows.forEach((u) => body.appendChild(buildRow(u)));
  }

  /* Build one table row (+ its action buttons) for a merged user record. */
  function buildRow(u) {
      const kd = u.keyData;
      const active = u.active !== false;
      const boundDevice = (kd && kd.boundDevice) || '';
      const dn = daysUntil(u.expiresAt);
      const expired = dn != null && dn < 0;
      const soon = active && dn != null && dn >= 0 && dn <= 7;
      const tr = document.createElement('tr');
      if (expired) tr.className = 'row-expired';
      else if (soon) tr.className = 'row-soon';
      tr.innerHTML = `
        <td>${esc(u.name)}</td>
        <td>${esc(u.phone || '—')}</td>
        <td class="mono">${esc(u.id)}</td>
        <td class="key-cell"><code class="mono">${esc(u.serialKey || '—')}</code></td>
        <td>${esc(u.durationLabel || '')}</td>
        <td title="${u.expiresAt ? esc(fmtDate(u.expiresAt)) : 'Never'}">${esc(fmtExpiryRelative(u.expiresAt))}</td>
        <td>
          <span class="pill ${active ? 'pill-on' : 'pill-off'}">${active ? 'Active' : 'Disabled'}</span>
          <span class="pill ${boundDevice ? 'pill-warn' : 'pill-free'}" title="${boundDevice ? 'Locked to a device' : 'Not yet used on any device'}">${boundDevice ? 'Bound' : 'Free'}</span>
        </td>
        <td class="actions-cell"></td>`;

      const keyCell = tr.querySelector('.key-cell');
      if (u.serialKey) {
        const copy = document.createElement('button');
        copy.className = 'btn btn-ghost btn-sm';
        copy.textContent = 'Copy';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(u.serialKey);
            copy.textContent = 'Copied!';
            setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
          } catch (_) { /* clipboard blocked; the key is visible to select */ }
        });
        keyCell.appendChild(copy);
      }

      const actions = tr.querySelector('.actions-cell');

      // Send the key to this customer via WhatsApp (prefilled message).
      if (u.serialKey) {
        const send = document.createElement('a');
        send.className = 'btn btn-success btn-sm';
        send.textContent = 'Send';
        send.target = '_blank';
        send.rel = 'noopener';
        send.href = waLink(u.phone, keyMessage({
          name: u.name,
          key: u.serialKey,
          expiryText: u.expiresAt ? fmtDate(u.expiresAt) : 'Lifetime',
        }));
        actions.appendChild(send);
      }

      // Enable / Disable
      const toggle = document.createElement('button');
      toggle.className = 'btn btn-ghost btn-sm';
      toggle.textContent = active ? 'Disable' : 'Enable';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          const next = !active;
          // Flip both docs together so the gate truth (keys/) and the
          // displayed status (users/) can never diverge.
          const batch = writeBatch(db);
          if (u.keyHash) batch.update(doc(db, 'keys', u.keyHash), { active: next });
          batch.update(doc(db, 'users', u.id), { active: next });
          await batch.commit();
        } catch (err) {
          console.error('[admin] toggle failed', err);
          alert('Could not change the key status. Check your permissions and try again.');
        } finally {
          loadKeys();
        }
      });
      actions.appendChild(toggle);

      // Reset device (clear the lock so the key can move to a new device)
      const reset = document.createElement('button');
      reset.className = 'btn btn-ghost btn-sm';
      reset.textContent = 'Reset device';
      reset.disabled = !boundDevice || !u.keyHash;
      reset.title = boundDevice ? 'Unbind so another device can use this key' : 'Not bound to any device yet';
      reset.addEventListener('click', async () => {
        reset.disabled = true;
        try {
          await writeBatch(db)
            .update(doc(db, 'keys', u.keyHash), { boundDevice: '', boundAt: null })
            .commit();
        } catch (err) {
          console.error('[admin] reset device failed', err);
          alert('Could not reset the device lock. Check your permissions and try again.');
        } finally {
          loadKeys();
        }
      });
      actions.appendChild(reset);

      // Renew: add the duration on top of whichever is later — now, or the
      // current still-valid expiry — so renewing early tops up remaining time.
      // Also re-enables the key (renewing implies reactivating).
      const renew = document.createElement('button');
      renew.className = 'btn btn-ghost btn-sm';
      renew.textContent = 'Renew';
      renew.title = 'Extend this key\'s expiry';
      renew.addEventListener('click', async () => {
        const choice = prompt(
          `Renew "${u.name}" for how long?\n\nEnter one of: 1w, 1m, 6m, 1y, lifetime — or a number of days.`,
          '1m');
        if (choice == null) return;                       // cancelled
        const raw = choice.trim().toLowerCase();
        if (!raw) return;
        const dur = DURATIONS[raw] || resolveDuration('custom', raw);
        if (!dur) { alert('Please enter 1w, 1m, 6m, 1y, lifetime, or a number of days (1+).'); return; }
        renew.disabled = true;
        try {
          const curMs = toMillis(u.expiresAt);
          const base = (curMs && curMs > Date.now()) ? new Date(curMs) : new Date();
          const expDate = computeExpiry(dur, base);
          const expiresAt = expDate ? Timestamp.fromDate(expDate) : null;
          const fields = { expiresAt, durationLabel: dur.label, active: true };
          const batch = writeBatch(db);
          if (u.keyHash) batch.update(doc(db, 'keys', u.keyHash), fields);
          batch.update(doc(db, 'users', u.id), fields);
          await batch.commit();
        } catch (err) {
          console.error('[admin] renew failed', err);
          alert('Could not renew the key. Check your permissions and try again.');
        } finally {
          loadKeys();
        }
      });
      actions.appendChild(renew);

      // Delete permanently (both docs)
      const del = document.createElement('button');
      del.className = 'btn btn-danger btn-sm';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (!confirm(`Permanently delete the key for "${u.name}"? This cannot be undone.`)) return;
        del.disabled = true;
        try {
          const batch = writeBatch(db);
          if (u.keyHash) batch.delete(doc(db, 'keys', u.keyHash));
          batch.delete(doc(db, 'users', u.id));
          await batch.commit();
        } catch (err) {
          console.error('[admin] delete failed', err);
          alert('Could not delete the key. Check your permissions and try again.');
        } finally {
          loadKeys();
        }
      });
      actions.appendChild(del);

      return tr;
  }
}

function friendlyAuthError(err) {
  const code = (err && err.code) || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found'))
    return 'Wrong email or password.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Try again later.';
  if (code.includes('network')) return 'Network error. Check your internet.';
  return 'Could not sign in. Please try again.';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
