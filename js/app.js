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
            window.db.onAuthChanged((user) => {
                if (user) {
                    const entry = alpine.doctors.find(d => d.email.toLowerCase() === user.email.toLowerCase());
                    if (entry) {
                        alpine.doctorName = entry.name;
                        alpine.authenticated = true;
                        sessionStorage.setItem('schedule_viewer_doctor', entry.name);
                        // Load today card first, then defer calendar to next frame
                        alpine.loadTodayData().then(() => {
                            setTimeout(() => alpine.loadScheduleAndInitCalendar(), 0);
                        });
                    }
                } else {
                    // Clean up on logout / auth loss
                    if (alpine.calendar) {
                        alpine.calendar.destroy();
                        alpine.calendar = null;
                    }
                    alpine.authenticated = false;
                    alpine.doctorName = '';
                    alpine.todayData = null;
                    alpine.scheduleMeta = null;
                    alpine.nextSaturdayData = null;
                    alpine.scheduleData = {};
                    alpine.cellHtmlCache = {};
                    sessionStorage.removeItem('schedule_viewer_doctor');
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
                if (!this.doctorName) {
                    this.loginError = 'Please select your name.';
                    return;
                }
                if (!this.password) {
                    this.loginError = 'Please enter the practice password.';
                    return;
                }

                const email = this.doctorEmailMap[this.doctorName];
                if (!email) {
                    this.loginError = 'Doctor not found. Contact the administrator.';
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
            return this.scheduleMeta.startDate > this.todayISO;
        },

        /** Clinic doctor text for the next Saturday */
        get clinicSaturdayText() {
            // If today is Saturday, use todayData
            if (this.todayData && this.todayData.day === 'Saturday') {
                return this.todayData.clinicDoctor || '';
            }
            // Otherwise use next Saturday data
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

        /** Formatted Saturday date for display (same format as todayDisplay) */
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

        // --- Calendar ---
        async loadScheduleAndInitCalendar() {
            if (!this.scheduleMeta) return;

            const todayISO = this.mockMode ? "2026-07-01" : getClinicToday();
            const calStart = startOfMonth(todayISO);

            // Don't init calendar if schedule is entirely in the past
            if (this.scheduleMeta.endDate < todayISO) {
                return;
            }

            const rangeStart = calStart > this.scheduleMeta.startDate ? calStart : this.scheduleMeta.startDate;
            const rangeEnd = this.scheduleMeta.endDate;

            try {
                const entries = await window.db.getScheduleRange(rangeStart, rangeEnd);
                this.scheduleData = {};
                for (const entry of entries) {
                    this.scheduleData[entry.date] = entry;
                }
                this.buildCellHtmlCache();
                await this.initCalendar();
            } catch (e) {
                console.error("[Schedule] Failed to load schedule data:", e);
            }
        },

        buildCellHtmlCache() {
            this.cellHtmlCache = {};
            for (const [dateStr, entry] of Object.entries(this.scheduleData)) {
                let html = '';

                // Holiday pill
                if (entry.holiday) {
                    const shortName = this.holidayShortNames[entry.holiday] || entry.holiday;
                    html += `<div class="holiday-pill">${shortName}</div>`;
                }

                // Call doctor pill
                if (entry.callDoctor) {
                    const cls = this.getDoctorColorClass(entry.callDoctor);
                    html += `<div class="doctor-name-pill ${cls}">${entry.callDoctor}</div>`;
                }

                // Clinic doctor (Saturdays only, skip "Closed")
                if (entry.clinicDoctor && entry.clinicDoctor !== 'Closed' && entry.clinicDoctor !== '') {
                    const cls = this.getDoctorColorClass(entry.clinicDoctor);
                    html += `<div class="clinic-doctor-pill ${cls}"><span class="clinic-label">Clinic: </span>${entry.clinicDoctor}</div>`;
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
