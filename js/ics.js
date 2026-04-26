/**
 * Personal ICS builder for the schedule viewer.
 *
 * Pure module: no DOM, Firebase, or Alpine dependencies. Keep this portable so
 * the same event conventions can be reused if we later add subscription feeds.
 */

const TZID = 'America/Chicago';

/**
 * Build a personal .ics file for one doctor.
 *
 * @param {Array<object>} entries Schedule docs from getScheduleRange.
 * @param {string} doctorName Doctor name as stored in /doctors/{name}.
 * @returns {string} Complete .ics file content.
 */
export function buildPersonalICS(entries, doctorName) {
    const eventLines = [];
    const dtstamp = dtstampUTC();

    for (const entry of entries) {
        if (entry.callDoctor === doctorName && entry.callDoctor !== 'ERROR') {
            eventLines.push(...buildCallEvent(entry, doctorName, dtstamp));
        }

        if (entry.clinicDoctor === doctorName &&
            entry.clinicDoctor !== 'Closed' &&
            entry.clinicDoctor !== '') {
            eventLines.push(...buildClinicEvent(entry, doctorName, dtstamp));
        }
    }

    return wrapCalendar(eventLines);
}

function buildCallEvent(entry, doctor, dtstamp) {
    const dt = entry.date;
    const next = isoAddDays(dt, 1);
    let summary = 'On Call';
    if (entry.holiday) summary += ` (${entry.holiday})`;

    return [
        'BEGIN:VEVENT',
        `UID:${icsEscape(`${dt}-CALL-${doctor}@medisched`)}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=${TZID}:${formatLocal(dt, 17, 0)}`,
        `DTEND;TZID=${TZID}:${formatLocal(next, 8, 0)}`,
        `SUMMARY:${icsEscape(summary)}`,
        'DESCRIPTION:On-call coverage from 5:00 PM to 8:00 AM',
        'END:VEVENT',
    ];
}

function buildClinicEvent(entry, doctor, dtstamp) {
    const dt = entry.date;

    return [
        'BEGIN:VEVENT',
        `UID:${icsEscape(`${dt}-CLINIC-${doctor}@medisched`)}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=${TZID}:${formatLocal(dt, 8, 30)}`,
        `DTEND;TZID=${TZID}:${formatLocal(dt, 12, 0)}`,
        'SUMMARY:Saturday Clinic',
        'DESCRIPTION:Saturday clinic coverage from 8:30 AM to 12:00 PM',
        'END:VEVENT',
    ];
}

function wrapCalendar(eventLines) {
    const head = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//MediSched//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:WFP On-Call',
        `X-WR-TIMEZONE:${TZID}`,
        'BEGIN:VTIMEZONE',
        `TZID:${TZID}`,
        'BEGIN:DAYLIGHT',
        'TZOFFSETFROM:-0600',
        'TZOFFSETTO:-0500',
        'TZNAME:CDT',
        'DTSTART:19700308T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
        'END:DAYLIGHT',
        'BEGIN:STANDARD',
        'TZOFFSETFROM:-0500',
        'TZOFFSETTO:-0600',
        'TZNAME:CST',
        'DTSTART:19701101T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
        'END:STANDARD',
        'END:VTIMEZONE',
    ];

    return foldCalendarLines([...head, ...eventLines, 'END:VCALENDAR']).join('\r\n') + '\r\n';
}

function icsEscape(s) {
    return String(s ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
}

function foldCalendarLines(lines) {
    return lines.flatMap(foldLine);
}

// RFC 5545 content lines should be folded at 75 octets. Continuation lines
// start with one space, leaving 74 octets for their payload.
function foldLine(line) {
    const encoder = new TextEncoder();
    if (encoder.encode(line).length <= 75) return [line];

    const folded = [];
    let current = '';

    for (const ch of line) {
        const limit = folded.length === 0 ? 75 : 74;
        const candidate = current + ch;
        if (encoder.encode(candidate).length > limit) {
            folded.push(folded.length === 0 ? current : ' ' + current);
            current = ch;
        } else {
            current = candidate;
        }
    }

    if (current) {
        folded.push(folded.length === 0 ? current : ' ' + current);
    }
    return folded;
}

function isoAddDays(iso, n) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function formatLocal(iso, hour, minute) {
    return `${iso.replace(/-/g, '')}T${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}00`;
}

function dtstampUTC() {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${y}${m}${day}T${hh}${mm}${ss}Z`;
}
