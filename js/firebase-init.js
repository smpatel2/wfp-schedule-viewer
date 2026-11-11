import {
    buildReassignChange,
    buildSwapChange,
} from './change-builder.mjs?v=13';

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


const HISTORY_MIGRATION_MESSAGE =
    'Schedule history has not been initialized. '
    + 'Run the local migration tool before editing.';

/**
 * Return safe document IDs for transaction reads without duplicating the
 * builder's payload validation. The builder still receives the untouched
 * payload and is authoritative for shape, ISO-date, duplicate, and overlap
 * checks.
 */
function candidateActionDates(payload, keys) {
    const dates = [];
    for (const key of keys) {
        if (!Array.isArray(payload?.[key])) continue;
        for (const value of payload[key]) {
            if (typeof value === 'string'
                    && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
                dates.push(value);
            }
        }
    }
    return [...new Set(dates)];
}

function timestampToDate(value) {
    return value?.toDate?.() ?? value ?? null;
}

function nextMockTimestamp(meta) {
    const current = timestampToDate(meta.publishedAt);
    const currentMs = current instanceof Date
        ? current.getTime()
        : new Date(current).getTime();
    return new Date(currentMs + 1000);
}

function canonicalMockSnapshot(schedule) {
    return Object.fromEntries(
        Object.entries(schedule).map(([date, entry]) => [
            date,
            {
                date: entry.date,
                day: entry.day,
                holiday: entry.holiday,
                callDoctor: entry.callDoctor,
                clinicDoctor: entry.clinicDoctor,
            },
        ])
    );
}

/**
 * Mock Saturdays on/after this date use the on-call clinic format
 * (clinicDoctor 'On-Call'; the call doctor staffs clinic), so mock mode
 * shows both formats side by side, like the real Dec 2026 -> Jan 2027
 * changeover.
 */
const MOCK_ON_CALL_CLINIC_FROM = '2026-07-18';

