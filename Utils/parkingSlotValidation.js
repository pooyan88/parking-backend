function validateParkingSlot(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Provide code in a JSON object' };
    }
    if (Object.keys(body).some(key => key !== 'code')) {
        return { error: 'Only code can be provided when creating a slot' };
    }
    if (typeof body.code !== 'string' || !body.code.trim()) {
        return { error: 'Slot code must be non-empty text' };
    }
    const code = body.code.trim();
    if ([...code].length > 255 || code.includes('\0')) {
        return { error: 'Slot code must be at most 255 characters, without null characters' };
    }
    return { code };
}

module.exports = { validateParkingSlot };
