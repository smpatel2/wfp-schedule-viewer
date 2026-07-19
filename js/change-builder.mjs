/**
 * Pure builders for permanent schedule-viewer change records.
 *
 * There are deliberately no imports in this module. Browser Firebase code and
 * Node tests can both use the same validation and document-building behavior.
 *
 * Public builders accept one object containing:
 *   archiveId, changeId, editedBy, editedAt, payload, scheduleByDate
 *
 * liveUpdates is returned as an object keyed by ISO date. Keys are inserted in
 * deterministic date order. Each value is the exact update payload for that
 * live schedule document.
 */

const SHIFT_TYPES = new Set([
    'single-call',
    'weekend-block',
    'saturday-clinic',
]);
const CLOSED_DOCTORS = new Set(['', 'Closed', 'ERROR']);
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MAX_DOCTOR_LENGTH = 64;
const MAX_EDITOR_LENGTH = 256;

class SameDayConflictError extends Error {
    constructor(conflicts) {
        const dates = conflicts.map((conflict) => conflict.date).join(', ');
        super('The incoming doctor already has the other role on: ' + dates);
        this.name = 'SameDayConflictError';
        this.code = 'same-day-conflict';
        this.conflicts = conflicts.map((conflict) => ({ ...conflict }));
    }
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function requireRecord(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(label + ' must be an object.');
    }
}

function requireString(value, label, maxLength) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(label + ' is required.');
    }
    const normalized = value.trim();
    if (maxLength && normalized.length > maxLength) {
        throw new Error(label + ' is too long.');
    }
    return normalized;
}

function requireExactKeys(value, allowedKeys, label) {
    const unknown = Object.keys(value).filter(
        (key) => !allowedKeys.has(key)
    );
    if (unknown.length) {
        throw new Error(
            label + ' contains unsupported field(s): ' + unknown.sort().join(', ')
        );
    }
}

function requireDoctor(value, label) {
    const doctor = requireString(value, label, MAX_DOCTOR_LENGTH);
    if (CLOSED_DOCTORS.has(doctor)) {
        throw new Error(label + ' must be an assigned doctor.');
    }
    return doctor;
}

function parseIsoDate(value, label) {
    if (typeof value !== 'string') {
        throw new Error(label + ' must be a valid ISO date.');
    }
    const match = ISO_DATE.exec(value);
    if (!match) {
        throw new Error(label + ' must be a valid ISO date.');
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year
            || parsed.getUTCMonth() !== month - 1
            || parsed.getUTCDate() !== day) {
        throw new Error(label + ' must be a valid ISO date.');
    }
    return parsed;
}

function normalizeDates(value, label) {
    if (!Array.isArray(value)) {
        throw new Error(label + ' are required.');
    }
    const dates = value.map((date, index) => {
        parseIsoDate(date, label + '[' + index + ']');
        return date;
    });
    if (new Set(dates).size !== dates.length) {
        throw new Error(label + ' cannot contain duplicates.');
    }
    return [...dates].sort();
}

function nextIsoDate(value) {
    const parsed = parseIsoDate(value, 'Weekend date');
    parsed.setUTCDate(parsed.getUTCDate() + 1);
    return parsed.toISOString().slice(0, 10);
}

function requireWeekendBlock(dates, label) {
    if (dates.length !== 3) {
        throw new Error(label + ' must cover exactly three dates.');
    }
    const first = parseIsoDate(dates[0], label + '[0]');
    const second = parseIsoDate(dates[1], label + '[1]');
    const third = parseIsoDate(dates[2], label + '[2]');
    if (first.getUTCDay() !== 5
            || second.getUTCDay() !== 6
            || third.getUTCDay() !== 0
            || nextIsoDate(dates[0]) !== dates[1]
            || nextIsoDate(dates[1]) !== dates[2]) {
        throw new Error(
            label + ' must be a consecutive Friday-Sunday block.'
        );
    }
}

function normalizeAllowConflict(payload) {
    if (hasOwn(payload, 'allowSameDayConflict')
            && typeof payload.allowSameDayConflict !== 'boolean') {
        throw new Error('allowSameDayConflict must be a boolean.');
    }
    return payload.allowSameDayConflict === true;
}

