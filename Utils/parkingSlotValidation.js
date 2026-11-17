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

const MAX_SLOT_RANGE_SIZE = 1000;

function validateParkingSlotCreation(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Provide code or start_code and end_code in a JSON object' };
    }
    const fields = Object.keys(body);
    const isRange = Object.hasOwn(body, 'start_code') || Object.hasOwn(body, 'end_code');
    if (!isRange) {
        const details = validateParkingSlot(body);
        return details.error ? details : { code: details.code, codes: [details.code], isRange: false };
    }
    if (fields.some(key => !['start_code', 'end_code'].includes(key))) {
        return { error: 'Provide only start_code and end_code for a slot range; do not combine them with code or other fields' };
    }
    const start = validateParkingSlot({ code: body.start_code });
    const end = validateParkingSlot({ code: body.end_code });
    if (start.error || end.error) {
        return { error: `Invalid ${start.error ? 'start_code' : 'end_code'}: ${(start.error || end.error)}` };
    }
    const startParts = /^([^\d]*)(\d+)$/u.exec(start.code);
    const endParts = /^([^\d]*)(\d+)$/u.exec(end.code);
    if (!startParts || !endParts) {
        return { error: 'Range codes must end in ASCII digits, with an optional prefix containing no digits' };
    }
    if (startParts[1] !== endParts[1]) {
        return { error: 'Range codes must have exactly the same prefix' };
    }
    const startDigits = startParts[2];
    const endDigits = endParts[2];
    const padded = (startDigits.length > 1 && startDigits.startsWith('0'))
        || (endDigits.length > 1 && endDigits.startsWith('0'));
    if (padded && startDigits.length !== endDigits.length) {
        return { error: 'Zero-padded range codes must use the same number of digits' };
    }
    // BigInt preserves long numeric codes without rounding or unsafe loop bounds.
    const first = BigInt(startDigits);
    const last = BigInt(endDigits);
    if (last < first) return { error: 'end_code must be greater than or equal to start_code' };
    const count = last - first + 1n;
    if (count > BigInt(MAX_SLOT_RANGE_SIZE)) {
        return { error: `A slot range can contain at most ${MAX_SLOT_RANGE_SIZE} slots` };
    }
    const codes = Array.from({ length: Number(count) }, (_, index) => {
        const digits = String(first + BigInt(index));
        return startParts[1] + (padded ? digits.padStart(startDigits.length, '0') : digits);
    });
    return { codes, isRange: true };
}

module.exports = { validateParkingSlot, validateParkingSlotCreation };
