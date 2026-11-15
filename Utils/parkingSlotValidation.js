function validateParkingSlot(body, { partial = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: partial ? 'Provide slot updates in a JSON object' : 'Provide code in a JSON object' };
    }
    const allowed = partial ? ['code', 'operational_status', 'maintenance_note'] : ['code'];
    const fields = Object.keys(body);
    if (fields.some(key => !allowed.includes(key))) {
        return { error: partial ? 'Only code, operational_status, and maintenance_note can be updated'
            : 'Only code can be provided when creating a slot' };
    }
    if (partial && fields.length === 0) {
        return { error: 'Provide code, operational_status, maintenance_note, or a combination' };
    }
    const hasCode = Object.hasOwn(body, 'code');
    if ((!partial || hasCode) && (typeof body.code !== 'string' || !body.code.trim())) {
        return { error: 'Slot code must be non-empty text' };
    }
    const code = hasCode ? body.code.trim() : undefined;
    if (code !== undefined && ([...code].length > 255 || code.includes('\0'))) {
        return { error: 'Slot code must be at most 255 characters, without null characters' };
    }
    const hasStatus = Object.hasOwn(body, 'operational_status');
    if (hasStatus && !['usable', 'maintenance'].includes(body.operational_status)) {
        return { error: 'Operational status must be usable or maintenance' };
    }
    const hasMaintenanceNote = Object.hasOwn(body, 'maintenance_note');
    const note = body.maintenance_note;
    if (hasMaintenanceNote && note !== null && (
        typeof note !== 'string' || !note.trim() || [...note.trim()].length > 1000 || note.includes('\0')
    )) {
        return { error: 'Maintenance note must be null or non-empty text up to 1000 characters, without null characters' };
    }
    return { code, operationalStatus: hasStatus ? body.operational_status : undefined,
        hasMaintenanceNote, maintenanceNote: hasMaintenanceNote && note !== null ? note.trim() : null };
}

module.exports = { validateParkingSlot };
