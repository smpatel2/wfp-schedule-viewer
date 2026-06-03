/**
 * Firebase initialization with mock fallback.
 *
 * If firebase-config.js is missing or Firebase fails to load,
 * falls back to a mock interface for UI development.
 * Adapted from vacation-portal-v2 for schedule viewing.
 */

const MOCK_DOCTORS = [
    { name: "Bednarz",  email: "bednarz@mock.dev",  order: 0 },
    { name: "Browne",   email: "browne@mock.dev",   order: 1 },
    { name: "Giese",    email: "giese@mock.dev",     order: 2 },
    { name: "Isoniemi", email: "isoniemi@mock.dev",  order: 3 },
    { name: "Kemp",     email: "kemp@mock.dev",      order: 4 },
    { name: "Mackey",   email: "mackey@mock.dev",    order: 5 },
    { name: "Mathew",   email: "mathew@mock.dev",    order: 6 },
    { name: "Patel",    email: "patel@mock.dev",     order: 7 },
    { name: "Rikert",   email: "rikert@mock.dev",    order: 8 },
];

const MOCK_ADMIN_EMAIL = 'admin@mock.dev';
const MOCK_STAFF_EMAIL = 'staff@mock.dev';
const MOCK_PASSWORD = "test";

// Production shared staff account email. The matching Firebase Auth
// account + /staff/{email-lowercased} doc must exist in Firestore for
// the existence check to succeed.
const STAFF_EMAIL = 'sapan.patel+wfpstaff@gmail.com';

/**
 * Validate and normalize a reassignment payload (shared by mock + Firebase).
 *
 * Performs DATA-INTEGRITY checks only — NOT domain/scheduling-rule checks.
 * Reassignment is a deliberate override tool (see spec Non-Goals A1), so it
 * does not enforce consecutive-day, spacing, vacation, or fairness rules.
 *
 * Returns { dates (sorted), field } or throws a user-readable Error.
 */
