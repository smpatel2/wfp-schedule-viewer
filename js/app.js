/**
 * WFP On-Call Schedule Viewer
 * Main application logic using Alpine.js
 */

/** Fixed 10-color palette for doctor assignments */
const DOCTOR_COLORS = [
    '#2563EB', '#DC2626', '#059669', '#D97706', '#7C3AED',
    '#DB2777', '#0891B2', '#65A30D', '#EA580C', '#4F46E5'
];

const FALLBACK_COLOR = '#6B7280'; // gray-500

/** Clinic timezone for "today" calculation */
const CLINIC_TIMEZONE = 'America/Chicago';

/**
 * Get today's date as ISO string in the clinic's timezone.
 * Uses Intl.DateTimeFormat to avoid local timezone issues.
 */
function getClinicToday() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: CLINIC_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);

    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${d}`;
}

/**
 * Get the next Saturday (or today if today is Saturday) as ISO string.
 */
function getNextSaturday(todayISO) {
    const d = new Date(todayISO + 'T12:00:00');
    const dow = d.getDay();
    const daysUntilSat = dow === 6 ? 0 : (6 - dow);
    d.setDate(d.getDate() + daysUntilSat);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Get the first day of the month for a given ISO date.
 */
function startOfMonth(dateISO) {
    return dateISO.substring(0, 8) + '01';
}

/** Add n days to a Date and return a new Date. */
function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
}

/** Format a Date as YYYY-MM-DD in local time (matches scheduleData keys). */
function toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * HTML-escape a string for safe insertion into innerHTML / insertAdjacentHTML.
 * Any schedule field rendered into a template-literal HTML string MUST pass
 * through this — admin writes are limited to 64 chars but otherwise arbitrary,
 * and a direct devtools write like `<img src=x onerror=...>` would otherwise
 * execute for every viewer. The server-side rule also requires doctor names
 * to match /doctors/{name}, but client-side escaping is the belt-and-braces
 * defense and costs nothing. Also covers `holiday` since admin-SDK-authored
 * holiday text isn't guaranteed to be HTML-safe either.
 */
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[c]));
}

/**
 * Thrown when a tapped calendar cell cannot participate in a swap —
 * e.g. it's closed, unassigned, or has no published entry.
 * The tap handler catches this and shows a toast; it never surfaces to the user
 * as an unhandled rejection.
 */
class UnswappableTap extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnswappableTap';
    }
}

/**
 * Detect whether dateStr is part of a same-doctor Fri/Sat/Sun weekend block.
 * Returns { dates: [isoFri, isoSat, isoSun], doctor } or null.
 *
 * Returns null (no block offered) when:
 *  - The date is not a Fri/Sat/Sun
 *  - Any of the three docs is missing from scheduleData
 *  - The callDoctor across the three days doesn't match
 *  - The Friday's callDoctor is empty/Closed (nothing to swap)
 */
function detectWeekendBlock(dateStr, scheduleData) {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = d.getDay();               // 0=Sun..6=Sat
    if (dow !== 5 && dow !== 6 && dow !== 0) return null;

    // Find the Friday anchoring this block
    const friday = new Date(d);
    friday.setDate(d.getDate() - ((dow + 2) % 7));
    const isoFri = toISO(friday);
    const isoSat = toISO(addDays(friday, 1));
    const isoSun = toISO(addDays(friday, 2));

    const fri = scheduleData[isoFri];
    const sat = scheduleData[isoSat];
    const sun = scheduleData[isoSun];
    if (!fri || !sat || !sun) return null;

    const CLOSED_VALUES = ['', 'Closed'];
    if (CLOSED_VALUES.includes(fri.callDoctor)) return null;

    if (fri.callDoctor === sat.callDoctor && sat.callDoctor === sun.callDoctor) {
        return { dates: [isoFri, isoSat, isoSun], doctor: fri.callDoctor };
    }
    return null;
}

function app() {
    return {
        // --- Auth State ---
        authenticated: false,
        doctorName: '',
        doctors: [],
        doctorEmailMap: {},
        password: '',
        showPassword: false,
        loginError: '',
        loginLoading: false,

        // --- Admin Login Mode ---
        adminLoginMode: false,
        adminEmail: '',

        // --- Today Card ---
        todayData: null,
        scheduleMeta: null,
        nextSaturdayData: null,

        // --- Calendar ---
        calendar: null,
        scheduleData: {},
        cellHtmlCache: {},

        // --- Doctor Colors ---
        doctorClassMap: {},

        // --- Filter ---
        myCallsFilter: false,

        // --- ICS Download ---
        icsDownloading: false,

        // --- Admin Mode ---
        adminMode: false,

        // --- Edit Mode (admin only) ---
        editMode: false,
        swapSelection: { a: null, b: null }, // { shiftType, dates, doctor }
        swapApplying: false,

        // --- Holidays Modal ---
        holidaysModalVisible: false,

        // --- Disambiguation Modal ---
        modalVisible: false,
        modalType: null,          // 'clinic-or-call' | 'block-or-single'
        modalBlockInfo: null,     // { dates, doctor } for block-or-single
        _modalResolve: null,

        // --- Toast ---
        toastMessage: '',
        toastVisible: false,
        _toastTimer: null,

        // --- Live Listener ---
        _metaUnsub: null,

        // --- Config ---
        mockMode: false,

        // --- Lifecycle ---
        async init() {
            while (!window._dbReady) {
                await new Promise(r => setTimeout(r, 50));
            }
            await window._dbReady;

            if (window.db && window.db._mock) {
                this.mockMode = true;
            }

            try {
                const docs = await window.db.getDoctors();
                this.doctors = docs;
                this.doctorEmailMap = Object.fromEntries(docs.map(d => [d.name, d.email]));
                this._buildDoctorColorMap(docs);
            } catch (e) {
                console.error("[Schedule] Failed to load doctors:", e);
            }

            const alpine = this;
            window.db.onAuthChanged(async (user) => {
                if (!user) {
                    // Teardown live listener and edit state on sign-out
                    if (alpine._metaUnsub) { alpine._metaUnsub(); alpine._metaUnsub = null; }
                    if (alpine.calendar) { alpine.calendar.destroy(); alpine.calendar = null; }
                    alpine.authenticated = false;
                    alpine.adminMode = false;
                    alpine.doctorName = '';
                    alpine.todayData = null;
                    alpine.scheduleMeta = null;
                    alpine.nextSaturdayData = null;
                    alpine.scheduleData = {};
                    alpine.cellHtmlCache = {};
                    alpine.myCallsFilter = false;
                    alpine.icsDownloading = false;
                    alpine.editMode = false;
                    alpine.swapSelection = { a: null, b: null };
                    alpine.holidaysModalVisible = false;
                    document.body.classList.remove('edit-mode');
                    sessionStorage.removeItem('schedule_viewer_doctor');
                    return;
                }

                const email = user.email.toLowerCase();
                const doctorEntry = alpine.doctors.find(d => d.email.toLowerCase() === email);
                const adminFlag = await window.db.isAdmin(email);

                if (adminFlag && !doctorEntry) {
                    // Admin-only account — no today cards, no My Calls, just edit calendar
                    alpine.adminMode = true;
                    alpine.doctorName = '';
                    alpine.authenticated = true;
                    await alpine.loadAdminView();
                } else if (doctorEntry) {
                    // Normal doctor account
                    alpine.adminMode = false;
                    alpine.doctorName = doctorEntry.name;
                    alpine.authenticated = true;
                    sessionStorage.setItem('schedule_viewer_doctor', doctorEntry.name);
                    alpine.loadTodayData().then(() => {
                        setTimeout(() => alpine.loadScheduleAndInitCalendar(), 0);
                    });
                } else {
                    // Email not in /doctors and not in /admins — reject
                    await window.db.signOut();
                    alpine.loginError = 'Account not recognized. Contact the administrator.';
                }
            });
        },

        // --- Doctor Color Map ---
        _buildDoctorColorMap(doctors) {
            this.doctorClassMap = {};
            const sorted = [...doctors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            sorted.forEach((doc, i) => {
                this.doctorClassMap[doc.name] = `doc-color-${i}`;
            });

            // Inject dynamic <style> for doctor color classes
            let style = document.getElementById('doctor-color-styles');
            if (!style) {
                style = document.createElement('style');
                style.id = 'doctor-color-styles';
                document.head.appendChild(style);
            }
            const rules = sorted.map((_, i) => {
                const color = DOCTOR_COLORS[i % DOCTOR_COLORS.length];
                return `.doc-color-${i} { --doc-color: ${color}; }`;
            }).join('\n');
            style.textContent = rules;
        },

        getDoctorColorClass(name) {
            return this.doctorClassMap[name] || '';
        },

        getDoctorColor(name) {
            const cls = this.doctorClassMap[name];
            if (!cls) return FALLBACK_COLOR;
            const idx = parseInt(cls.replace('doc-color-', ''), 10);
            return DOCTOR_COLORS[idx % DOCTOR_COLORS.length] || FALLBACK_COLOR;
        },

        // --- Auth Methods ---
        async login() {
            this.loginError = '';
            this.loginLoading = true;

            try {
                let email;
                if (this.adminLoginMode) {
                    if (!this.adminEmail) {
                        this.loginError = 'Please enter your administrator email.';
                        return;
                    }
                    email = this.adminEmail.trim();
                } else {
                    if (!this.doctorName) {
                        this.loginError = 'Please select your name.';
                        return;
                    }
                    email = this.doctorEmailMap[this.doctorName];
                    if (!email) {
                        this.loginError = 'Doctor not found. Contact the administrator.';
                        return;
                    }
                }

                if (!this.password) {
                    this.loginError = 'Please enter the practice password.';
                    return;
                }

                await window.db.signIn(email, this.password);
                this.password = '';
                this.loginError = '';
            } catch (e) {
                const code = e.code || '';
                if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') {
                    this.loginError = 'Incorrect password. Please try again.';
                } else if (code === 'auth/user-not-found') {
                    this.loginError = 'Account not found. Contact the administrator.';
                } else if (code === 'auth/too-many-requests') {
                    this.loginError = 'Too many attempts. Please wait and try again.';
                } else {
                    this.loginError = 'Login failed. Please try again.';
                }
                this.password = '';
            } finally {
                this.loginLoading = false;
            }
        },

        async logout() {
            if (this._metaUnsub) { this._metaUnsub(); this._metaUnsub = null; }
            this.editMode = false;
            this.swapSelection = { a: null, b: null };
            document.body.classList.remove('edit-mode');
            await window.db.signOut();
            this.password = '';
            if (this.calendar) {
                this.calendar.destroy();
                this.calendar = null;
            }
            this.todayData = null;
            this.scheduleMeta = null;
            this.nextSaturdayData = null;
            this.scheduleData = {};
            this.cellHtmlCache = {};
            this.myCallsFilter = false;
            this.icsDownloading = false;
        },

        // --- My Calls Filter ---
        toggleMyCallsFilter() {
            this.myCallsFilter = !this.myCallsFilter;
            this.applyFilter();
        },

        applyFilter() {
            const cells = document.querySelectorAll('.fc-daygrid-day');
            cells.forEach(cell => {
                const dateStr = cell.dataset.date;
                if (!dateStr || !this.myCallsFilter) {
                    cell.classList.remove('fc-day-filtered');
                    return;
                }
                const entry = this.scheduleData[dateStr];
                const isMyDay = entry && (
                    entry.callDoctor === this.doctorName ||
                    entry.clinicDoctor === this.doctorName
                );
                cell.classList.toggle('fc-day-filtered', !isMyDay);
            });
        },

        // --- ICS Download ---
        _calendarDays(startISO, endISO) {
            const start = new Date(startISO + 'T12:00:00');
            const end = new Date(endISO + 'T12:00:00');
            return Math.round((end - start) / 86400000) + 1;
        },

        _expectedDocCount() {
            if (typeof this.scheduleMeta?.dayCount === 'number') {
                return this.scheduleMeta.dayCount;
            }
            return this._calendarDays(this.scheduleMeta.startDate, this.scheduleMeta.endDate);
        },

        async downloadMyICS() {
            if (!this.doctorName || !this.scheduleMeta || this.scheduleExpired) return;
            if (this.icsDownloading) return;

            this.icsDownloading = true;
            try {
                const requestedStart = this.scheduleMeta.startDate;
                const requestedEnd = this.scheduleMeta.endDate;

                let entries;
                let degradedFromServer = false;
                try {
                    entries = await window.db.getScheduleRangeFromServer(requestedStart, requestedEnd);
                } catch (e) {
                    const offline = e?.code === 'unavailable' ||
                        e?.code === 'failed-precondition' ||
                        (typeof navigator !== 'undefined' && navigator.onLine === false);
                    if (!offline) throw e;

                    entries = await window.db.getScheduleRange(requestedStart, requestedEnd);
                    degradedFromServer = true;
                }

                if (!entries || entries.length === 0) {
                    this.showToast(
                        degradedFromServer
                            ? 'Offline - no cached schedule available. Reconnect and try again.'
                            : 'No published schedule entries found. Try again in a moment.'
                    );
                    return;
                }

                const expectedDocs = this._expectedDocCount();
                const partial = entries.length < expectedDocs;
                const actualStart = entries[0].date;
                const actualEnd = entries[entries.length - 1].date;

                const { buildPersonalICS } = await import('./ics.js');
                const ics = buildPersonalICS(entries, this.doctorName);

                const safeName = this.doctorName.replace(/[^A-Za-z0-9_-]/g, '_');
                const partialTag = partial ? '_PARTIAL' : '';
                const filename = `WFP_OnCall_${safeName}_${actualStart}_to_${actualEnd}${partialTag}.ics`;

                const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);

                if (partial) {
                    const fmt = iso => new Date(iso + 'T12:00:00')
                        .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    this.showToast(
                        `Partial download (${fmt(actualStart)}-${fmt(actualEnd)} of ` +
                        `${fmt(requestedStart)}-${fmt(requestedEnd)}). ` +
                        'Reconnect and tap again for the full range.',
                        { duration: 8000 }
                    );
                } else {
                    this.showToast('Schedule downloaded. Open the file to add events to your calendar.');
                }
            } catch (e) {
                console.error('[ICS] Download failed:', e);
                this.showToast('Download failed. Please try again.');
            } finally {
                this.icsDownloading = false;
            }
        },

        // --- Today Card ---
        async loadTodayData() {
            try {
                this.scheduleMeta = await window.db.getScheduleMeta();

                const todayISO = this.mockMode ? "2026-07-08" : getClinicToday();
                this.todayData = await window.db.getTodaySchedule(todayISO);

                // Load next Saturday for clinic info
                const satISO = this.mockMode ? "2026-07-11" : getNextSaturday(todayISO);
                if (satISO !== todayISO) {
                    this.nextSaturdayData = await window.db.getTodaySchedule(satISO);
                } else {
                    this.nextSaturdayData = null; // Today IS Saturday, clinic info is in todayData
                }
            } catch (e) {
                console.error("[Schedule] Failed to load today data:", e);
            }
        },

        /** Formatted "today" for display */
        get todayDisplay() {
            if (!this.todayData) return '';
            const d = new Date(this.todayData.date + 'T12:00:00');
            return d.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
            });
        },

        /** Formatted "last updated" from scheduleMeta */
        get lastUpdated() {
            if (!this.scheduleMeta || !this.scheduleMeta.publishedAt) return '';
            const d = this.scheduleMeta.publishedAt;
            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        },

        /** Today's ISO date string, timezone-aware */
        get todayISO() {
            return this.mockMode ? "2026-07-08" : getClinicToday();
        },

        /** Whether today is outside the published schedule range */
        get todayOutOfRange() {
            if (!this.scheduleMeta) return true;
            if (
                this.todayISO < this.scheduleMeta.startDate &&
                this.todayData?.date === this.todayISO
            ) {
                return false;
            }
            return this.todayISO < this.scheduleMeta.startDate || this.todayISO > this.scheduleMeta.endDate;
        },

        /** Whether the published schedule has expired (endDate is in the past) */
        get scheduleExpired() {
            if (!this.scheduleMeta) return false;
            return this.scheduleMeta.endDate < this.todayISO;
        },

        /** Whether the schedule hasn't started yet (startDate is in the future) */
        get scheduleNotStarted() {
            if (!this.scheduleMeta) return false;
            return !this.todayData && this.scheduleMeta.startDate > this.todayISO;
        },

        /** Clinic doctor text for the next Saturday */
        get clinicSaturdayText() {
            if (this.todayData && this.todayData.day === 'Saturday') {
                return this.todayData.clinicDoctor || '';
            }
            if (this.nextSaturdayData) {
                return this.nextSaturdayData.clinicDoctor || '';
            }
            return '';
        },

        /** On-call doctor text for the next Saturday */
        get callSaturdayText() {
            if (this.todayData && this.todayData.day === 'Saturday') {
                return this.todayData.callDoctor || '';
            }
            if (this.nextSaturdayData) {
                return this.nextSaturdayData.callDoctor || '';
            }
            return '';
        },

        get clinicSaturdayDate() {
            if (this.todayData && this.todayData.day === 'Saturday') {
                return this.todayData.date;
            }
            if (this.nextSaturdayData) {
                return this.nextSaturdayData.date;
            }
            return '';
        },

        /** Formatted Saturday date for display */
        get saturdayDisplay() {
            const dateStr = this.clinicSaturdayDate;
            if (!dateStr) return '';
            const d = new Date(dateStr + 'T12:00:00');
            return d.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
            });
        },

        // --- Range Helper (shared between doctor and admin views) ---
        /**
         * Returns { rangeStart, rangeEnd } for fetching schedule docs.
         * Applies a weekend-block boundary fix: if the 1st of the current
         * month is Sat or Sun, rewinds rangeStart by 1–2 days so that
         * detectWeekendBlock() can see the full Fri/Sat/Sun triple for a
         * block that straddles the month boundary.
         */
        _computeHydrateRange() {
            const todayISO = this.mockMode ? "2026-07-01" : getClinicToday();
            let calStart = startOfMonth(todayISO);

            // If the 1st falls on Sat (6) or Sun (0), rewind to include the
            // block's Friday so detectWeekendBlock gets all three docs.
            const calStartDow = new Date(calStart + 'T12:00:00').getDay();
            if (calStartDow === 6) {
                calStart = toISO(addDays(new Date(calStart + 'T12:00:00'), -1));
            } else if (calStartDow === 0) {
                calStart = toISO(addDays(new Date(calStart + 'T12:00:00'), -2));
            }

            return { rangeStart: calStart, rangeEnd: this.scheduleMeta.endDate };
        },

        // --- Calendar (Doctor View) ---
        async loadScheduleAndInitCalendar() {
            // Attach the meta listener on every early-return path so a doctor
            // tab that loads with no schedule (or an expired one) still picks
            // up a fresh publish without a manual reload. Symmetric with
            // loadAdminView's empty-state handling.
            if (!this.scheduleMeta) {
                this._attachMetaListener();
                return;
            }

            const todayISO = this.mockMode ? "2026-07-01" : getClinicToday();

            // Don't init calendar if schedule is entirely in the past, but
            // still attach the listener — when a new schedule publishes and
            // bumps publishedAt, refreshSchedule() will re-fetch scheduleMeta,
            // see the new range, and hydrate the calendar.
            if (this.scheduleMeta.endDate < todayISO) {
                this._attachMetaListener();
                return;
            }

            const { rangeStart, rangeEnd } = this._computeHydrateRange();

            try {
                const entries = await window.db.getScheduleRange(rangeStart, rangeEnd);
                this.scheduleData = {};
                for (const entry of entries) {
                    this.scheduleData[entry.date] = entry;
                }
                this.buildCellHtmlCache();
                await this.initCalendar();
                this._attachMetaListener();
            } catch (e) {
                console.error("[Schedule] Failed to load schedule data:", e);
            }
        },

        // --- Calendar (Admin View) ---
        async loadAdminView() {
            if (!window.db) await window._dbReady;
            try {
                this.scheduleMeta = await window.db.getScheduleMeta();
                const todayISO = this.mockMode ? "2026-07-01" : getClinicToday();

                // No schedule, or the published schedule is entirely in the
                // past — render the appropriate empty/expired state instead
                // of a calendar (otherwise _computeHydrateRange would produce
                // an inverted range and we'd mount a blank calendar). The
                // listener stays attached so a fresh publish wakes the tab.
                if (!this.scheduleMeta || this.scheduleMeta.endDate < todayISO) {
                    this._attachMetaListener();
                    return;
                }

                const { rangeStart, rangeEnd } = this._computeHydrateRange();
                const entries = await window.db.getScheduleRange(rangeStart, rangeEnd);
                this.scheduleData = {};
                for (const entry of entries) {
                    this.scheduleData[entry.date] = entry;
                }
                this.buildCellHtmlCache();
                await this.initCalendar();
                this._attachMetaListener();
            } catch (e) {
                console.error('[Admin] loadAdminView failed:', e);
            }
        },

        // --- Refresh (re-hydrate + rebuild, called by meta listener) ---
        async refreshSchedule() {
            if (!this.authenticated) return;
            try {
                this.scheduleMeta = await window.db.getScheduleMeta();
                if (!this.scheduleMeta) return;

                const todayISO = this.mockMode ? "2026-07-01" : getClinicToday();

                // If the schedule is now entirely in the past — e.g. an admin
                // tab sat past endDate, or a republish narrowed the range —
                // tear down any stale calendar and clear the cell cache. The
                // x-show'd expired-state messaging will surface via Alpine
                // binding on `scheduleExpired`.
                if (this.scheduleMeta.endDate < todayISO) {
                    if (this.calendar) {
                        this.calendar.destroy();
                        this.calendar = null;
                    }
                    this.scheduleData = {};
                    this.cellHtmlCache = {};
                    return;
                }

                const { rangeStart, rangeEnd } = this._computeHydrateRange();
                const entries = await window.db.getScheduleRange(rangeStart, rangeEnd);
                this.scheduleData = {};
                for (const entry of entries) {
                    this.scheduleData[entry.date] = entry;
                }
                this.buildCellHtmlCache();

                if (this.calendar) {
                    this.calendar.destroy();
                    this.calendar = null;
                }
                await this.initCalendar();

                // Doctor mode also refreshes today card
                if (!this.adminMode && this.doctorName) {
                    await this.loadTodayData();
                }
            } catch (e) {
                console.error('[Schedule] refreshSchedule failed:', e);
            }
        },

        // --- Live Listener ---
        /**
         * Attach a Firestore onSnapshot listener on scheduleMeta/current.
         * Calls refreshSchedule() when publishedAt advances.
         * Guards against stale selections: clears swapSelection if edit mode
         * is active when an external update arrives.
         */
        _attachMetaListener() {
            if (this._metaUnsub) this._metaUnsub();
            const alpine = this;

            this._metaUnsub = window.db.onScheduleMetaChange((meta) => {
                if (!meta.publishedAt) return;

                // Case 1: admin on empty-state tab, schedule just published
                if (!alpine.scheduleMeta) {
                    alpine.refreshSchedule();
                    return;
                }

                // Case 2: normal update — only act when incoming is newer
                const current  = alpine.scheduleMeta.publishedAt?.getTime?.() ?? 0;
                const incoming = meta.publishedAt instanceof Date
                    ? meta.publishedAt.getTime()
                    : new Date(meta.publishedAt).getTime();
                if (incoming <= current) return;

                // Clear any in-progress edit state so the rebuilt calendar
                // doesn't inherit stale references to pre-refresh scheduleData.
                // Three things can be in-flight when an external update lands:
                //   1. An open disambiguation modal whose Promise hasn't resolved
                //      yet — dismissing with null lets the awaiting tap handler
                //      bail cleanly instead of resuming with stale `entry` data
                //      after the rebuild.
                //   2. A `.selected-a` highlight + populated swapSelection.a
                //      whose `.dates`/`.doctor` may no longer match Firestore.
                //   3. Both at once (admin mid-second-tap modal).
                // Toast once if any of these were active.
                if (alpine.editMode) {
                    const hadPendingState = alpine.modalVisible || !!alpine.swapSelection?.a;
                    if (alpine.modalVisible) {
                        alpine.dismissModal(null);   // resolves pending Promise → handler returns
                    }
                    if (alpine.swapSelection?.a) {
                        alpine.clearSwapSelection();
                    }
                    if (hadPendingState) {
                        alpine.showToast('Schedule updated — selection cleared.');
                    }
                }

                alpine.refreshSchedule();
            });
        },

        buildCellHtmlCache() {
            this.cellHtmlCache = {};
            for (const [dateStr, entry] of Object.entries(this.scheduleData)) {
                let html = '';

                // Holiday pill
                if (entry.holiday) {
                    const shortName = this.holidayShortNames[entry.holiday] || entry.holiday;
                    html += `<div class="holiday-pill">${esc(shortName)}</div>`;
                }

                // Call doctor pill
                if (entry.callDoctor) {
                    const cls = this.getDoctorColorClass(entry.callDoctor);
                    html += `<div class="doctor-name-pill ${cls}">${esc(entry.callDoctor)}</div>`;
                }

                // Clinic doctor (Saturdays only, skip "Closed")
                if (entry.clinicDoctor && entry.clinicDoctor !== 'Closed' && entry.clinicDoctor !== '') {
                    const cls = this.getDoctorColorClass(entry.clinicDoctor);
                    html += `<div class="clinic-doctor-pill ${cls}"><span class="clinic-label">Clinic: </span>${esc(entry.clinicDoctor)}</div>`;
                }

                this.cellHtmlCache[dateStr] = html;
            }
        },

        holidayShortNames: {
            "Independence Day": "July 4th",
            "Thanksgiving Day": "Thanksgiving",
            "New Year's Day": "New Year's",
            "Christmas Day": "Christmas",
        },

        async initCalendar() {
            if (this.calendar) return;

            // Wait for calendar element to be in DOM
            await new Promise(resolve => {
                const check = () => {
                    const el = document.getElementById('calendar-el');
                    if (el && el.offsetWidth > 0) resolve();
                    else requestAnimationFrame(check);
                };
                check();
            });

            const todayISO = this.mockMode ? "2026-07-01" : getClinicToday();

            const alpine = this;

            this.calendar = new FullCalendar.Calendar(document.getElementById('calendar-el'), {
                initialView: 'multiMonthYear',
                initialDate: todayISO,
                headerToolbar: false,
                height: 'auto',
                multiMonthMaxColumns: 1,
                fixedWeekCount: false,
                // Note: validRange is intentionally omitted — FullCalendar 6.1.15
                // crashes with multiMonthYear + validRange on sub-year ranges.
                // Note: dayCellContent hook also crashes with multiMonthYear in 6.1.15.
                // Using dayCellDidMount instead to inject precomputed HTML into cells.

                // Read-only — disable all interaction
                selectable: false,
                editable: false,
                navLinks: false,
                eventStartEditable: false,
                eventDurationEditable: false,

                // Inject precomputed cell HTML after mount
                dayCellDidMount: function(arg) {
                    const d = arg.date;
                    const y = d.getFullYear();
                    const m = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    const dateStr = `${y}-${m}-${day}`;

                    const cached = alpine.cellHtmlCache[dateStr];
                    if (cached) {
                        const container = arg.el.querySelector('.fc-daygrid-day-events') ||
                                          arg.el.querySelector('.fc-daygrid-day-frame');
                        if (container) {
                            container.insertAdjacentHTML('beforeend', cached);
                        }
                    }

                    // Apply My Calls filter state to newly mounted cells
                    if (alpine.myCallsFilter) {
                        const entry = alpine.scheduleData[dateStr];
                        const isMyDay = entry && (
                            entry.callDoctor === alpine.doctorName ||
                            entry.clinicDoctor === alpine.doctorName
                        );
                        if (!isMyDay) {
                            arg.el.classList.add('fc-day-filtered');
                        }
                    }
                },

                events: [],
            });

            this.calendar.render();

            // Hide month blocks before the current month so the calendar
            // starts at the relevant month without scrolling past the cards.
            setTimeout(() => {
                const todayCell = document.querySelector('.fc-day-today');
                if (!todayCell) return;
                const currentMonth = todayCell.closest('.fc-multimonth-month');
                if (!currentMonth) return;
                let el = currentMonth.previousElementSibling;
                while (el) {
                    if (el.classList.contains('fc-multimonth-month')) {
                        el.style.display = 'none';
                    }
                    el = el.previousElementSibling;
                }
            }, 50);

            // Bind edit-mode click handler using event delegation on the
            // calendar container. Bound once; persists across calendar rebuilds
            // because #calendar-el stays in the DOM when FullCalendar is
            // destroyed and re-created.
            const calEl = document.getElementById('calendar-el');
            if (!calEl._editListenerBound) {
                calEl._editListenerBound = true;
                calEl.addEventListener('click', (e) => {
                    if (!alpine.editMode) return;
                    // Only act on clicks that land on a day cell
                    const cell = e.target.closest('.fc-daygrid-day');
                    if (!cell) return;
                    const dateStr = cell.dataset.date;
                    if (!dateStr) return;

                    if (!alpine.swapSelection.a) {
                        alpine.handleFirstTap(dateStr);
                    } else if (!alpine.swapSelection.b) {
                        alpine.handleSecondTap(dateStr);
                    }
                    // Both slots filled → wait for Apply or Cancel
                });
            }
        },

        // ================================================================
        // ADMIN: EDIT MODE
        // ================================================================

        toggleEditMode() {
            this.editMode = !this.editMode;
            document.body.classList.toggle('edit-mode', this.editMode);
            if (!this.editMode) {
                this.clearSwapSelection();
            }
        },

        clearSwapSelection() {
            document.querySelectorAll('.fc-day-selected-a, .fc-day-selected-b')
                .forEach(el => {
                    el.classList.remove('fc-day-selected-a', 'fc-day-selected-b');
                });
            this.swapSelection = { a: null, b: null };
        },

        _highlightShift(shift, cls) {
            for (const dateStr of shift.dates) {
                const cell = document.querySelector(`.fc-day[data-date="${dateStr}"]`);
                if (cell) cell.classList.add(cls);
            }
        },

        /** Human-readable label for a shift descriptor. */
        _shiftLabel(shift) {
            if (!shift) return '';
            if (shift.dates.length === 1) {
                const d = new Date(shift.dates[0] + 'T12:00:00');
                const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                const typeLabel = shift.shiftType === 'saturday-clinic' ? 'Clinic' : 'Call';
                return `Dr. ${shift.doctor} (${dateLabel} – ${typeLabel})`;
            }
            const start = new Date(shift.dates[0] + 'T12:00:00');
            const end   = new Date(shift.dates[shift.dates.length - 1] + 'T12:00:00');
            const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const endLabel   = end.toLocaleDateString('en-US',   { month: 'short', day: 'numeric' });
            return `Dr. ${shift.doctor} (${startLabel}–${endLabel} – Weekend)`;
        },

        /** Dynamic text for the swap confirm bar. */
        get swapConfirmText() {
            const { a, b } = this.swapSelection;
            if (!a) return '';
            if (!b) return `Selected: ${this._shiftLabel(a)}. Tap another date to swap.`;
            if (a.shiftType !== b.shiftType) {
                const aT = a.shiftType === 'saturday-clinic' ? 'clinic' : 'call';
                const bT = b.shiftType === 'saturday-clinic' ? 'clinic' : 'call';
                return `Type mismatch: first is a ${aT} shift, second is a ${bT} shift. Cancel and try again.`;
            }
            return `Swap ${this._shiftLabel(a)} ↔ ${this._shiftLabel(b)}?`;
        },

        /** True when both shifts are selected but their types don't match. */
        get swapTypeError() {
            const { a, b } = this.swapSelection;
            if (!a || !b) return false;
            return a.shiftType !== b.shiftType;
        },

        /** Label for the weekend block in the disambiguation modal. */
        get modalBlockLabel() {
            if (!this.modalBlockInfo) return '';
            const dates = this.modalBlockInfo.dates;
            if (!dates || dates.length < 3) return '';
            const fmt = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return `${fmt(dates[0])} – ${fmt(dates[2])}`;
        },

        // ================================================================
        // DISAMBIGUATION MODALS
        // ================================================================

        /** Shows the clinic-vs-call picker. Returns 'clinic'|'call'|null. */
        askClinicOrCall() {
            return new Promise(resolve => {
                this.modalType = 'clinic-or-call';
                this.modalBlockInfo = null;
                this.modalVisible = true;
                this._modalResolve = resolve;
            });
        },

        /** Shows the block-vs-single picker. Returns 'block'|'single'|null. */
        askBlockOrSingle(block) {
            return new Promise(resolve => {
                this.modalType = 'block-or-single';
                this.modalBlockInfo = block;
                this.modalVisible = true;
                this._modalResolve = resolve;
            });
        },

        /** Called by modal buttons. `choice` is the answer or null (cancel). */
        dismissModal(choice) {
            this.modalVisible = false;
            const resolve = this._modalResolve;
            this._modalResolve = null;
            this.modalType = null;
            this.modalBlockInfo = null;
            if (resolve) resolve(choice);
        },

        // ================================================================
        // SHIFT RESOLUTION
        // ================================================================

        /**
         * Resolve a tapped date to a shift descriptor.
         * Sequential logic per plan:
         *   1. Saturday with both call+clinic → ask clinic vs call
         *   2. Fri/Sat/Sun in a same-doctor block → ask block vs single
         *   3. Auto-resolve remaining cases
         *
         * Returns { shiftType, dates, doctor } or null (user cancelled modal).
         * Throws UnswappableTap for unswappable cells (caller shows toast).
         */
        async resolveTappedShift(dateStr) {
            const entry = this.scheduleData[dateStr];
            if (!entry) {
                throw new UnswappableTap(
                    `No published schedule entry for ${dateStr} — nothing to swap.`
                );
            }

            const d = new Date(dateStr + 'T12:00:00');
            const isSat = d.getDay() === 6;
            const CLOSED = ['', 'Closed'];
            const isClosed = v => !v || CLOSED.includes(v);

            // Step 1: Saturday with BOTH call + clinic → ask clinic-vs-call first.
            // Clinic pick short-circuits (never a weekend-block swap).
            if (isSat && !isClosed(entry.clinicDoctor) && !isClosed(entry.callDoctor)) {
                const pick = await this.askClinicOrCall();
                if (pick === null) return null;
                if (pick === 'clinic') {
                    return { shiftType: 'saturday-clinic', dates: [dateStr], doctor: entry.clinicDoctor };
                }
                // pick === 'call' → fall through to weekend-block check
            }

            // Step 2: Fri/Sat/Sun inside a same-doctor block → ask block vs single.
            const block = detectWeekendBlock(dateStr, this.scheduleData);
            if (block) {
                const pick = await this.askBlockOrSingle(block);
                if (pick === null) return null;
                if (pick === 'block') {
                    return { shiftType: 'weekend-block', dates: block.dates, doctor: block.doctor };
                }
                // pick === 'single' → fall through to single-day resolution
            }

            // Step 3: Auto-resolve single-day shift.
            if (isSat && isClosed(entry.callDoctor) && !isClosed(entry.clinicDoctor)) {
                return { shiftType: 'saturday-clinic', dates: [dateStr], doctor: entry.clinicDoctor };
            }

            // Final guard: reject closed / unassigned call slots immediately
            // so the admin never reaches Apply with a bad selection.
            if (isClosed(entry.callDoctor)) {
                const bothEmpty = isClosed(entry.clinicDoctor);
                throw new UnswappableTap(
                    bothEmpty
                        ? `${dateStr} has no on-call or clinic assignment — nothing to swap.`
                        : `${dateStr} has no on-call assignment (marked "${entry.callDoctor || 'empty'}"). Nothing to swap.`
                );
            }

            return { shiftType: 'single-call', dates: [dateStr], doctor: entry.callDoctor };
        },

        // ================================================================
        // TAP HANDLERS
        // ================================================================

        async handleFirstTap(dateStr) {
            let shift;
            try {
                shift = await this.resolveTappedShift(dateStr);
            } catch (e) {
                if (e instanceof UnswappableTap) { this.showToast(e.message); return; }
                throw e;
            }
            if (!shift) return; // user cancelled modal — do nothing

            this.clearSwapSelection();
            this.swapSelection = { a: shift, b: null };
            this._highlightShift(shift, 'fc-day-selected-a');
        },

        async handleSecondTap(dateStr) {
            // Reject re-tapping a date already in selection A
            if (this.swapSelection.a && this.swapSelection.a.dates.includes(dateStr)) {
                this.showToast('That date is already selected — tap a different date.');
                return;
            }

            let shift;
            try {
                shift = await this.resolveTappedShift(dateStr);
            } catch (e) {
                if (e instanceof UnswappableTap) { this.showToast(e.message); return; }
                throw e;
            }
            if (!shift) return;

            // Reject shift-type mismatch immediately (show inline via swapConfirmText too)
            if (shift.shiftType !== this.swapSelection.a.shiftType) {
                const aT = this.swapSelection.a.shiftType === 'saturday-clinic' ? 'clinic' : 'call';
                const bT = shift.shiftType === 'saturday-clinic' ? 'clinic' : 'call';
                this.showToast(`Type mismatch: first is a ${aT} shift, this is a ${bT} shift.`);
                return;
            }

            this.swapSelection = { a: this.swapSelection.a, b: shift };
            this._highlightShift(shift, 'fc-day-selected-b');
        },

        // ================================================================
        // APPLY SWAP
        // ================================================================

        buildSwapPayload() {
            const { a, b } = this.swapSelection;
            if (!a || !b) return null;
            return {
                shiftType: a.shiftType,
                datesA: a.dates,
                doctorA: a.doctor,
                datesB: b.dates,
                doctorB: b.doctor,
            };
        },

        async applySelectedSwap() {
            const swap = this.buildSwapPayload();
            if (!swap) return;
            this.swapApplying = true;
            try {
                await window.db.applyCallSwap(swap);
                this.showToast('Swap applied');
                this.clearSwapSelection();
                // Do NOT call refreshSchedule() here — the transaction bumped
                // scheduleMeta.publishedAt so the onScheduleMetaChange listener
                // will fire and rebuild the calendar exactly once.
            } catch (e) {
                this.showToast(e.message || 'Swap failed. Please try again.');
                this.clearSwapSelection();
                // On failure no publishedAt bump happened, so the listener won't
                // fire. Explicitly resync to authoritative Firestore state.
                await this.refreshSchedule();
            } finally {
                this.swapApplying = false;
            }
        },

        // ================================================================
        // TOAST
        // ================================================================

        showToast(message, options = {}) {
            this.toastMessage = message;
            this.toastVisible = true;
            if (this._toastTimer) clearTimeout(this._toastTimer);
            const duration = options.duration ?? 4000;
            this._toastTimer = setTimeout(() => { this.toastVisible = false; }, duration);
        },

        // --- Holidays Modal ---
        openHolidaysModal() {
            this.holidaysModalVisible = true;
        },

        closeHolidaysModal() {
            this.holidaysModalVisible = false;
        },

        // Group consecutive same-holiday/same-doctor scheduleData entries into
        // one row per holiday block (e.g. Memorial Day's Sat/Sun/Mon coverage
        // collapses to a single row). Thanksgiving A and B stay separate
        // because their holiday text differs.
        get holidayList() {
            const entries = Object.entries(this.scheduleData)
                .filter(([_, e]) => e && e.holiday)
                .sort((a, b) => a[0].localeCompare(b[0]));
            if (entries.length === 0) return [];

            const groups = [];
            let cur = null;
            for (const [dateStr, entry] of entries) {
                const doc = entry.callDoctor || '';
                const sameGroup = cur
                    && cur.holiday === entry.holiday
                    && cur.doctor === doc
                    && this._isNextDay(cur.lastDate, dateStr);
                if (sameGroup) {
                    cur.lastDate = dateStr;
                } else {
                    cur = {
                        holiday: entry.holiday,
                        doctor: doc,
                        firstDate: dateStr,
                        lastDate: dateStr,
                    };
                    groups.push(cur);
                }
            }

            const today = this.mockMode ? '2026-07-01' : getClinicToday();
            return groups.map((g, idx) => ({
                key: g.firstDate + '_' + idx,
                name: g.holiday,
                doctor: g.doctor,
                doctorLabel: g.doctor ? 'Dr. ' + g.doctor : 'Unassigned',
                dateLabel: this._formatHolidayRange(g.firstDate, g.lastDate),
                isMine: !!this.doctorName && g.doctor === this.doctorName,
                isPast: g.lastDate < today,
            }));
        },

        _isNextDay(prevDate, nextDate) {
            const p = new Date(prevDate + 'T12:00:00');
            p.setDate(p.getDate() + 1);
            return toISO(p) === nextDate;
        },

        _formatHolidayRange(firstDate, lastDate) {
            const opts = { weekday: 'short', month: 'short', day: 'numeric' };
            const first = new Date(firstDate + 'T12:00:00').toLocaleDateString('en-US', opts);
            if (firstDate === lastDate) return first;
            const last = new Date(lastDate + 'T12:00:00').toLocaleDateString('en-US', opts);
            return first + ' – ' + last;
        },

        // --- Helpers ---
        formatDate(dateStr) {
            const d = new Date(dateStr + 'T12:00:00');
            return d.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
            });
        },
    };
}
