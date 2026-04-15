/**
 * Firebase initialization with mock fallback.
 *
 * If firebase-config.js is missing or Firebase fails to load,
 * falls back to a mock interface for UI development.
 * Adapted from vacation-portal-v2 for schedule viewing.
 */

const MOCK_DOCTORS = [
    { name: "Ali",      email: "ali@mock.dev",      order: 0 },
    { name: "Bednarz",  email: "bednarz@mock.dev",  order: 1 },
    { name: "Browne",   email: "browne@mock.dev",   order: 2 },
    { name: "Giese",    email: "giese@mock.dev",     order: 3 },
    { name: "Isoniemi", email: "isoniemi@mock.dev",  order: 4 },
    { name: "Kemp",     email: "kemp@mock.dev",      order: 5 },
    { name: "Mackey",   email: "mackey@mock.dev",    order: 6 },
    { name: "Mathew",   email: "mathew@mock.dev",    order: 7 },
    { name: "Patel",    email: "patel@mock.dev",     order: 8 },
    { name: "Rikert",   email: "rikert@mock.dev",    order: 9 },
];

const MOCK_PASSWORD = "test";

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

    const schedule = [];
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

        schedule.push({
            date: dateISO,
            day: dayName,
            holiday: holiday,
            callDoctor: callDoctor,
            clinicDoctor: clinicDoctor,
        });

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

const MOCK_SCHEDULE = generateMockSchedule();

const MOCK_SCHEDULE_META = {
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    publishedAt: new Date("2026-06-28T10:00:00"),
};

function createMockDb() {
    console.warn("[Schedule] Firebase not configured — running in mock mode");

    let _mockUser = null;
    let _authCallbacks = [];

    function _notifyAuth() {
        _authCallbacks.forEach(cb => cb(_mockUser));
    }

    return {
        _mock: true,

        // --- Auth ---
        async signIn(email, password) {
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

        // --- Firestore ---
        async getDoctors() {
            return MOCK_DOCTORS.map(d => ({ name: d.name, email: d.email, order: d.order }));
        },

        async getScheduleMeta() {
            return { ...MOCK_SCHEDULE_META };
        },

        async getTodaySchedule(dateISO) {
            const entry = MOCK_SCHEDULE.find(s => s.date === dateISO);
            return entry || null;
        },

        async getScheduleRange(startDate, endDate) {
            return MOCK_SCHEDULE.filter(s => s.date >= startDate && s.date <= endDate)
                .sort((a, b) => a.date.localeCompare(b.date));
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
    };
}

async function initDb() {
    // Step 1: Try to load firebase-config.js
    let firebaseConfig = null;
    try {
        const configModule = await import("../firebase-config.js");
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
                const retryModule = await import("../firebase-config.js");
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