function validateReassignPayload(payload) {
    const allowedTypes = ['single-call', 'weekend-block', 'saturday-clinic'];
    const closedValues = ['', 'Closed', 'ERROR'];
    const { shiftType, fromDoctor, toDoctor } = payload || {};

    if (!allowedTypes.includes(shiftType))
        throw new Error('Invalid reassignment type.');
    if (!Array.isArray(payload?.dates))
        throw new Error('Reassignment dates are required.');
    if (!fromDoctor || !toDoctor)
        throw new Error('Both fromDoctor and toDoctor are required.');
    if (closedValues.includes(fromDoctor) || closedValues.includes(toDoctor))
        throw new Error('Cannot reassign closed or unassigned shifts.');
    if (fromDoctor === toDoctor)
        throw new Error('Cannot reassign a shift to the same doctor.');

    const dates = [...payload.dates].sort();
    const iso = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
    if (dates.some(d => typeof d !== 'string' || !iso.test(d)))
        throw new Error('Reassignment dates must be valid ISO dates.');
    if (new Set(dates).size !== dates.length)
        throw new Error('Reassignment dates cannot contain duplicates.');

    if (shiftType === 'weekend-block') {
        if (dates.length !== 3)
            throw new Error('Weekend reassignment must cover exactly three dates.');
        const d0 = new Date(dates[0] + 'T12:00:00');
        const d1 = new Date(dates[1] + 'T12:00:00');
        const d2 = new Date(dates[2] + 'T12:00:00');
        // Do NOT use millisecond deltas to test consecutiveness — local-time
        // getTime() spans are not a constant 86,400,000 ms across a DST
        // transition (e.g. Fri Oct 30 -> Sun Nov 1, 2026 crosses the US
        // fall-back, making one day 25h). Compare by advancing calendar dates.
        const nextISO = (isoStr) => {
            const dt = new Date(isoStr + 'T12:00:00');   // local noon anchor
            dt.setDate(dt.getDate() + 1);                // calendar-correct across DST
            const y = dt.getFullYear();
            const m = String(dt.getMonth() + 1).padStart(2, '0');
            const day = String(dt.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };
        if (d0.getDay() !== 5 ||
            d1.getDay() !== 6 ||
            d2.getDay() !== 0 ||
            nextISO(dates[0]) !== dates[1] ||
            nextISO(dates[1]) !== dates[2]) {
            throw new Error('Weekend reassignment must be a consecutive Friday-Sunday block.');
        }
    } else if (dates.length !== 1) {
        throw new Error('Single-shift reassignment must cover exactly one date.');
    }

    const field = shiftType === 'saturday-clinic' ? 'clinicDoctor' : 'callDoctor';
    return { dates, field };
}

/**
 * Generate mock schedule data for July 2026.
 * Rotates through all 10 doctors for call assignments.
 * Saturdays get clinic assignments from a separate rotation.
 */
function generateMockSchedule() {
    const doctors = MOCK_DOCTORS.map(d => d.name);
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const holidays = {
        "2026-07-04": "Independence Day",
    };

    const schedule = {};
    const start = new Date(2026, 6, 1); // July 1, 2026
    const end = new Date(2026, 6, 31);  // July 31, 2026

    let callIdx = 0;
    let clinicIdx = 5; // Offset from call rotation

    const current = new Date(start);
    while (current <= end) {
        const y = current.getFullYear();
        const m = String(current.getMonth() + 1).padStart(2, '0');
        const d = String(current.getDate()).padStart(2, '0');
        const dateISO = `${y}-${m}-${d}`;
        const dayName = days[current.getDay()];
        const holiday = holidays[dateISO] || "";

        const isSaturday = current.getDay() === 6;
        const isSunday = current.getDay() === 0;

        const callDoctor = doctors[callIdx % doctors.length];
        const clinicDoctor = isSaturday
            ? doctors[clinicIdx % doctors.length]
            : (isSunday || holiday ? "Closed" : "");

        schedule[dateISO] = {
            date: dateISO,
            day: dayName,
            holiday: holiday,
            callDoctor: callDoctor,
            clinicDoctor: clinicDoctor,
        };

        // Advance call rotation (skip weekends for variety)
        if (!isSaturday && !isSunday) {
            callIdx++;
        } else if (isSaturday) {
            callIdx++;
            clinicIdx++;
        }

        current.setDate(current.getDate() + 1);
    }

    return schedule;
}

function createMockDb() {
    console.warn("[Schedule] Firebase not configured — running in mock mode");

    let _mockUser = null;
    let _authCallbacks = [];

    // Mutable schedule map and meta — so applyCallSwap can mutate them and
    // fire the meta listener, keeping the preview flow identical to production.
    let _schedule = generateMockSchedule();
    let _scheduleMeta = {
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        dayCount: Object.keys(_schedule).length,
        publishedAt: new Date("2026-06-28T10:00:00"),
    };
    const _metaCallbacks = new Set();

    function _notifyAuth() {
        _authCallbacks.forEach(cb => cb(_mockUser));
    }

    return {
        _mock: true,
        STAFF_EMAIL: MOCK_STAFF_EMAIL,

        // --- Auth ---
        async signIn(email, password) {
            // Accept admin mock account
            if (email === MOCK_ADMIN_EMAIL) {
                if (password !== MOCK_PASSWORD) throw { code: 'auth/invalid-credential', message: 'Wrong password' };
                _mockUser = { email };
                _notifyAuth();
                return;
            }
            // Accept staff mock account
            if (email === MOCK_STAFF_EMAIL) {
                if (password !== MOCK_PASSWORD) throw { code: 'auth/invalid-credential', message: 'Wrong password' };
                _mockUser = { email };
                _notifyAuth();
                return;
            }
            const doctor = MOCK_DOCTORS.find(d => d.email === email);
            if (!doctor) throw { code: 'auth/user-not-found', message: 'User not found' };
            if (password !== MOCK_PASSWORD) throw { code: 'auth/invalid-credential', message: 'Wrong password' };
            _mockUser = { email };
            _notifyAuth();
        },

        async signOut() {
            _mockUser = null;
            _notifyAuth();
        },

        onAuthChanged(callback) {
            _authCallbacks.push(callback);
            const session = sessionStorage.getItem('schedule_viewer_doctor');
            if (session) {
                const doc = MOCK_DOCTORS.find(d => d.name === session);
                if (doc) {
                    _mockUser = { email: doc.email };
                    callback(_mockUser);
                    return;
                }
            }
            callback(null);
        },

        // --- Admin ---
        // In mock mode any email containing "admin" is treated as admin,
        // so preview works without seeding a real /admins doc.
        async isAdmin(email) {
            if (!email) return false;
            return email.toLowerCase().includes('admin');
        },

        // --- Staff ---
        // Only the exact mock staff email triggers staff mode in mock,
        // mirroring how the real isStaff checks for an exact /staff doc.
        async isStaff(email) {
            if (!email) return false;
            return email.toLowerCase() === MOCK_STAFF_EMAIL;
        },

        // --- Live Listener ---
        // Fires callback with current meta immediately (mirrors onSnapshot's
        // first emission), then again whenever applyCallSwap commits a swap.
        // Returns an unsubscribe function.
        onScheduleMetaChange(callback) {
            _metaCallbacks.add(callback);
            // Fire immediately so the UI hydrates last-updated on mount
            setTimeout(() => callback({ ..._scheduleMeta }), 0);
            return () => _metaCallbacks.delete(callback);
        },

        // --- Swap ---
        async applyCallSwap(swap) {
            // Cheap preconditions (identical to production implementation)
            if (!swap.doctorA || !swap.doctorB)
                throw new Error('Both sides of the swap must have an assigned doctor.');
            if (swap.doctorA === swap.doctorB)
                throw new Error('Cannot swap a doctor with themselves.');
            const CLOSED_VALUES = ['', 'Closed'];
            if (CLOSED_VALUES.includes(swap.doctorA) || CLOSED_VALUES.includes(swap.doctorB))
                throw new Error('Cannot swap a day that is closed or has no assigned doctor.');
            if (!swap.datesA?.length || !swap.datesB?.length)
                throw new Error('Both sides of the swap must have at least one date.');
            if (swap.datesA.length !== swap.datesB.length)
                throw new Error('Both sides of the swap must cover the same number of days.');
            const allDates = [...swap.datesA, ...swap.datesB];
            if (new Set(allDates).size !== allDates.length)
                throw new Error('Swap selections overlap — the same date cannot appear on both sides.');

            const field = swap.shiftType === 'saturday-clinic' ? 'clinicDoctor' : 'callDoctor';

            // Verify entries exist and match expected doctors (optimistic lock)
            for (const d of allDates) {
                if (!_schedule[d]) throw new Error(`No published schedule entry exists for ${d}.`);
            }
            for (let i = 0; i < swap.datesA.length; i++) {
                const cur = _schedule[swap.datesA[i]][field];
                if (cur !== swap.doctorA) throw new Error(
                    `Schedule changed — ${swap.datesA[i]} now shows Dr. ${cur || '(none)'}, expected Dr. ${swap.doctorA}.`
                );
            }
            for (let i = 0; i < swap.datesB.length; i++) {
                const cur = _schedule[swap.datesB[i]][field];
                if (cur !== swap.doctorB) throw new Error(
                    `Schedule changed — ${swap.datesB[i]} now shows Dr. ${cur || '(none)'}, expected Dr. ${swap.doctorB}.`
                );
            }

            // Apply
            for (const d of swap.datesA) {
                _schedule[d] = { ..._schedule[d], [field]: swap.doctorB };
            }
            for (const d of swap.datesB) {
                _schedule[d] = { ..._schedule[d], [field]: swap.doctorA };
            }

            // Bump publishedAt by 1 second from its current value (not wall-clock new Date(),
            // which can be earlier than the mock's initial future-dated publishedAt).
            const prevMs = _scheduleMeta.publishedAt instanceof Date
                ? _scheduleMeta.publishedAt.getTime()
                : new Date(_scheduleMeta.publishedAt).getTime();
            _scheduleMeta = { ..._scheduleMeta, publishedAt: new Date(prevMs + 1000) };
            _metaCallbacks.forEach(cb => cb({ ..._scheduleMeta }));
        },

        // --- Reassign (one-way override) ---
        async applyCallReassign(payload) {
            const { fromDoctor, toDoctor, editBy } = payload;
            const { dates, field } = validateReassignPayload(payload);

            if (!MOCK_DOCTORS.some(d => d.name === toDoctor)) {
                throw new Error(`Dr. ${toDoctor} is not in the doctor roster.`);
            }

            // --- Optimistic lock: verify each date still shows fromDoctor ---
            for (const d of dates) {
                if (!_schedule[d])
                    throw new Error(`No published schedule entry exists for ${d}.`);
                const cur = _schedule[d][field];
                if (cur !== fromDoctor) throw new Error(
                    `Schedule changed — ${d} now shows Dr. ${cur || '(none)'}, ` +
                    `expected Dr. ${fromDoctor}.`
                );
            }

            // --- Apply (with edit-provenance stamp) ---
            const now = new Date();
            for (const d of dates) {
                _schedule[d] = {
                    ..._schedule[d],
                    [field]: toDoctor,
                    previousDoctor: fromDoctor,
                    lastEditBy: editBy || '(unknown)',
                    lastEditAt: now,
                    lastEditType: 'reassign',
                };
            }

            // --- Bump publishedAt (same pattern as applyCallSwap) ---
            const prevMs = _scheduleMeta.publishedAt instanceof Date
                ? _scheduleMeta.publishedAt.getTime()
                : new Date(_scheduleMeta.publishedAt).getTime();
            _scheduleMeta = { ..._scheduleMeta, publishedAt: new Date(prevMs + 1000) };
            _metaCallbacks.forEach(cb => cb({ ..._scheduleMeta }));
        },

        // --- Firestore ---
        async getDoctors() {
            return MOCK_DOCTORS.map(d => ({ name: d.name, email: d.email, order: d.order }));
        },

        async getScheduleMeta() {
            return { ..._scheduleMeta };
        },

        async getTodaySchedule(dateISO) {
            return _schedule[dateISO] ? { ..._schedule[dateISO] } : null;
        },

        async getScheduleRange(startDate, endDate) {
            return Object.values(_schedule)
                .filter(s => s.date >= startDate && s.date <= endDate)
                .map(s => ({ ...s }))
                .sort((a, b) => a.date.localeCompare(b.date));
        },

        async getScheduleRangeFromServer(startDate, endDate) {
            return this.getScheduleRange(startDate, endDate);
        },
    };
}

function createFirestoreDb(db, auth) {
    let _firestoreMod = null;
    async function fs() {
        if (!_firestoreMod) {
            _firestoreMod = await import("https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js");
        }
        return _firestoreMod;
    }

    let _authMod = null;
    async function authMod() {
        if (!_authMod) {
            _authMod = await import("https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js");
        }
        return _authMod;
    }

    return {
        _mock: false,
        STAFF_EMAIL,

        // --- Auth ---
        async signIn(email, password) {
            const { signInWithEmailAndPassword } = await authMod();
            await signInWithEmailAndPassword(auth, email, password);
        },

        async signOut() {
            const { signOut } = await authMod();
            await signOut(auth);
        },

        onAuthChanged(callback) {
            import("https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js").then(({ onAuthStateChanged }) => {
                onAuthStateChanged(auth, callback);
            });
        },

        // --- Admin ---
        // Reads /admins/{email} doc — exists means admin.
        // Each user can only read their own doc (per security rules).
        async isAdmin(email) {
            if (!email) return false;
            try {
                const { doc, getDoc } = await fs();
                const snap = await getDoc(doc(db, 'admins', email.toLowerCase()));
                return snap.exists();
            } catch (e) {
                // permission-denied means not admin (or not authenticated yet)
                return false;
            }
        },

        // --- Staff ---
        // Reads /staff/{email} doc — exists means staff.
        // Each user can only read their own doc (per security rules).
        async isStaff(email) {
            if (!email) return false;
            try {
                const { doc, getDoc } = await fs();
                const snap = await getDoc(doc(db, 'staff', email.toLowerCase()));
                return snap.exists();
            } catch (e) {
                return false;
            }
        },

        // --- Live Listener ---
        // Returns an unsubscribe function. The import is async so we wrap the
        // real unsub in a closure that can be called before the import resolves.
        onScheduleMetaChange(callback) {
            let realUnsub = null;
            let cancelled = false;
            fs().then(({ onSnapshot, doc: fsDoc }) => {
                if (cancelled) return;
                realUnsub = onSnapshot(fsDoc(db, 'scheduleMeta', 'current'), (snap) => {
                    if (!snap.exists()) return;
                    const data = snap.data();
                    callback({
                        ...data,
                        publishedAt: data.publishedAt?.toDate?.() ?? null,
                    });
                });
            });
            return () => {
                cancelled = true;
                if (realUnsub) realUnsub();
            };
        },

        // --- Swap ---
        async applyCallSwap(swap) {
            // Cheap preconditions (fail before any network call)
            if (!swap.doctorA || !swap.doctorB)
                throw new Error('Both sides of the swap must have an assigned doctor.');
            if (swap.doctorA === swap.doctorB)
                throw new Error('Cannot swap a doctor with themselves.');
            const CLOSED_VALUES = ['', 'Closed'];
            if (CLOSED_VALUES.includes(swap.doctorA) || CLOSED_VALUES.includes(swap.doctorB))
                throw new Error('Cannot swap a day that is closed or has no assigned doctor.');
            if (!swap.datesA?.length || !swap.datesB?.length)
                throw new Error('Both sides of the swap must have at least one date.');
            if (swap.datesA.length !== swap.datesB.length)
                throw new Error('Both sides of the swap must cover the same number of days.');
            const allDates = [...swap.datesA, ...swap.datesB];
            if (new Set(allDates).size !== allDates.length)
                throw new Error('Swap selections overlap — the same date cannot appear on both sides.');

            const field = swap.shiftType === 'saturday-clinic' ? 'clinicDoctor' : 'callDoctor';
            const { runTransaction, doc: fsDoc, serverTimestamp } = await fs();

            try {
                await runTransaction(db, async (tx) => {
                    const refs = allDates.map(d => fsDoc(db, 'schedule', d));
                    const snaps = await Promise.all(refs.map(r => tx.get(r)));

                    snaps.forEach((snap, i) => {
                        if (!snap.exists())
                            throw new Error(`No published schedule entry exists for ${allDates[i]}.`);
                    });

                    // Optimistic lock: current Firestore state must still match
                    // what the admin saw when they made their selection.
                    swap.datesA.forEach((_, i) => {
                        const cur = snaps[i].data()[field];
                        if (cur !== swap.doctorA) throw new Error(
                            `Schedule changed — ${swap.datesA[i]} now shows Dr. ${cur || '(none)'}, expected Dr. ${swap.doctorA}.`
                        );
                    });
                    swap.datesB.forEach((_, i) => {
                        const snap = snaps[swap.datesA.length + i];
                        const cur = snap.data()[field];
                        if (cur !== swap.doctorB) throw new Error(
                            `Schedule changed — ${swap.datesB[i]} now shows Dr. ${cur || '(none)'}, expected Dr. ${swap.doctorB}.`
                        );
                    });

                    swap.datesA.forEach(d =>
                        tx.update(fsDoc(db, 'schedule', d), { [field]: swap.doctorB }));
                    swap.datesB.forEach(d =>
                        tx.update(fsDoc(db, 'schedule', d), { [field]: swap.doctorA }));

                    // Bump publishedAt — triggers onScheduleMetaChange listener
                    // in all open sessions so they auto-refresh.
                    tx.update(fsDoc(db, 'scheduleMeta', 'current'), {
                        publishedAt: serverTimestamp(),
                    });
                });
            } catch (e) {
                if (e.code === 'unavailable' || e.code === 'failed-precondition') {
                    throw new Error('Connection lost — swap was not applied. Reconnect and try again.');
                }
                throw e;
            }
        },

        // --- Reassign (one-way override) ---
        async applyCallReassign(payload) {
            const { fromDoctor, toDoctor, editBy } = payload;
            const { dates, field } = validateReassignPayload(payload);
            const { runTransaction, doc: fsDoc, serverTimestamp } = await fs();

            // No pre-transaction getDoc on /doctors/{toDoctor}: the target always
            // comes from the roster-sourced dropdown, and Firestore security rules
            // are the authoritative guard against unknown doctors. A pre-check
            // would add a round-trip and is still subject to TOCTOU.

            try {
                await runTransaction(db, async (tx) => {
                    const refs = dates.map(d => fsDoc(db, 'schedule', d));
                    const snaps = await Promise.all(refs.map(r => tx.get(r)));

                    // Existence check
                    snaps.forEach((snap, i) => {
                        if (!snap.exists())
                            throw new Error(`No published schedule entry exists for ${dates[i]}.`);
                    });

                    // Optimistic lock
                    snaps.forEach((snap, i) => {
                        const cur = snap.data()[field];
                        if (cur !== fromDoctor) throw new Error(
                            `Schedule changed — ${dates[i]} now shows ` +
                            `Dr. ${cur || '(none)'}, expected Dr. ${fromDoctor}.`
                        );
                    });

                    // Write toDoctor + edit-provenance stamp to all dates
                    dates.forEach(d =>
                        tx.update(fsDoc(db, 'schedule', d), {
                            [field]: toDoctor,
                            previousDoctor: fromDoctor,
                            lastEditBy: editBy || '(unknown)',
                            lastEditAt: serverTimestamp(),
                            lastEditType: 'reassign',
                        })
                    );

                    // Bump publishedAt — triggers onScheduleMetaChange in all open sessions
                    tx.update(fsDoc(db, 'scheduleMeta', 'current'), {
                        publishedAt: serverTimestamp(),
                    });
                });
            } catch (e) {
                if (e.code === 'unavailable' || e.code === 'failed-precondition') {
                    throw new Error('Connection lost — reassignment was not applied. Reconnect and try again.');
                }
                throw e;
            }
        },

        // --- Firestore ---
        async getDoctors() {
            const { collection, getDocs, orderBy, query } = await fs();
            const q = query(collection(db, "doctors"), orderBy("order"));
            const snap = await getDocs(q);
            return snap.docs.map(d => d.data());
        },

        async getScheduleMeta() {
            const { doc, getDoc } = await fs();
            const snap = await getDoc(doc(db, "scheduleMeta", "current"));
            if (!snap.exists()) return null;
            const data = snap.data();
            return {
                startDate: data.startDate,
                endDate: data.endDate,
                dayCount: data.dayCount ?? null,
                publishedAt: data.publishedAt ? data.publishedAt.toDate() : null,
            };
        },

        async getTodaySchedule(dateISO) {
            const { doc, getDoc } = await fs();
            const snap = await getDoc(doc(db, "schedule", dateISO));
            if (!snap.exists()) return null;
            return snap.data();
        },

        async getScheduleRange(startDate, endDate) {
            const { collection, getDocs, query, where, orderBy } = await fs();
            const q = query(
                collection(db, "schedule"),
                where("date", ">=", startDate),
                where("date", "<=", endDate),
                orderBy("date")
            );
            const snap = await getDocs(q);
            return snap.docs.map(d => d.data());
        },

        async getScheduleRangeFromServer(startDate, endDate) {
            const { collection, getDocsFromServer, query, where, orderBy } = await fs();
            const q = query(
                collection(db, "schedule"),
                where("date", ">=", startDate),
                where("date", "<=", endDate),
                orderBy("date")
            );
            const snap = await getDocsFromServer(q);
            return snap.docs.map(d => d.data());
        },
    };
}

async function initDb() {
    // Allow ?mock=true in the URL to force mock mode (for local preview)
    const params = new URLSearchParams(window.location.search);
    if (params.get('mock') === 'true') {
        console.log("[Schedule] Mock mode forced via ?mock=true");
        return createMockDb();
    }

    // Step 1: Try to load firebase-config.js
    let firebaseConfig = null;
    try {
        const configModule = await import("../firebase-config.js?v=2");
        firebaseConfig = configModule.default;
    } catch (e) {
        // Config file missing or failed to load.
        // If we've previously connected to Firebase (flag in sessionStorage),
        // this is likely an offline/timing issue — don't fall back to mock.
        if (sessionStorage.getItem('schedule_viewer_firebase')) {
            console.warn("[Schedule] firebase-config.js failed to load but Firebase was previously active. Retrying...");
            // Wait for service worker to serve from cache, then retry once
            await new Promise(r => setTimeout(r, 500));
            try {
                const retryModule = await import("../firebase-config.js?v=2");
                firebaseConfig = retryModule.default;
            } catch (e2) {
                console.error("[Schedule] Retry failed — falling back to mock mode:", e2);
                return createMockDb();
            }
        } else {
            // Never connected before — genuinely missing config, use mock
            console.warn("[Schedule] firebase-config.js not found — running in mock mode");
            return createMockDb();
        }
    }

    // Step 2: Validate config
    if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey === "YOUR_API_KEY") {
        return createMockDb();
    }

    // Step 3: Initialize Firebase
    try {
        const { initializeApp } = await import("https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js");
        const { initializeFirestore, persistentLocalCache } = await import("https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js");
        const { getAuth } = await import("https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js");

        const app = initializeApp(firebaseConfig);
        const db = initializeFirestore(app, {
            localCache: persistentLocalCache()
        });
        const auth = getAuth(app);
        sessionStorage.setItem('schedule_viewer_firebase', '1');
        console.log("[Schedule] Connected to Firebase");
        return createFirestoreDb(db, auth);
    } catch (e) {
        console.error("[Schedule] Firebase init failed — falling back to mock mode:", e);
        return createMockDb();
    }
}

export { initDb };