function validateContext(input) {
    requireRecord(input, 'Builder input');
    const archiveId = requireString(input.archiveId, 'archiveId');
    const changeId = requireString(input.changeId, 'changeId');
    const editedBy = requireString(
        input.editedBy, 'editedBy', MAX_EDITOR_LENGTH
    );
    if (input.editedAt === undefined || input.editedAt === null) {
        throw new Error('editedAt is required.');
    }
    requireRecord(input.scheduleByDate, 'scheduleByDate');
    return {
        archiveId,
        changeId,
        editedBy,
        editedAt: input.editedAt,
        scheduleByDate: input.scheduleByDate,
    };
}

function validateShiftType(value) {
    if (!SHIFT_TYPES.has(value)) {
        throw new Error('Invalid shift type.');
    }
    return value;
}

function normalizeReassignPayload(payload) {
    requireRecord(payload, 'Reassignment payload');
    requireExactKeys(
        payload,
        new Set([
            'shiftType',
            'dates',
            'fromDoctor',
            'toDoctor',
            'allowSameDayConflict',
        ]),
        'Reassignment payload'
    );
    const shiftType = validateShiftType(payload.shiftType);
    const dates = normalizeDates(payload.dates, 'Reassignment dates');
    const fromDoctor = requireDoctor(payload.fromDoctor, 'fromDoctor');
    const toDoctor = requireDoctor(payload.toDoctor, 'toDoctor');
    if (fromDoctor === toDoctor) {
        throw new Error('Cannot reassign a shift to the same doctor.');
    }

    if (shiftType === 'weekend-block') {
        requireWeekendBlock(dates, 'Weekend reassignment');
    } else if (dates.length !== 1) {
        throw new Error(
            'Single-shift reassignment must cover exactly one date.'
        );
    }

    return {
        shiftType,
        dates,
        fromDoctor,
        toDoctor,
        field: shiftType === 'saturday-clinic'
            ? 'clinicDoctor'
            : 'callDoctor',
        allowSameDayConflict: normalizeAllowConflict(payload),
    };
}

function normalizeSwapPayload(payload) {
    requireRecord(payload, 'Swap payload');
    requireExactKeys(
        payload,
        new Set([
            'shiftType',
            'datesA',
            'doctorA',
            'datesB',
            'doctorB',
            'allowSameDayConflict',
        ]),
        'Swap payload'
    );
    const shiftType = validateShiftType(payload.shiftType);
    const datesA = normalizeDates(payload.datesA, 'Swap datesA');
    const datesB = normalizeDates(payload.datesB, 'Swap datesB');
    const doctorA = requireDoctor(payload.doctorA, 'doctorA');
    const doctorB = requireDoctor(payload.doctorB, 'doctorB');
    if (doctorA === doctorB) {
        throw new Error('Cannot swap a doctor with themselves.');
    }

    if (shiftType === 'weekend-block') {
        requireWeekendBlock(datesA, 'First weekend selection');
        requireWeekendBlock(datesB, 'Second weekend selection');
    } else if (datesA.length !== 1 || datesB.length !== 1) {
        throw new Error(
            'Single-shift swaps must cover exactly one date on each side.'
        );
    }
    if (datesA.length !== datesB.length) {
        throw new Error(
            'Both sides of the swap must cover the same number of days.'
        );
    }

    const allDates = [...datesA, ...datesB];
    if (new Set(allDates).size !== allDates.length) {
        throw new Error(
            'Swap selections overlap or contain a duplicate date.'
        );
    }

    return {
        shiftType,
        datesA,
        datesB,
        doctorA,
        doctorB,
        field: shiftType === 'saturday-clinic'
            ? 'clinicDoctor'
            : 'callDoctor',
        allowSameDayConflict: normalizeAllowConflict(payload),
    };
}

function readAssignment(scheduleByDate, date) {
    if (!hasOwn(scheduleByDate, date)) {
        throw new Error(
            'No published schedule entry exists for ' + date + '.'
        );
    }
    const assignment = scheduleByDate[date];
    requireRecord(assignment, 'Schedule entry for ' + date);
    for (const field of ['callDoctor', 'clinicDoctor']) {
        if (typeof assignment[field] !== 'string') {
            throw new Error(
                'Schedule entry for ' + date + ' has an invalid ' + field + '.'
            );
        }
    }
    return assignment;
}