/**
 * Generate mock schedule data for July 2026.
 * Rotates through all 10 doctors for call assignments.
 * Saturdays get clinic assignments from a separate rotation until
 * MOCK_ON_CALL_CLINIC_FROM, then the on-call clinic format.
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
            ? (dateISO >= MOCK_ON_CALL_CLINIC_FROM
                ? 'On-Call'
                : doctors[clinicIdx % doctors.length])
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
    const mockArchiveId = 'mock-archive-2026-h2';
    const initialPublishedAt = new Date('2026-06-28T10:00:00Z');
    let _schedule = generateMockSchedule();
    let _scheduleMeta = {
        startDate: '2026-07-01',
        endDate: '2026-07-31',
        dayCount: Object.keys(_schedule).length,
        publishedAt: initialPublishedAt,
        lastFullPublishAt: initialPublishedAt,
        activeArchiveId: mockArchiveId,
        historyRequired: true,
        lastChangeId: null,
    };
    let _scheduleArchives = {
        [mockArchiveId]: {
            metadata: {
                schemaVersion: 1,
                label: 'July 2026',
                startDate: '2026-07-01',
                endDate: '2026-07-31',
                dayCount: Object.keys(_schedule).length,
                doctors: MOCK_DOCTORS.map((doctor) => doctor.name),
                rosterSource: 'generation',
                source: 'scheduler',
                createdBy: 'scheduler-admin-sdk',
                createdAt: initialPublishedAt,
                publishedAt: initialPublishedAt,
                finalizedAt: null,
                finalDayCount: null,
                preMigrationHistoryAvailable: true,
            },
            original: canonicalMockSnapshot(_schedule),
            final: {},
            changes: {},
        },
    };
    let _mockChangeCounter = 0;
    const mockBackup = {
        activeArchiveId: mockArchiveId, primaryPublishedAt: initialPublishedAt,
        assignments: Object.fromEntries(Object.entries(_schedule).map(([date, entry]) => {
            const index = MOCK_DOCTORS.findIndex(d => d.name === entry.callDoctor);
            const backup = MOCK_DOCTORS[(index + 1) % MOCK_DOCTORS.length].name;
            return [date, { primaryDoctor: entry.callDoctor, clinicDoctor: entry.clinicDoctor,
                backupDoctor: backup }];
        })),
    };
    async function decorateMockBackups(entries) {
        const { attachBackups } = await import('./backup-helpers.mjs');
        return attachBackups(entries, mockBackup);
    }
    const _metaCallbacks = new Set();

    function _notifyAuth() {
        _authCallbacks.forEach(cb => cb(_mockUser));
    }

    function _nextMockChangeId() {
        return 'mock-change-' + String(_mockChangeCounter + 1).padStart(6, '0');
    }

    function _activeMockArchive() {
        const archiveId = _scheduleMeta.activeArchiveId;
        if (!archiveId || !_scheduleArchives[archiveId]) {
            throw new Error(HISTORY_MIGRATION_MESSAGE);
        }
        return { archiveId, archive: _scheduleArchives[archiveId] };
    }

    function _requireMockRoster(names) {
        for (const name of names) {
            if (!MOCK_DOCTORS.some((doctor) => doctor.name === name)) {
                throw new Error('Dr. ' + name + ' is not in the doctor roster.');
            }
        }
    }

    function _commitMockChange(result, changeId, editedAt) {
        const { archiveId, archive } = _activeMockArchive();
        const nextSchedule = { ..._schedule };
        for (const [date, update] of Object.entries(result.liveUpdates)) {
            nextSchedule[date] = {
                ..._schedule[date],
                ...update,
            };
        }

        const nextArchive = {
            ...archive,
            changes: {
                ...archive.changes,
                [changeId]: {
                    ...result.changeDocument,
                    changes: result.changeDocument.changes.map(
                        (change) => ({ ...change })
                    ),
                },
            },
        };
        const nextArchives = {
            ..._scheduleArchives,
            [archiveId]: nextArchive,
        };
        const nextMeta = {
            ..._scheduleMeta,
            publishedAt: editedAt,
            lastChangeId: changeId,
        };

        _mockChangeCounter += 1;
        _schedule = nextSchedule;
        _scheduleArchives = nextArchives;
        _scheduleMeta = nextMeta;
        _metaCallbacks.forEach((callback) => callback({ ..._scheduleMeta }));
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
            const { archiveId } = _activeMockArchive();
            const changeId = _nextMockChangeId();
            const editedAt = nextMockTimestamp(_scheduleMeta);
            const editedBy = _mockUser?.email || swap?.editBy || '';
            const builderPayload = {
                shiftType: swap?.shiftType,
                datesA: swap?.datesA,
                doctorA: swap?.doctorA,
                datesB: swap?.datesB,
                doctorB: swap?.doctorB,
            };
            if (Object.prototype.hasOwnProperty.call(
                    swap || {}, 'allowSameDayConflict')) {
                builderPayload.allowSameDayConflict =
                    swap.allowSameDayConflict;
            }

            const result = buildSwapChange({
                archiveId,
                changeId,
                editedBy,
                editedAt,
                payload: builderPayload,
                scheduleByDate: _schedule,
            });
            _requireMockRoster([
                swap?.doctorA,
                swap?.doctorB,
            ]);
            _commitMockChange(result, changeId, editedAt);
            return { changeId, conflicts: result.conflicts };
        },

        // --- Reassign (one-way override) ---
        async applyCallReassign(payload) {
            const { archiveId } = _activeMockArchive();
            const changeId = _nextMockChangeId();
            const editedAt = nextMockTimestamp(_scheduleMeta);
            const editedBy = _mockUser?.email || payload?.editBy || '';
            const builderPayload = {
                shiftType: payload?.shiftType,
                dates: payload?.dates,
                fromDoctor: payload?.fromDoctor,
                toDoctor: payload?.toDoctor,
            };
            if (Object.prototype.hasOwnProperty.call(
                    payload || {}, 'allowSameDayConflict')) {
                builderPayload.allowSameDayConflict =
                    payload.allowSameDayConflict;
            }

            const result = buildReassignChange({
                archiveId,
                changeId,
                editedBy,
                editedAt,
                payload: builderPayload,
                scheduleByDate: _schedule,
            });
            _requireMockRoster([payload?.toDoctor]);
            _commitMockChange(result, changeId, editedAt);
            return { changeId, conflicts: result.conflicts };
        },

        // --- Firestore ---
        async getDoctors() {
            return MOCK_DOCTORS.map(d => ({ name: d.name, email: d.email, order: d.order }));
        },

        async getScheduleMeta() {
            return { ..._scheduleMeta };
        },
        async getScheduleArchives() {
            return Object.entries(_scheduleArchives)
                .map(([id, archive]) => ({
                    id,
                    ...archive.metadata,
                    doctors: [...archive.metadata.doctors],
                    createdAt: new Date(archive.metadata.createdAt),
                    publishedAt: archive.metadata.publishedAt
                        ? new Date(archive.metadata.publishedAt)
                        : null,
                    finalizedAt: archive.metadata.finalizedAt
                        ? new Date(archive.metadata.finalizedAt)
                        : null,
                }))
                .filter((archive) => archive.publishedAt)
                .sort((left, right) => (
                    right.publishedAt.getTime()
                    - left.publishedAt.getTime()
                ));
        },

        async getArchiveChanges(archiveId) {
            const archive = _scheduleArchives[archiveId];
            if (!archive) return [];
            return Object.entries(archive.changes)
                .map(([id, change]) => ({
                    id,
                    ...change,
                    editedAt: new Date(change.editedAt),
                    changes: change.changes.map(
                        (entry) => ({ ...entry })
                    ),
                }))
                .sort((left, right) => (
                    left.editedAt.getTime() - right.editedAt.getTime()
                    || left.id.localeCompare(right.id)
                ));
        },

        async getArchiveSchedule(archiveId, snapshot) {
            if (!['original', 'final'].includes(snapshot)) {
                throw new Error(
                    'Archive snapshot must be original or final.'
                );
            }
            const archive = _scheduleArchives[archiveId];
            if (!archive) return [];
            return Object.values(archive[snapshot])
                .map((entry) => ({ ...entry }))
                .sort((left, right) => left.date.localeCompare(right.date));
        },

        async getTodaySchedule(dateISO) {
            return _schedule[dateISO] ? (await decorateMockBackups([_schedule[dateISO]]))[0] : null;
        },

        async getScheduleRange(startDate, endDate) {
            return decorateMockBackups(Object.values(_schedule)
                .filter(s => s.date >= startDate && s.date <= endDate)
                .map(s => ({ ...s }))
                .sort((a, b) => a.date.localeCompare(b.date)));
        },

        async getScheduleRangeFromServer(startDate, endDate) {
            return this.getScheduleRange(startDate, endDate);
        },
    };
}

function createFirestoreDb(db, auth) {
    let lastBackupId = null;
    async function decorateWithBackups(entries) {
        try {
            const { doc, getDoc } = await fs();
            const pointer = await getDoc(doc(db, 'backupMeta', 'current'));
            const id = pointer.exists() ? pointer.data().snapshotId : null;
            lastBackupId = id;
            const snapshot = id ? await getDoc(doc(db, 'backupSchedules', id)) : null;
            const { attachBackups } = await import('./backup-helpers.mjs');
            return attachBackups(entries, snapshot?.exists() ? snapshot.data() : null);
        } catch (error) {
            console.warn('[Backup] Unable to load backups:', error);
            return entries.map(entry => ({ ...entry, backupDoctor: null, backupStatus: 'unavailable' }));
        }
    }
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

    function builderPayloadFor(kind, payload) {
        const source = payload || {};
        const result = kind === 'swap'
            ? {
                shiftType: source.shiftType,
                datesA: source.datesA,
                doctorA: source.doctorA,
                datesB: source.datesB,
                doctorB: source.doctorB,
            }
            : {
                shiftType: source.shiftType,
                dates: source.dates,
                fromDoctor: source.fromDoctor,
                toDoctor: source.toDoctor,
            };
        if (Object.prototype.hasOwnProperty.call(
                source, 'allowSameDayConflict')) {
            result.allowSameDayConflict = source.allowSameDayConflict;
        }
        return result;
    }

    async function applyFirestoreChange(kind, payload) {
        const {
            collection,
            doc: fsDoc,
            runTransaction,
            serverTimestamp,
        } = await fs();
        const changeId = fsDoc(collection(db, 'scheduleArchives')).id;
        const requestedDates = candidateActionDates(
            payload,
            kind === 'swap' ? ['datesA', 'datesB'] : ['dates']
        );
        const editedBy = auth.currentUser?.email || payload?.editBy || '';
        const builderPayload = builderPayloadFor(kind, payload);
        const metaRef = fsDoc(db, 'scheduleMeta', 'current');

        try {
            const transactionResult = await runTransaction(
                db,
                async (tx) => {
                    const metaSnapshot = await tx.get(metaRef);
                    const meta = metaSnapshot.exists()
                        ? metaSnapshot.data()
                        : null;
                    const archiveId = meta?.activeArchiveId;
                    if (!archiveId) {
                        throw new Error(HISTORY_MIGRATION_MESSAGE);
                    }

                    const scheduleRefs = requestedDates.map(
                        (date) => fsDoc(db, 'schedule', date)
                    );
                    const scheduleSnapshots = await Promise.all(
                        scheduleRefs.map((reference) => tx.get(reference))
                    );
                    const scheduleByDate = {};
                    scheduleSnapshots.forEach((snapshot, index) => {
                        if (snapshot.exists()) {
                            scheduleByDate[requestedDates[index]] =
                                snapshot.data();
                        }
                    });

                    const editedAt = serverTimestamp();
                    const build = kind === 'swap'
                        ? buildSwapChange
                        : buildReassignChange;
                    const result = build({
                        archiveId,
                        changeId,
                        editedBy,
                        editedAt,
                        payload: builderPayload,
                        scheduleByDate,
                    });
                    const changeRef = fsDoc(
                        db,
                        'scheduleArchives',
                        archiveId,
                        'changes',
                        changeId
                    );

                    tx.set(changeRef, result.changeDocument);
                    for (const [date, update] of Object.entries(
                            result.liveUpdates)) {
                        tx.update(
                            fsDoc(db, 'schedule', date),
                            update
                        );
                    }
                    tx.update(metaRef, {
                        publishedAt: editedAt,
                        lastChangeId: changeId,
                    });
                    return { conflicts: result.conflicts };
                }
            );
            return {
                changeId,
                conflicts: transactionResult.conflicts,
            };
        } catch (error) {
            if (error.code === 'unavailable'
                    || error.code === 'failed-precondition') {
                const action = kind === 'swap'
                    ? 'swap'
                    : 'reassignment';
                throw new Error(
                    'Connection lost \u2014 ' + action
                    + ' was not applied. Reconnect and try again.'
                );
            }
            throw error;
        }
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
                        publishedAt: timestampToDate(data.publishedAt),
                        lastFullPublishAt: timestampToDate(
                            data.lastFullPublishAt
                        ),
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
            return applyFirestoreChange('swap', swap);
        },

        // --- Reassign (one-way override) ---
        async applyCallReassign(payload) {
            return applyFirestoreChange('reassign', payload);
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
            const snap = await getDoc(doc(db, 'scheduleMeta', 'current'));
            if (!snap.exists()) return null;
            const data = snap.data();
            return {
                ...data,
                publishedAt: timestampToDate(data.publishedAt),
                lastFullPublishAt: timestampToDate(
                    data.lastFullPublishAt
                ),
            };
        },
        async getScheduleArchives() {
            const { collection, getDocs } = await fs();
            const snapshots = await getDocs(
                collection(db, 'scheduleArchives')
            );
            return snapshots.docs
                .map((snapshot) => {
                    const data = snapshot.data();
                    return {
                        id: snapshot.id,
                        ...data,
                        createdAt: timestampToDate(data.createdAt),
                        publishedAt: timestampToDate(data.publishedAt),
                        finalizedAt: timestampToDate(data.finalizedAt),
                    };
                })
                .filter((archive) => archive.publishedAt)
                .sort((left, right) => (
                    right.publishedAt.getTime()
                    - left.publishedAt.getTime()
                    || right.id.localeCompare(left.id)
                ));
        },

        async getArchiveChanges(archiveId) {
            const { collection, getDocs } = await fs();
            const snapshots = await getDocs(collection(
                db,
                'scheduleArchives',
                archiveId,
                'changes'
            ));
            return snapshots.docs
                .map((snapshot) => {
                    const data = snapshot.data();
                    return {
                        id: snapshot.id,
                        ...data,
                        editedAt: timestampToDate(data.editedAt),
                    };
                })
                .sort((left, right) => (
                    left.editedAt.getTime() - right.editedAt.getTime()
                    || left.id.localeCompare(right.id)
                ));
        },

        async getArchiveSchedule(archiveId, snapshot) {
            if (!['original', 'final'].includes(snapshot)) {
                throw new Error(
                    'Archive snapshot must be original or final.'
                );
            }
            const { collection, getDocs } = await fs();
            const snapshots = await getDocs(collection(
                db,
                'scheduleArchives',
                archiveId,
                snapshot
            ));
            return snapshots.docs
                .map((document) => document.data())
                .sort((left, right) => left.date.localeCompare(right.date));
        },

        async getTodaySchedule(dateISO) {
            const { doc, getDoc } = await fs();
            const snap = await getDoc(doc(db, "schedule", dateISO));
            if (!snap.exists()) return null;
            return (await decorateWithBackups([snap.data()]))[0];
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
            return decorateWithBackups(snap.docs.map(d => d.data()));
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
            return decorateWithBackups(snap.docs.map(d => d.data()));
        },
        onBackupMetaChange(callback) {
            let unsubscribe = null;
            let cancelled = false;
            fs().then(({ doc, onSnapshot }) => {
                if (cancelled) return;
                unsubscribe = onSnapshot(doc(db, 'backupMeta', 'current'), snap => {
                    const id = snap.exists() ? snap.data().snapshotId : null;
                    if (id !== lastBackupId) {
                        lastBackupId = id;
                        callback();
                    }
                }, error => console.warn('[Backup] Listener unavailable:', error));
            });
            return () => { cancelled = true; if (unsubscribe) unsubscribe(); };
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

export { createMockDb, initDb };
