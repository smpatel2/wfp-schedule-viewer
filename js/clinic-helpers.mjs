/**
 * Saturday clinic format helpers (pure module, no DOM/Firebase).
 *
 * From the 2027 schedule on, the weekend on-call doctor staffs Saturday
 * clinic alone. The scheduler records this as clinicDoctor === 'On-Call'
 * (config.CLINIC_ON_CALL_MARKER in the Python app) instead of a name.
 * Earlier schedules name a separate clinic doctor; both formats must render.
 */

export const CLINIC_ON_CALL = 'On-Call';

/** True when a clinicDoctor value means "the on-call doctor runs clinic". */
export function isClinicOnCall(value) {
    return typeof value === 'string'
        && value.trim().toLowerCase() === CLINIC_ON_CALL.toLowerCase();
}

/**
 * The doctor actually staffing a day's Saturday clinic: the call doctor
 * under the on-call format, otherwise the stored clinicDoctor value
 * (a name, 'Closed', or '').
 */
export function clinicDoctorFor(entry) {
    if (!entry) return '';
    return isClinicOnCall(entry.clinicDoctor)
        ? (entry.callDoctor || '')
        : (entry.clinicDoctor || '');
}
