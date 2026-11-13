/**
 * Practice schedule .xlsx builder for the schedule viewer.
 *
 * Two parts, so the layout rules can be tested in plain Node:
 *   buildWorkbookModel()  pure; describes every sheet as plain data
 *   writeWorkbook()       thin; applies that description to ExcelJS
 *
 * The month sheets mirror exporters/excel_exporter.py in the scheduler app.
 * If the calendar-grid layout changes here, change it there too.
 */

import { clinicDoctorFor } from './clinic-helpers.mjs';

export const EXCELJS_URL =
    'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';

export const ALL_DAYS_SHEET = 'All Days';

/** Pastel (fill, font) pairs. Mirrors config.DOC_COLORS in the scheduler. */
const DOC_COLORS = [
    ['FFE3F2FD', 'FF1565C0'], ['FFE8F5E9', 'FF2E7D32'], ['FFFFF3E0', 'FFEF6C00'],
    ['FFF3E5F5', 'FF6A1B9A'], ['FFFFEBEE', 'FFC62828'], ['FFE0F7FA', 'FF006064'],
    ['FFFFF8E1', 'FFFF6F00'], ['FFFCE4EC', 'FF880E4F'], ['FFF1F8E9', 'FF33691E'],
    ['FFE8EAF6', 'FF283593'],
];

const WHITE = 'FFFFFFFF';
const HEADER_BG = 'FFF0F2F6';
const HOLIDAY_BG = 'FFE0E0E0';
const EMPTY_BG = 'FFF9F9F9';
const CLOSED_FONT = 'FF999999';

const PRACTICE_HEADER = [
    ['Practice:', 'Family Medicine'],
    ['Location:', 'Wheaton 150 E. Willow'],
    ['Office Hours:', '8am to 5:00pm'],
    ['Hours of call:', '5:00pm to 8:00am'],
    ['Practice Manager:', ''],
    ['Contact:', ''],
];

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
    'Saturday',
];

const GRID_HEADER_ROW = 11;
const LIST_HEADER_ROW = 4;
const LIST_HEADERS = ['Date', 'Day', 'Holiday', 'Call', 'Clinic', 'Backup'];
const LIST_WIDTHS = [18, 13, 24, 16, 16, 16];
const BACKUP_UNAVAILABLE_NOTE = 'Backup schedule could not be loaded.';

// --- Style helpers (ExcelJS style objects) ---

