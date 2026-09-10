# BulkBGRemover — Firebase setup (free, no credit card)

The download gate + admin panel use **Firebase Spark (free) plan**: Firestore + Email/Password
Auth. No Cloud Functions, no Cloud Storage, **no credit card**. Everything runs client-side and
is protected by Firestore Security Rules.

> **Until you finish steps 1–6, the download gate stays OFF** (the site still works, downloads are
> just open). It turns on automatically once you paste your config in step 6.

---

## What you'll build

- **1 image → always free** to download.
- **2+ images → a valid serial key is required** (for ZIP *and* individual saves).
- **Admin panel** (`/admin.html`) where you log in, enter a person's name + phone, pick a duration
  (1 week / 1 month / 6 months / 1 year / lifetime), and generate a random key tied to a unique user ID.
- Keys live in Firestore. The **raw key is never stored** — only its SHA-256 hash — so the database
  can't leak usable keys and can't be enumerated.

---

## Step 1 — Create the Firestore database
1. Go to the [Firebase console](https://console.firebase.google.com/) → your project.
2. **Build → Firestore Database → Create database**.
3. Choose a location (closest to your users), start in **Production mode**. Create.

## Step 2 — Publish the security rules
1. In Firestore → **Rules** tab.
2. Replace everything with the contents of [`firestore.rules`](firestore.rules).
3. Click **Publish**.

## Step 3 — Turn on Email/Password login
1. **Build → Authentication → Get started**.
2. **Sign-in method → Email/Password → Enable → Save**.

## Step 4 — Create your admin account
1. **Authentication → Users → Add user**.
2. Enter your admin **email** + a strong **password**. Add user.
3. Click the new user and **copy its User UID** (a long string).

## Step 5 — Mark that account as an admin
1. Go back to **Firestore Database → Data**.
2. **Start collection** → Collection ID: `admins`.
3. **Document ID**: paste the **User UID** from step 4.
4. Add one field, e.g. `role` (string) = `admin`. Save.
   *(Only the presence of this document matters — it's the admin allow-list.)*

## Step 6 — Paste your web config into the site
1. Firebase console → **Project settings** (gear icon) → **Your apps**.
2. If you have no web app yet: **Add app → Web (`</>`)**, give it a nickname, register.
3. Copy the `firebaseConfig` object it shows you.
4. Open [`js/firebase-config.js`](js/firebase-config.js) and paste your values into
   `FIREBASE_CONFIG` (replace every `PASTE_...`). Save.

> These values are **not secrets** — they only identify your project and are safe in public code.
> Your data is protected by the rules from step 2, not by hiding this config.

---

## Using it
1. Deploy (or run locally) and open **`/admin.html`**.
2. Sign in with your admin email/password.
3. Fill name + phone, choose a duration, click **Generate key**.
4. **Copy the key immediately** and give it to the user (WhatsApp/email). The raw key is shown only
   once — it is never stored, so it can't be shown again. You can always disable/re-enable a key later
   from the list.

## Free-tier limits (plenty for a school tool)
- Firestore: **50,000 reads/day**, **20,000 writes/day**, 1 GiB stored. Each key check = 1 read.
- Auth: free up to 50,000 monthly users (you only need the admin account).

## Honest limitation — please read
Background removal happens **entirely in the visitor's browser**, so the finished images are already
on their device before any button. A key gate written in the page's JavaScript **stops normal users,
but a technical person can bypass it** (browser dev tools, right-click-save, disabling JS). This is a
deterrent, not copy protection. Truly unbypassable protection would require a paid server to hold the
images — which would break the free + private + in-browser design. For a school/portfolio tool the
deterrent is usually all you need.

## Support contact shown to users
Edit the support email / WhatsApp link in the key dialog: search for `SUPPORT_CONTACT` in
[`js/app.js`](js/app.js) and set your details.
