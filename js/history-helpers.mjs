/**
 * Pure schedule-history helpers shared by the browser UI and Node tests.
 *
 * This module deliberately has no imports and does not perform any database or
 * DOM work. Firestore remains authoritative; these helpers only shape data
 * that has already been read by the viewer.
 */

const MIGRATION_LABEL =
    'Snapshot at migration — original publication unavailable';

function affectedChangeDates(changes) {
    const dates = new Set();
    for (const document of Array.isArray(changes) ? changes : []) {
        for (const change of Array.isArray(document?.changes)
            ? document.changes
            : []) {
            if (typeof change?.date === 'string' && change.date) {
                dates.add(change.date);
            }
        }
    }
    return [...dates].sort();
}

function canonicalRow(entry, date) {
    return {
        Date: date,
        Day: entry?.day ?? entry?.Day ?? '',
        Holiday: entry?.holiday ?? entry?.Holiday ?? '',
        Call_Doctor: entry?.callDoctor ?? entry?.Call_Doctor ?? '',
        Clinic_Doctor: entry?.clinicDoctor ?? entry?.Clinic_Doctor ?? '',
    };
}

function buildChangedRows(changes, scheduleEntries) {
    const affectedDates = affectedChangeDates(changes);
    const byDate = new Map();
    for (const entry of Array.isArray(scheduleEntries)
        ? scheduleEntries
        : []) {
        const date = entry?.date ?? entry?.Date;
        if (typeof date === 'string' && date && !byDate.has(date)) {
            byDate.set(date, entry);
        }
    }

    const missingDates = affectedDates.filter((date) => !byDate.has(date));
    if (missingDates.length) {
        return {
            ok: false,
            code: 'missing-affected-dates',
            message: 'Changes export aborted — the latest schedule state is '
                + 'missing ' + missingDates.length + ' affected date(s): '
                + missingDates.join(', ') + '.',
            rows: [],
            affectedDates,
            missingDates,
        };
    }

    return {
        ok: true,
        rows: affectedDates.map((date) => canonicalRow(byDate.get(date), date)),
        affectedDates,
        missingDates: [],
    };
}

function nextIsoDate(dateISO) {
    const date = new Date(dateISO + 'T00:00:00Z');
    if (Number.isNaN(date.getTime())) return null;
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}

function rangeDates(startDate, endDate) {
    const dates = [];
    let current = startDate;
    while (current && current <= endDate) {
        dates.push(current);
        current = nextIsoDate(current);
    }
    return dates;
}

function incompleteResult(code, message, entries, expectedCount) {
    return {
        ok: false,
        code,
        message,
        entries: [],
        expectedCount,
        actualCount: entries.length,
    };
}

function validateCompleteSchedule(entries, archive, snapshotKind) {
    const supplied = Array.isArray(entries) ? entries : [];
    const startDate = archive?.startDate;
    const endDate = archive?.endDate;
    const finalCount = archive?.finalDayCount;
    const baseCount = archive?.dayCount;
    const expectedCount = snapshotKind === 'final'
        && Number.isInteger(finalCount)
        && finalCount > 0
        ? finalCount
        : baseCount;

    if (typeof startDate !== 'string' || typeof endDate !== 'string'
            || !Number.isInteger(expectedCount) || expectedCount < 1) {
        return incompleteResult(
            'invalid-archive-metadata',
            'Download aborted — the archive range or day count is invalid.',
            supplied,
            expectedCount,
        );
    }

    const expectedDates = rangeDates(startDate, endDate);
    if (!expectedDates.length
            || expectedDates[0] !== startDate
            || expectedDates[expectedDates.length - 1] !== endDate
            || expectedDates.length !== expectedCount) {
        return incompleteResult(
            'archive-range-count-mismatch',
            'Download aborted — the archive range does not match its day count.',
            supplied,
            expectedCount,
        );
    }

    const sorted = supplied
        .map((entry) => ({ ...entry }))
        .sort((left, right) => String(left.date ?? left.Date ?? '')
            .localeCompare(String(right.date ?? right.Date ?? '')));
    const actualDates = sorted.map((entry) => entry.date ?? entry.Date);
    const exact = actualDates.length === expectedDates.length
        && actualDates.every((date, index) => date === expectedDates[index]);
    if (!exact) {
        return incompleteResult(
            'incomplete-schedule',
            'Download aborted — fetched ' + actualDates.length + '/'
                + expectedCount + ' days, but the archive requires the exact '
                + startDate + '…' + endDate + ' range. Do not send a partial file.',
            supplied,
            expectedCount,
        );
    }

    return {
        ok: true,
        entries: sorted,
        expectedCount,
        actualCount: sorted.length,
    };
}