function fill(argb) {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function borders() {
    const side = { style: 'thin', color: { argb: 'FF000000' } };
    return { top: side, bottom: side, left: side, right: side };
}

const STYLE = {
    title: () => ({
        font: { bold: true, size: 14 },
        alignment: { horizontal: 'left' },
    }),
    label: () => ({
        font: { bold: true },
        alignment: { horizontal: 'right' },
    }),
    value: () => ({ alignment: { horizontal: 'left' } }),
    gridHeader: () => ({
        font: { bold: true },
        alignment: { horizontal: 'center' },
        fill: fill(HEADER_BG),
        border: borders(),
    }),
    dayNumber: () => ({
        font: { bold: true, size: 10 },
        alignment: { horizontal: 'left', vertical: 'top' },
        fill: fill(WHITE),
        border: borders(),
    }),
    holiday: () => ({
        font: { bold: true, size: 9, color: { argb: 'FF000000' } },
        alignment: { horizontal: 'right' },
        fill: fill(HOLIDAY_BG),
        border: borders(),
    }),
    empty: () => ({ fill: fill(EMPTY_BG), border: borders() }),
    blank: () => ({ border: borders() }),
    blankWhite: () => ({ fill: fill(WHITE), border: borders() }),
    clinicClosed: () => ({
        font: { size: 9, color: { argb: CLOSED_FONT } },
        alignment: { horizontal: 'center' },
        border: borders(),
    }),
    doctor: ([bg, font]) => ({
        font: { bold: true, size: 11, color: { argb: font } },
        alignment: { horizontal: 'center', vertical: 'middle' },
        fill: fill(bg),
        border: borders(),
    }),
    listHeader: () => ({
        font: { bold: true },
        alignment: { horizontal: 'left' },
        fill: fill(HEADER_BG),
        border: borders(),
    }),
    listCell: () => ({
        alignment: { horizontal: 'left' },
        border: borders(),
    }),
    listDate: () => ({
        alignment: { horizontal: 'left' },
        border: borders(),
        numFmt: 'ddd m/d/yyyy',
    }),
    note: () => ({ font: { italic: true, size: 9 } }),
};

// --- Date helpers (UTC throughout, so the viewer's time zone never shifts a day) ---

function parseISO(iso) {
    const [year, month, day] = iso.split('-').map(Number);
    return { year, month, day };
}

function utcDate(iso) {
    const { year, month, day } = parseISO(iso);
    return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(year, month, day) {
    return year + '-' + String(month).padStart(2, '0') + '-'
        + String(day).padStart(2, '0');
}

/** Weeks of a month as rows of 7 day numbers, Sunday first, 0 = outside. */
export function sundayFirstMonthMatrix(year, month) {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const weeks = [];
    let week = new Array(firstDow).fill(0);
    for (let day = 1; day <= daysInMonth; day += 1) {
        week.push(day);
        if (week.length === 7) {
            weeks.push(week);
            week = [];
        }
    }
    if (week.length) {
        while (week.length < 7) week.push(0);
        weeks.push(week);
    }
    return weeks;
}

/** "Nov 12, 2026, 3:40 PM" in clinic (Chicago) time. */
export function formatDownloadedAt(date) {
    return date.toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

// --- Model building ---

function sortedDoctorNames(doctors) {
    return [...(doctors || [])]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(doc => doc.name)
        .filter(Boolean);
}

function doctorStyle(name, colorIndexByName) {
    const index = colorIndexByName.get(name);
    return index === undefined
        ? STYLE.blank()
        : STYLE.doctor(DOC_COLORS[index % DOC_COLORS.length]);
}

function buildMonthSheet(year, month, byDate, doctorNames, colorIndexByName,
        downloadedLabel) {
    const cells = [];
    const merges = [];
    const rowHeights = {};
    const put = (row, col, value, style) => {
        cells.push({ row, col, value, style });
    };

    put(1, 1, MONTH_NAMES[month - 1].toUpperCase() + ' ' + year, STYLE.title());
    PRACTICE_HEADER.forEach(([label, value], i) => {
        put(i + 2, 1, label, STYLE.label());
        put(i + 2, 2, value, STYLE.value());
    });
    put(8, 1, 'Downloaded:', STYLE.label());
    put(8, 2, downloadedLabel, STYLE.value());

    // Physicians: first six names in column E, the rest in column G.
    put(2, 5, 'Physicians', STYLE.title());
    doctorNames.forEach((name, i) => {
        const col = i < 6 ? 5 : 7;
        const row = 3 + (i < 6 ? i : i - 6);
        put(row, col, name, STYLE.value());
    });

    DAY_NAMES.forEach((name, i) => {
        put(GRID_HEADER_ROW, i + 1, name, STYLE.gridHeader());
    });

    let row = GRID_HEADER_ROW + 1;
    for (const week of sundayFirstMonthMatrix(year, month)) {
        rowHeights[row] = 20;
        rowHeights[row + 1] = 30;
        rowHeights[row + 2] = 30;

        week.forEach((dayNum, i) => {
            const col = i + 1;
            if (dayNum === 0) {
                put(row, col, '', STYLE.empty());
                put(row + 1, col, '', STYLE.empty());
                put(row + 2, col, '', STYLE.empty());
                merges.push({ top: row, left: col, bottom: row + 2, right: col });
                return;
            }

            const entry = byDate.get(isoDate(year, month, dayNum)) || {};

            if (entry.holiday) {
                put(row, col, dayNum + ' - ' + entry.holiday, STYLE.holiday());
            } else {
                put(row, col, dayNum, STYLE.dayNumber());
            }

            const callDoctor = entry.callDoctor || '';
            if (callDoctor && callDoctor !== 'ERROR') {
                put(row + 1, col, callDoctor,
                    doctorStyle(callDoctor, colorIndexByName));
            } else {
                put(row + 1, col, '', STYLE.blank());
            }

            if (i !== 6) {
                put(row + 2, col, '', STYLE.blankWhite());
                return;
            }
            // Saturday clinic. clinicDoctorFor() turns the "On-Call" marker
            // (2027+ format) into the call doctor's name.
            const clinicDoctor = clinicDoctorFor(entry);
            if (clinicDoctor === 'Closed') {
                put(row + 2, col, 'Clinic Closed', STYLE.clinicClosed());
            } else if (clinicDoctor) {
                put(row + 2, col, 'Clinic: ' + clinicDoctor,
                    doctorStyle(clinicDoctor, colorIndexByName));
            } else {
                put(row + 2, col, '', STYLE.blank());
            }
        });
        row += 3;
    }

    return {
        name: MONTH_NAMES[month - 1].slice(0, 3) + ' ' + year,
        columnWidths: new Array(7).fill(18),
        rowHeights,
        merges,
        cells,
        pageSetup: {
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 1,
        },
    };
}

function buildAllDaysSheet(entries, downloadedLabel) {
    const cells = [];
    const put = (row, col, value, style) => {
        cells.push({ row, col, value, style });
    };

    put(1, 1, 'ALL DAYS', STYLE.title());
    put(2, 1, 'Downloaded:', STYLE.label());
    put(2, 2, downloadedLabel, STYLE.value());
    if (entries.some(entry => entry.backupStatus === 'unavailable')) {
        put(3, 1, BACKUP_UNAVAILABLE_NOTE, STYLE.note());
    }

    LIST_HEADERS.forEach((header, i) => {
        put(LIST_HEADER_ROW, i + 1, header, STYLE.listHeader());
    });

    entries.forEach((entry, i) => {
        const row = LIST_HEADER_ROW + 1 + i;
        const date = utcDate(entry.date);
        const dow = date.getUTCDay();
        const callDoctor = entry.callDoctor === 'ERROR'
            ? '' : (entry.callDoctor || '');
        put(row, 1, date, STYLE.listDate());
        put(row, 2, DAY_NAMES[dow], STYLE.listCell());
        put(row, 3, entry.holiday || '', STYLE.listCell());
        put(row, 4, callDoctor, STYLE.listCell());
        put(row, 5, dow === 6 ? clinicDoctorFor(entry) : '', STYLE.listCell());
        put(row, 6, entry.backupDoctor || '', STYLE.listCell());
    });

    const lastRow = LIST_HEADER_ROW + Math.max(entries.length, 1);
    return {
        name: ALL_DAYS_SHEET,
        columnWidths: LIST_WIDTHS,
        rowHeights: {},
        merges: [],
        cells,
        frozenRows: LIST_HEADER_ROW,
        autoFilter: {
            from: { row: LIST_HEADER_ROW, column: 1 },
            to: { row: lastRow, column: LIST_HEADERS.length },
        },
        pageSetup: {
            orientation: 'portrait',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            printTitlesRow: LIST_HEADER_ROW + ':' + LIST_HEADER_ROW,
        },
    };
}

/**
 * Describe the whole workbook as plain data. No ExcelJS, DOM, or Firebase.
 *
 * @param {Array<object>} entries  Schedule days ({date, holiday, callDoctor,
 *     clinicDoctor, backupDoctor, backupStatus}); any order.
 * @param {Array<object>} doctors  /doctors records ({name, order}).
 * @param {Date} downloadedAt      Moment of the download.
 * @returns {{sheets: Array<object>}}
 */
export function buildWorkbookModel(entries, doctors, downloadedAt) {
    const sorted = [...(entries || [])]
        .filter(entry => entry && typeof entry.date === 'string')
        .sort((a, b) => a.date.localeCompare(b.date));
    const doctorNames = sortedDoctorNames(doctors);
    const colorIndexByName = new Map(doctorNames.map((name, i) => [name, i]));
    const downloadedLabel = formatDownloadedAt(downloadedAt);

    const byDate = new Map(sorted.map(entry => [entry.date, entry]));
    const monthKeys = [...new Set(sorted.map(entry => entry.date.slice(0, 7)))];

    const sheets = monthKeys.map(key => {
        const { year, month } = parseISO(key + '-01');
        return buildMonthSheet(year, month, byDate, doctorNames,
            colorIndexByName, downloadedLabel);
    });
    sheets.push(buildAllDaysSheet(sorted, downloadedLabel));
    return { sheets };
}

// --- ExcelJS writer ---

const XLSX_MIME =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Apply a workbook model to ExcelJS and return the file as an ArrayBuffer. */
export async function writeWorkbook(model, ExcelJS) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MediSched';
    workbook.created = new Date();

    for (const sheet of model.sheets) {
        const ws = workbook.addWorksheet(sheet.name, {
            pageSetup: sheet.pageSetup,
            views: sheet.frozenRows
                ? [{ state: 'frozen', ySplit: sheet.frozenRows }]
                : undefined,
        });
        sheet.columnWidths.forEach((width, i) => {
            ws.getColumn(i + 1).width = width;
        });
        for (const [row, height] of Object.entries(sheet.rowHeights)) {
            ws.getRow(Number(row)).height = height;
        }
        for (const { row, col, value, style } of sheet.cells) {
            const cell = ws.getCell(row, col);
            if (value !== '' && value !== null && value !== undefined) {
                cell.value = value;
            }
            if (style.font) cell.font = style.font;
            if (style.alignment) cell.alignment = style.alignment;
            if (style.fill) cell.fill = style.fill;
            if (style.border) cell.border = style.border;
            if (style.numFmt) cell.numFmt = style.numFmt;
        }
        for (const { top, left, bottom, right } of sheet.merges) {
            ws.mergeCells(top, left, bottom, right);
        }
        if (sheet.autoFilter) ws.autoFilter = sheet.autoFilter;
    }
    return workbook.xlsx.writeBuffer();
}

/** Load ExcelJS from the CDN on first use (browser only). */
export function loadExcelJS() {
    if (globalThis.ExcelJS) return Promise.resolve(globalThis.ExcelJS);
    return new Promise((resolve, reject) => {
        const failed = () => reject(new Error(
            'Could not load the Excel library. Check your connection and try again.'
        ));
        const script = document.createElement('script');
        script.src = EXCELJS_URL;
        script.crossOrigin = 'anonymous';
        script.onload = () => (globalThis.ExcelJS
            ? resolve(globalThis.ExcelJS) : failed());
        script.onerror = () => {
            script.remove();
            failed();
        };
        document.head.appendChild(script);
    });
}

/** Build the practice schedule workbook and return it as a Blob. */
export async function buildPracticeXlsx(entries, doctors, downloadedAt) {
    const ExcelJS = await loadExcelJS();
    const model = buildWorkbookModel(entries, doctors, downloadedAt);
    const buffer = await writeWorkbook(model, ExcelJS);
    return new Blob([buffer], { type: XLSX_MIME });
}
