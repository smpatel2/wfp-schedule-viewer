/**
 * Independent backup overlay. Backup call is low stakes, so a published
 * backup stays visible through later primary swaps. The only per-day check
 * is that the backup doctor is not also the current primary that day.
 */
export function attachBackups(entries, backup) {
    return entries.map(entry => {
        const assignment = backup?.assignments?.[entry.date];
        const valid = Boolean(assignment && assignment.backupDoctor
            && assignment.backupDoctor !== entry.callDoctor);
        return { ...entry, backupDoctor: valid ? assignment.backupDoctor : null,
            backupStatus: !backup ? 'missing' : valid ? 'current'
                : assignment ? 'conflict' : 'not-covered' };
    });
}