function snapshotDownloadInfo(archive, activeArchiveId, target) {
    const archiveId = archive?.id;
    const startDate = archive?.startDate;
    const endDate = archive?.endDate;
    if (!archiveId || !startDate || !endDate) {
        return {
            ok: false,
            code: 'invalid-archive-metadata',
            message: 'Download unavailable — archive metadata is incomplete.',
        };
    }

    const isActive = archiveId === activeArchiveId;
    const knownTarget = ['original', 'current', 'final'].includes(target);
    if (!knownTarget) {
        return {
            ok: false,
            code: 'invalid-snapshot-target',
            message: 'Download unavailable — unknown archive snapshot.',
        };
    }
    if (target === 'current' && !isActive) {
        return {
            ok: false,
            code: 'archive-not-active',
            message: 'Current download is available only for the active schedule.',
        };
    }
    if (target === 'final' && isActive) {
        return {
            ok: false,
            code: 'archive-not-finalized',
            message: 'Final download is available only after a schedule is completed.',
        };
    }

    let suffix;
    let label;
    let dataSource;
    if (target === 'original' && archive.source === 'migration') {
        suffix = 'MIGRATED';
        label = MIGRATION_LABEL;
        dataSource = 'original';
    } else if (target === 'original') {
        suffix = 'ORIGINAL';
        label = 'Original published schedule';
        dataSource = 'original';
    } else if (target === 'current') {
        suffix = 'CURRENT';
        label = 'Current schedule';
        dataSource = 'live';
    } else {
        suffix = 'FINAL';
        label = 'Final schedule';
        dataSource = 'final';
    }

    return {
        ok: true,
        target,
        dataSource,
        filename: 'Schedule_' + startDate + '_' + endDate + '_'
            + suffix + '.csv',
        label,
        suffix,
    };
}

function isFullyPastShift(shift, todayISO) {
    const dates = Array.isArray(shift) ? shift : shift?.dates;
    return Array.isArray(dates)
        && dates.length > 0
        && typeof todayISO === 'string'
        && dates.every((date) => typeof date === 'string' && date < todayISO);
}

function dateFromTimestamp(value) {
    if (value instanceof Date) return value;
    if (value && typeof value.toDate === 'function') return value.toDate();
    return new Date(value);
}

function actionLabel(change) {
    const shift = change?.shiftType === 'weekend-block'
        ? 'Weekend call'
        : change?.shiftType === 'saturday-clinic'
            ? 'Saturday clinic'
            : 'Call';
    const action = change?.kind === 'swap' ? 'swap' : 'reassignment';
    return shift + ' ' + action;
}

function formatTimelineItems(changes, timeZone = 'America/Chicago') {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
    const sorted = [...(Array.isArray(changes) ? changes : [])].sort(
        (left, right) => (
            dateFromTimestamp(left?.editedAt).getTime()
            - dateFromTimestamp(right?.editedAt).getTime()
            || String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
        )
    );

    return sorted.map((change, index) => {
        const seen = new Set();
        const transitions = [];
        for (const entry of Array.isArray(change?.changes)
            ? change.changes
            : []) {
            const before = String(entry?.before ?? '');
            const after = String(entry?.after ?? '');
            const key = before + '\u0000' + after;
            if (seen.has(key)) continue;
            seen.add(key);
            transitions.push({
                before,
                after,
                text: before + ' → ' + after,
            });
        }
        const editedAt = dateFromTimestamp(change?.editedAt);
        const dateLabel = Number.isNaN(editedAt.getTime())
            ? 'Unknown time'
            : formatter.format(editedAt);
        return {
            id: change?.id ?? 'change-' + index,
            title: dateLabel + ' — ' + actionLabel(change),
            transitions,
            change,
        };
    });
}

export {
    MIGRATION_LABEL,
    affectedChangeDates,
    buildChangedRows,
    formatTimelineItems,
    isFullyPastShift,
    snapshotDownloadInfo,
    validateCompleteSchedule,
};