function sortChanges(changes) {
    return [...changes].sort((left, right) => (
        left.date.localeCompare(right.date)
        || left.field.localeCompare(right.field)
    ));
}

function buildResult(context, action, changes) {
    const sortedChanges = sortChanges(changes);
    const conflicts = [];
    const liveUpdates = {};

    for (const change of sortedChanges) {
        const assignment = readAssignment(
            context.scheduleByDate, change.date
        );
        const isCall = change.field === 'callDoctor';
        const otherField = isCall ? 'clinicDoctor' : 'callDoctor';
        if (assignment[otherField] === change.after) {
            conflicts.push({
                date: change.date,
                doctor: change.after,
                incomingRole: isCall ? 'call' : 'clinic',
                existingRole: isCall ? 'clinic' : 'call',
            });
        }

        liveUpdates[change.date] = {
            [change.field]: change.after,
            previousDoctor: change.before,
            lastEditBy: context.editedBy,
            lastEditAt: context.editedAt,
            lastEditType: action.kind,
            lastChangeId: context.changeId,
        };
    }

    conflicts.sort((left, right) => (
        left.date.localeCompare(right.date)
        || left.incomingRole.localeCompare(right.incomingRole)
    ));
    if (conflicts.length && !action.allowSameDayConflict) {
        throw new SameDayConflictError(conflicts);
    }

    return {
        changeDocument: {
            schemaVersion: 1,
            archiveId: context.archiveId,
            kind: action.kind,
            shiftType: action.shiftType,
            editedBy: context.editedBy,
            editedAt: context.editedAt,
            note: '',
            changes: sortedChanges.map((change) => ({ ...change })),
        },
        liveUpdates,
        conflicts: conflicts.map((conflict) => ({ ...conflict })),
    };
}

function buildReassignChange(input) {
    const context = validateContext(input);
    const payload = normalizeReassignPayload(input.payload);
    const changes = [];

    for (const date of payload.dates) {
        const assignment = readAssignment(context.scheduleByDate, date);
        const current = assignment[payload.field];
        if (current !== payload.fromDoctor) {
            throw new Error(
                'Schedule changed - ' + date + ' now shows Dr. '
                + (current || '(none)') + ', expected Dr. '
                + payload.fromDoctor + '.'
            );
        }
        changes.push({
            date,
            field: payload.field,
            before: current,
            after: payload.toDoctor,
        });
    }

    return buildResult(
        context,
        {
            kind: 'reassign',
            shiftType: payload.shiftType,
            allowSameDayConflict: payload.allowSameDayConflict,
        },
        changes
    );
}

function buildSwapChange(input) {
    const context = validateContext(input);
    const payload = normalizeSwapPayload(input.payload);
    const changes = [];

    for (const date of payload.datesA) {
        const assignment = readAssignment(context.scheduleByDate, date);
        const current = assignment[payload.field];
        if (current !== payload.doctorA) {
            throw new Error(
                'Schedule changed - ' + date + ' now shows Dr. '
                + (current || '(none)') + ', expected Dr. '
                + payload.doctorA + '.'
            );
        }
        changes.push({
            date,
            field: payload.field,
            before: current,
            after: payload.doctorB,
        });
    }
    for (const date of payload.datesB) {
        const assignment = readAssignment(context.scheduleByDate, date);
        const current = assignment[payload.field];
        if (current !== payload.doctorB) {
            throw new Error(
                'Schedule changed - ' + date + ' now shows Dr. '
                + (current || '(none)') + ', expected Dr. '
                + payload.doctorB + '.'
            );
        }
        changes.push({
            date,
            field: payload.field,
            before: current,
            after: payload.doctorA,
        });
    }

    return buildResult(
        context,
        {
            kind: 'swap',
            shiftType: payload.shiftType,
            allowSameDayConflict: payload.allowSameDayConflict,
        },
        changes
    );
}

export {
    SameDayConflictError,
    buildReassignChange,
    buildSwapChange,
};
