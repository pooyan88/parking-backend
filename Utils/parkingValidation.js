function validateParkingDetails({ name, location }, { partial = false } = {}) {
    const fields = partial
        ? [name, location].filter(value => value !== undefined)
        : [name, location];

    if (fields.length === 0 || fields.some(value => typeof value !== 'string' || !value.trim())) {
        return { error: 'Name and location are required and must be non-empty strings' };
    }

    const trimmed = fields.map(value => value.trim());
    if (trimmed.some(value => [...value].length > 255)) {
        return { error: 'Name and location must be at most 255 characters' };
    }

    if (trimmed.some(value => value.includes('\0'))) {
        return { error: 'Name and location must not contain null characters' };
    }

    // In a partial update, null marks an omitted field for SQL COALESCE.
    // A client-supplied null is rejected by validation above.
    return { name: name === undefined ? null : name.trim(),
        location: location === undefined ? null : location.trim() };
}

module.exports = { validateParkingDetails };
